/**
 * HITH — Telegram + WhatsApp (Meta) unified bot (Render-ready)
 *
 * FIX MEMORY:
 * ✅ Supabase permanent memory
 * ✅ Conversation history survives Render restart/redeploy
 * ✅ Memory facts saved when user says remember / ricordati / merke dir
 * ✅ Telegram + WhatsApp unified memory logic
 */

import express from "express";
import { Telegraf } from "telegraf";
import { createClient } from "@supabase/supabase-js";

// -------------------- ENV --------------------
const PORT = Number(process.env.PORT || 10000);

const PUBLIC_URL = String(process.env.PUBLIC_URL || "")
  .trim()
  .replace(/\/+$/, "");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID || "";
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || "";

// Supabase
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_KEY || "";

const SUPABASE_TABLE = process.env.SUPABASE_TABLE || "hith_prefs";
const SUPABASE_MEMORY_TABLE =
  process.env.SUPABASE_MEMORY_TABLE || "hith_memory";

// -------------------- CONSTANTS --------------------
const TG_PATH = "/tg-webhook";
const WA_PATH = "/whatsapp/webhook";

const FRIEND_MODE_LOCKED = true;

// -------------------- SAFE FETCH --------------------
async function safeFetch(url, options) {
  if (typeof fetch !== "undefined") return fetch(url, options);
  const mod = await import("node-fetch");
  return mod.default(url, options);
}

// -------------------- APP --------------------
const app = express();
app.use(express.json({ limit: "2mb" }));

app.use((req, res, next) => {
  if (req.path === TG_PATH || req.path === WA_PATH) {
    console.log("📥 INCOMING", req.method, req.path);
  }
  next();
});

// -------------------- EMOJI --------------------
const EMOJI = {
  en: ["🙂", "✨", "🤍", "🫶"],
  it: ["🙂", "✨", "🤍", "🫶"],
  de: ["🙂", "✨", "🤍", "🫶"],
};

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function addEmoji(lang, text) {
  const l = (lang || "en").toLowerCase();
  const e = EMOJI[l] || EMOJI.en;
  if (!text) return text;

  const t = String(text).trim();
  if (/[🙂✨🤍🫶]$/.test(t)) return t;

  return `${t} ${pick(e)}`;
}

// -------------------- SUPABASE --------------------
let supa = null;

async function initSupabase() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.log("ℹ️ Supabase disabled: missing SUPABASE_URL or key");
    return false;
  }

  try {
    supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
      auth: { persistSession: false },
    });

    const { error: prefsError } = await supa
      .from(SUPABASE_TABLE)
      .select("*")
      .limit(1);

    if (prefsError) {
      console.log("⚠️ Supabase prefs table issue:", prefsError.message);
    }

    const { error: memoryError } = await supa
      .from(SUPABASE_MEMORY_TABLE)
      .select("*")
      .limit(1);

    if (memoryError) {
      console.log("⚠️ Supabase memory table issue:", memoryError.message);
    }

    console.log("✅ Supabase connected");
    return true;
  } catch (e) {
    console.log("⚠️ Supabase not ready:", e?.message || e);
    supa = null;
    return false;
  }
}

// -------------------- PREFS --------------------
async function getPrefs(platform, userId) {
  const base = { lang: null, friendMode: true };
  if (!supa) return base;

  try {
    const { data, error } = await supa
      .from(SUPABASE_TABLE)
      .select("*")
      .eq("platform", platform)
      .eq("user_id", String(userId))
      .maybeSingle();

    if (error || !data) return base;

    return {
      lang: data.lang || null,
      friendMode: FRIEND_MODE_LOCKED ? true : data.friend_mode ?? true,
    };
  } catch {
    return base;
  }
}

async function setPrefs(platform, userId, patch = {}) {
  if (!supa || !userId) return false;

  const payload = {
    platform,
    user_id: String(userId),
    lang: patch.lang ?? null,
    friend_mode: FRIEND_MODE_LOCKED ? true : patch.friendMode ?? true,
    updated_at: new Date().toISOString(),
  };

  try {
    const { error } = await supa.from(SUPABASE_TABLE).upsert(payload, {
      onConflict: "platform,user_id",
    });

    if (error) {
      console.log("⚠️ setPrefs error:", error.message);
      return false;
    }

    return true;
  } catch (e) {
    console.log("⚠️ setPrefs crash:", e?.message || e);
    return false;
  }
}

// -------------------- MEMORY FIX --------------------
const MEMORY_FALLBACK = new Map();

function memoryFallbackKey(platform, userId) {
  return `${platform}:${userId}`;
}

async function saveMemoryItem({
  platform,
  userId,
  type = "message",
  role = null,
  content,
  metadata = {},
}) {
  if (!userId || !content) return false;

  const clean = String(content).trim();
  if (!clean) return false;

  const payload = {
    platform,
    user_id: String(userId),
    type,
    role,
    content: clean,
    metadata,
    created_at: new Date().toISOString(),
  };

  if (supa) {
    try {
      const { error } = await supa.from(SUPABASE_MEMORY_TABLE).insert(payload);

      if (!error) return true;

      console.log("⚠️ saveMemoryItem Supabase error:", error.message);
    } catch (e) {
      console.log("⚠️ saveMemoryItem crash:", e?.message || e);
    }
  }

  const k = memoryFallbackKey(platform, userId);
  const arr = MEMORY_FALLBACK.get(k) || [];
  arr.push(payload);
  MEMORY_FALLBACK.set(k, arr.slice(-40));

  return false;
}

async function getConversationMemory(platform, userId, max = 12) {
  if (!userId) return [];

  if (supa) {
    try {
      const { data, error } = await supa
        .from(SUPABASE_MEMORY_TABLE)
        .select("role, content, created_at")
        .eq("platform", platform)
        .eq("user_id", String(userId))
        .eq("type", "message")
        .in("role", ["user", "assistant"])
        .order("created_at", { ascending: false })
        .limit(max);

      if (!error && data) {
        return data.reverse().map((r) => ({
          role: r.role,
          content: r.content,
        }));
      }

      if (error) console.log("⚠️ getConversationMemory error:", error.message);
    } catch (e) {
      console.log("⚠️ getConversationMemory crash:", e?.message || e);
    }
  }

  const arr = MEMORY_FALLBACK.get(memoryFallbackKey(platform, userId)) || [];
  return arr
    .filter((m) => m.type === "message" && ["user", "assistant"].includes(m.role))
    .slice(-max)
    .map((m) => ({
      role: m.role,
      content: m.content,
    }));
}

async function getFactMemory(platform, userId, max = 12) {
  if (!userId) return [];

  if (supa) {
    try {
      const { data, error } = await supa
        .from(SUPABASE_MEMORY_TABLE)
        .select("content, metadata, created_at")
        .eq("platform", platform)
        .eq("user_id", String(userId))
        .eq("type", "fact")
        .order("created_at", { ascending: false })
        .limit(max);

      if (!error && data) return data.reverse();

      if (error) console.log("⚠️ getFactMemory error:", error.message);
    } catch (e) {
      console.log("⚠️ getFactMemory crash:", e?.message || e);
    }
  }

  const arr = MEMORY_FALLBACK.get(memoryFallbackKey(platform, userId)) || [];
  return arr.filter((m) => m.type === "fact").slice(-max);
}

function extractExplicitMemoryRequest(text = "") {
  const clean = String(text || "").trim();
  const lower = clean.toLowerCase();

  const triggers = [
    "remember that",
    "remember this",
    "ricordati che",
    "ricorda che",
    "non dimenticare",
    "salva questo",
    "save this",
    "note that",
    "merke dir",
    "vergiss nicht",
  ];

  const matched = triggers.find((t) => lower.includes(t));
  if (!matched) return null;

  return clean;
}

async function maybeSaveFact(platform, userId, text) {
  const fact = extractExplicitMemoryRequest(text);
  if (!fact) return false;

  return saveMemoryItem({
    platform,
    userId,
    type: "fact",
    role: "user",
    content: fact,
    metadata: {
      source: "explicit_user_request",
    },
  });
}

async function saveUserMessage(platform, userId, text) {
  await saveMemoryItem({
    platform,
    userId,
    type: "message",
    role: "user",
    content: text,
  });

  await maybeSaveFact(platform, userId, text);
}

async function saveAssistantMessage(platform, userId, text) {
  await saveMemoryItem({
    platform,
    userId,
    type: "message",
    role: "assistant",
    content: text,
  });
}

// -------------------- LANGUAGE --------------------
function guessLangFromText(text = "") {
  const t = text.toLowerCase();

  if (/[äöüß]/.test(t)) return "de";
  if (/\b(und|nicht|ich|du|wir|danke|bitte|heute|was|wie|warum)\b/.test(t))
    return "de";

  if (
    /\b(ciao|grazie|perché|oggi|bene|allora|non|voglio|sono|devo|posso|come|cosa)\b/.test(
      t
    )
  )
    return "it";

  return "en";
}

// -------------------- CORE REPLY --------------------
async function generateReply({ userText, lang, platform, userId }) {
  const clean = String(userText || "").trim();

  if (!clean) {
    return {
      text: addEmoji(
        lang,
        lang === "it"
          ? "Sono qui. Scrivimi qualcosa e resto con te."
          : lang === "de"
          ? "Ich bin hier. Schreib mir etwas, und ich bleibe bei dir."
          : "I’m here. Say something and I’ll stay with you."
      ),
    };
  }

  const lower = clean.toLowerCase();

  if (
    lower === "what is your name?" ||
    lower === "what's your name?" ||
    lower === "chi sei?" ||
    lower === "wie heißt du?"
  ) {
    const t =
      lang === "it"
        ? "Sono HITH. Sono qui con te — come un amico calmo che ascolta davvero."
        : lang === "de"
        ? "Ich bin HITH. Ich bin hier — wie ein ruhiger Freund, der wirklich zuhört."
        : "I’m HITH. I’m here — like a calm friend who actually listens.";

    return { text: addEmoji(lang, t) };
  }

  if (!OPENAI_API_KEY) {
    const t =
      lang === "it"
        ? "Ti ascolto. Dimmi cosa hai in mente, e lo prendiamo con calma."
        : lang === "de"
        ? "Ich höre dir zu. Sag mir, was dich beschäftigt — wir nehmen es ruhig."
        : "I’m listening. Tell me what’s on your mind — we’ll take it slowly.";

    return { text: addEmoji(lang, t) };
  }

  const history = await getConversationMemory(platform, userId, 12);
  const facts = await getFactMemory(platform, userId, 12);

  const factsText =
    facts.length > 0
      ? facts.map((f, i) => `${i + 1}. ${f.content}`).join("\n")
      : "No saved long-term facts yet.";

  const system = `
You are HITH in FRIEND MODE. Friend mode is LOCKED ON.

Identity:
HITH is a private reflection companion created by RABE.
HITH is not a therapist, not a doctor, not a judge.
HITH is a calm, warm, intelligent presence.

Tone:
- Human
- Direct
- Warm
- Not clinical
- Not robotic
- No long lectures unless the user asks
- Emojis subtle, max 1 per message
- Ask a question only when it helps
- Do not repeat the same question again and again

Language:
Reply in ${lang}.

Long-term saved memory facts about this user:
${factsText}

Memory rules:
Use saved facts naturally when relevant.
Do not expose raw memory unless the user asks.
Do not pretend to remember things that are not in memory.
If the user explicitly asks you to remember something, acknowledge briefly.

Conversation:
Use recent conversation history to stay coherent.
`.trim();

  const body = {
    model: OPENAI_MODEL,
    messages: [
      { role: "system", content: system },
      ...history,
      { role: "user", content: clean },
    ],
    temperature: 0.8,
  };

  const resp = await safeFetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  const json = await resp.json();

  if (!resp.ok) {
    console.log("❌ OpenAI error:", json);
    return {
      text: addEmoji(
        lang,
        lang === "it"
          ? "Sono qui, ma ho avuto un piccolo problema tecnico. Riprova tra un momento."
          : lang === "de"
          ? "Ich bin hier, aber es gab gerade ein kleines technisches Problem. Versuch es gleich nochmal."
          : "I’m here, but I had a small technical problem. Try again in a moment."
      ),
    };
  }

  const out = json?.choices?.[0]?.message?.content?.trim();

  if (!out) {
    return {
      text: addEmoji(
        lang,
        lang === "it" ? "Sono qui." : lang === "de" ? "Ich bin hier." : "I’m here."
      ),
    };
  }

  return { text: addEmoji(lang, out) };
}

// -------------------- TELEGRAM --------------------
let bot = null;

function initTelegram() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.log("⚠️ Missing TELEGRAM_BOT_TOKEN. Telegram disabled.");
    return;
  }

  bot = new Telegraf(TELEGRAM_BOT_TOKEN);

  bot.start(async (ctx) => {
    const fromId = String(ctx.from?.id || "");
    const lang = "en";

    await setPrefs("tg", fromId, { lang, friendMode: true });

    await saveMemoryItem({
      platform: "telegram",
      userId: fromId,
      type: "profile",
      role: "system",
      content: "Telegram user profile saved.",
      metadata: {
        first_name: ctx.from?.first_name || null,
        username: ctx.from?.username || null,
      },
    });

    await ctx.reply(
      "HITH is here.\n\nA private space to speak freely, without judgment. 🤍"
    );
  });

  bot.on("text", async (ctx) => {
    try {
      const fromId = String(ctx.from?.id || "");
      const text = ctx.message?.text || "";

      const prefs = await getPrefs("tg", fromId);
      const lang = prefs.lang || guessLangFromText(text);

      await setPrefs("tg", fromId, { lang, friendMode: true });

      await saveUserMessage("telegram", fromId, text);

      const out = await generateReply({
        userText: text,
        lang,
        platform: "telegram",
        userId: fromId,
      });

      await saveAssistantMessage("telegram", fromId, out.text);

      await ctx.reply(out.text);
    } catch (e) {
      console.error("Telegram handler error:", e?.message || e);
      try {
        await ctx.reply("Something went quiet for a moment. Try again.");
      } catch {}
    }
  });

  app.post(TG_PATH, bot.webhookCallback(TG_PATH));
}

async function setupTelegramWebhook() {
  if (!bot) return;

  if (!PUBLIC_URL) {
    console.log("⚠️ Missing PUBLIC_URL, cannot set Telegram webhook.");
    return;
  }

  const url = `${PUBLIC_URL}${TG_PATH}`;

  try {
    await bot.telegram.setWebhook(url, { drop_pending_updates: true });
    console.log("✅ Telegram webhook set:", url);
  } catch (e) {
    console.log("⚠️ Telegram setWebhook failed:", e?.message || e);
  }
}

app.get("/tg-info", async (req, res) => {
  try {
    if (!bot) {
      return res.status(200).json({
        ok: false,
        error: "Telegram bot not initialized",
      });
    }

    const info = await bot.telegram.getWebhookInfo();
    return res.status(200).json({ ok: true, info });
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: e?.message || String(e),
    });
  }
});

// -------------------- WHATSAPP --------------------
app.get(WA_PATH, (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token && token === WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post(WA_PATH, async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;

    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const msg = value?.messages?.[0];
    if (!msg) return;

    const from = String(msg.from || "");
    const text = msg?.text?.body || "";

    if (!text) {
      await sendWhatsAppText(
        from,
        "HITH can read text messages for now. Write to me."
      );
      return;
    }

    const prefs = await getPrefs("wa", from);
    const lang = prefs.lang || guessLangFromText(text);

    await setPrefs("wa", from, { lang, friendMode: true });

    await saveUserMessage("whatsapp", from, text);

    const out = await generateReply({
      userText: text,
      lang,
      platform: "whatsapp",
      userId: from,
    });

    await saveAssistantMessage("whatsapp", from, out.text);

    await sendWhatsAppText(from, out.text);
  } catch (e) {
    console.error("WhatsApp webhook error:", e?.message || e);
  }
});

async function sendWhatsAppText(to, text) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID) {
    console.log(
      "⚠️ WhatsApp not configured: missing WHATSAPP_TOKEN / WHATSAPP_PHONE_ID"
    );
    return;
  }

  const url = `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  };

  const resp = await safeFetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const j = await resp.json();

  if (!resp.ok) {
    console.log("❌ WhatsApp send failed:", j);
  } else {
    console.log("✅ WhatsApp sent:", j?.messages?.[0]?.id || "ok");
  }
}

// -------------------- HEALTH / DEBUG --------------------
app.get("/", (req, res) => {
  res.status(200).send("HITH is alive ✅");
});

app.get("/debug", (req, res) => {
  res.json({
    ok: true,
    publicUrl: PUBLIC_URL,
    openai: {
      enabled: !!OPENAI_API_KEY,
      model: OPENAI_MODEL,
    },
    telegram: {
      enabled: !!TELEGRAM_BOT_TOKEN,
      path: TG_PATH,
      webhook: PUBLIC_URL ? `${PUBLIC_URL}${TG_PATH}` : null,
    },
    whatsapp: {
      enabled: !!(
        WHATSAPP_TOKEN &&
        WHATSAPP_PHONE_ID &&
        WHATSAPP_VERIFY_TOKEN
      ),
      path: WA_PATH,
      callback: PUBLIC_URL ? `${PUBLIC_URL}${WA_PATH}` : null,
    },
    supabase: {
      enabled: !!supa,
      prefsTable: SUPABASE_TABLE,
      memoryTable: SUPABASE_MEMORY_TABLE,
    },
  });
});

app.get("/memory-debug/:platform/:userId", async (req, res) => {
  const { platform, userId } = req.params;

  const messages = await getConversationMemory(platform, userId, 10);
  const facts = await getFactMemory(platform, userId, 10);

  res.json({
    ok: true,
    platform,
    userId,
    messages,
    facts,
  });
});

// -------------------- START --------------------
(async function start() {
  await initSupabase();
  initTelegram();

  app.listen(PORT, async () => {
    console.log(`🚀 Server listening on ${PORT}`);
    console.log("🌐 PUBLIC_URL base:", PUBLIC_URL || "(missing)");
    console.log("📌 Telegram webhook path:", TG_PATH);
    console.log("📌 WhatsApp webhook path:", WA_PATH);

    if (bot) await setupTelegramWebhook();
  });
})();

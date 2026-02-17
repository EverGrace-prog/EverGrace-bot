/**
 * HITH — Telegram + WhatsApp (Meta) unified bot (Render-ready)
 * ✅ ONE PUBLIC_URL (base only): https://your-service.onrender.com
 * ✅ Telegram webhook:  /tg-webhook
 * ✅ WhatsApp webhook:  /whatsapp/webhook   (GET verify + POST receive)
 *
 * ENV (Render → Environment):
 *   PUBLIC_URL              https://evergrace-bot.onrender.com
 *   TELEGRAM_BOT_TOKEN      <telegram token>
 *   OPENAI_API_KEY          <optional, but needed for AI replies>
 *
 *   WHATSAPP_TOKEN          <Meta access token>
 *   WHATSAPP_PHONE_ID       <WhatsApp phone number id>
 *   WHATSAPP_VERIFY_TOKEN   <verify string used in Meta dashboard>
 *
 * Supabase (recommended for permanent memory + prefs):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE   (recommended) OR SUPABASE_KEY
 *   SUPABASE_TABLE          (default: hith_prefs)
 *   SUPABASE_MEMORY_TABLE   (default: hith_memory)
 */

import express from "express";
import { Telegraf } from "telegraf";
import { createClient } from "@supabase/supabase-js";

// -------------------- ENV --------------------
const PORT = Number(process.env.PORT || 10000);

const PUBLIC_URL = String(process.env.PUBLIC_URL || "")
  .trim()
  .replace(/\/+$/, ""); // base only, no trailing slash

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
const SUPABASE_MEMORY_TABLE = process.env.SUPABASE_MEMORY_TABLE || "hith_memory";

// -------------------- CONSTANTS --------------------
const TG_PATH = "/tg-webhook";
const WA_PATH = "/whatsapp/webhook";

// Friend mode LOCKED ✅
const FRIEND_MODE_LOCKED = true;

// -------------------- SAFE FETCH (Node 18+ has global fetch) --------------------
async function safeFetch(url, options) {
  if (typeof fetch !== "undefined") return fetch(url, options);
  const mod = await import("node-fetch");
  return mod.default(url, options);
}

// -------------------- APP --------------------
const app = express();
app.use(express.json({ limit: "2mb" }));

// Log webhook hits (debug gold)
app.use((req, res, next) => {
  if (req.path === TG_PATH || req.path === WA_PATH) {
    console.log("📥 INCOMING", req.method, req.path);
  }
  next();
});

// -------------------- EMOJI (subtle) --------------------
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
  const t = text.trim();
  if (/[🙂✨🤍🫶]$/.test(t)) return t;
  return `${t} ${pick(e)}`;
}

// -------------------- SUPABASE (prefs + permanent memory) --------------------
let supa = null;

async function initSupabase() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.log("ℹ️ Supabase disabled (missing SUPABASE_URL or key)");
    return false;
  }
  try {
    supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
      auth: { persistSession: false },
    });
    await supa.from(SUPABASE_TABLE).select("*").limit(1);
    console.log("✅ Supabase connection OK");
    return true;
  } catch (e) {
    console.log("⚠️ Supabase not ready:", e?.message || e);
    supa = null;
    return false;
  }
}

async function getPrefs(platform, userId) {
  const base = { lang: null, friendMode: true };
  if (!supa) return base;

  try {
    const { data, error } = await supa
      .from(SUPABASE_TABLE)
      .select("*")
      .eq("platform", platform)
      .eq("user_id", userId)
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

async function setPrefs(platform, userId, patch) {
  if (!supa) return false;

  const payload = {
    platform,
    user_id: userId,
    lang: patch.lang ?? null,
    friend_mode: FRIEND_MODE_LOCKED ? true : patch.friendMode ?? true,
    updated_at: new Date().toISOString(),
  };

  try {
    await supa.from(SUPABASE_TABLE).upsert(payload, {
      onConflict: "platform,user_id",
    });
    return true;
  } catch {
    return false;
  }
}

// ---------- Permanent memory in Supabase (fallback to in-memory if needed)
const MEMORY = new Map(); // fallback only (resets on redeploy)

function memKey(platform, userId) {
  return `${platform}:${userId}`;
}

async function getMemory(platform, userId, max = 10) {
  if (!userId) return [];

  // Supabase permanent memory
  if (supa) {
    try {
      const { data } = await supa
        .from(SUPABASE_MEMORY_TABLE)
        .select("role, content, created_at")
        .eq("platform", platform)
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(max);

      const rows = (data || []).reverse(); // return oldest -> newest
      return rows.map((r) => ({
        role: r.role,
        content: r.content,
      }));
    } catch {
      // fall through to in-memory
    }
  }

  // in-memory fallback
  const arr = MEMORY.get(memKey(platform, userId)) || [];
  return arr.slice(-max);
}

async function pushMemory(platform, userId, role, content, maxFallback = 20) {
  if (!userId) return;
  const c = String(content || "").trim();
  if (!c) return;

  // Supabase permanent memory
  if (supa) {
    try {
      await supa.from(SUPABASE_MEMORY_TABLE).insert({
        platform,
        user_id: userId,
        role,
        content: c,
      });
      return;
    } catch {
      // fall through
    }
  }

  // in-memory fallback
  const k = memKey(platform, userId);
  const arr = MEMORY.get(k) || [];
  arr.push({ role, content: c });
  MEMORY.set(k, arr.slice(-maxFallback));
}

// -------------------- LANGUAGE GUESS --------------------
function guessLangFromText(text = "") {
  const t = text.toLowerCase();
  if (/[äöüß]/.test(t) || /\b(und|nicht|ich|du|wir|danke)\b/.test(t)) return "de";
  if (/\b(ciao|grazie|perché|oggi|bene|allora|non)\b/.test(t)) return "it";
  return "en";
}

// -------------------- CORE REPLY --------------------
async function generateReply({ userText, lang, platform, userId }) {
  const clean = (userText || "").trim();

  if (!clean) {
    return { text: addEmoji(lang, "I’m here. Say something and I’ll stay with you.") };
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

  // fallback if no OpenAI
  if (!OPENAI_API_KEY) {
    const t =
      lang === "it"
        ? "Ti ascolto. Dimmi cosa hai in mente, e lo prendiamo con calma."
        : lang === "de"
        ? "Ich höre dir zu. Sag mir, was dich beschäftigt — wir nehmen es ruhig."
        : "I’m listening. Tell me what’s on your mind — we’ll take it slowly.";

    const q =
      lang === "it"
        ? "Vuoi raccontarmi solo una frase su come ti senti?"
        : lang === "de"
        ? "Willst du mir nur einen Satz sagen, wie du dich fühlst?"
        : "Want to give me just one sentence about how you feel?";

    return { text: addEmoji(lang, `${t} ${q}`) };
  }

  const system = `
You are HITH in FRIEND MODE (LOCKED ON).
Tone: warm, human, natural. Not clinical. Not robotic.
Emojis: subtle, max 1 per message.
Questions: ask ONLY if relevant; NEVER repeat the same question.
Memory: use recent context to stay coherent.
Language: reply in ${lang}.
Keep it concise but human.
`.trim();

  const history = await getMemory(platform, userId, 10);

  const body = {
    model: OPENAI_MODEL,
    messages: [{ role: "system", content: system }, ...history, { role: "user", content: clean }],
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
  const out = json?.choices?.[0]?.message?.content?.trim();

  if (!out) return { text: addEmoji(lang, "I’m here.") };

  return { text: addEmoji(lang, out) };
}

// -------------------- TELEGRAM --------------------
let bot = null;

function initTelegram() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.log("⚠️ Missing TELEGRAM_BOT_TOKEN (Telegram disabled)");
    return;
  }

  bot = new Telegraf(TELEGRAM_BOT_TOKEN);

  bot.on("text", async (ctx) => {
    try {
      const fromId = String(ctx.from?.id || "");
      const text = ctx.message?.text || "";

      const prefs = await getPrefs("tg", fromId);
      const lang = prefs.lang || guessLangFromText(text);

      await setPrefs("tg", fromId, { lang, friendMode: true });

      await pushMemory("telegram", fromId, "user", text);

      const out = await generateReply({
        userText: text,
        lang,
        platform: "telegram",
        userId: fromId,
      });

      await pushMemory("telegram", fromId, "assistant", out.text);

      await ctx.reply(out.text);
    } catch (e) {
      console.error("Telegram handler error:", e?.message || e);
    }
  });

  // ✅ Telegram webhook endpoint (ONLY ONCE)
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

// Debug: see Telegram webhook status
app.get("/tg-info", async (req, res) => {
  try {
    if (!bot) return res.status(200).json({ ok: false, error: "Telegram bot not initialized" });
    const info = await bot.telegram.getWebhookInfo();
    return res.status(200).json({ ok: true, info });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// -------------------- WHATSAPP (META) --------------------

// Verify endpoint (Meta calls GET)
app.get(WA_PATH, (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token && token === WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Receive messages endpoint (Meta calls POST)
app.post(WA_PATH, async (req, res) => {
  // ACK fast
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

    const prefs = await getPrefs("wa", from);
    const lang = prefs.lang || guessLangFromText(text);

    await setPrefs("wa", from, { lang, friendMode: true });

    await pushMemory("whatsapp", from, "user", text);

    const out = await generateReply({
      userText: text,
      lang,
      platform: "whatsapp",
      userId: from,
    });

    await pushMemory("whatsapp", from, "assistant", out.text);

    await sendWhatsAppText(from, out.text);
  } catch (e) {
    console.error("WhatsApp webhook error:", e?.message || e);
  }
});

async function sendWhatsAppText(to, text) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID) {
    console.log("⚠️ WhatsApp not configured (missing WHATSAPP_TOKEN / WHATSAPP_PHONE_ID)");
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
  if (!resp.ok) console.log("❌ WhatsApp send failed:", j);
  else console.log("✅ WhatsApp sent:", j?.messages?.[0]?.id || "ok");
}

// -------------------- HEALTH / DEBUG --------------------
app.get("/", (req, res) => res.status(200).send("HITH is alive ✅"));

app.get("/debug", (req, res) => {
  res.json({
    ok: true,
    publicUrl: PUBLIC_URL,
    telegram: {
      enabled: !!TELEGRAM_BOT_TOKEN,
      path: TG_PATH,
      webhook: PUBLIC_URL ? `${PUBLIC_URL}${TG_PATH}` : null,
    },
    whatsapp: {
      enabled: !!(WHATSAPP_TOKEN && WHATSAPP_PHONE_ID && WHATSAPP_VERIFY_TOKEN),
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

/**
 * HITH — Telegram + WhatsApp (Meta) unified bot
 * One Render service
 * ONE PUBLIC_URL (base only): https://your-service.onrender.com
 *
 * Telegram webhook path: /tg-webhook
 * WhatsApp webhook path: /whatsapp/webhook (GET verify + POST receive)
 *
 * Env required:
 *   PORT (optional)
 *   PUBLIC_URL   (BASE ONLY, no /path)
 *   OPENAI_API_KEY (optional, if you use AI)
 *
 * Telegram:
 *   TELEGRAM_BOT_TOKEN
 *
 * WhatsApp Cloud API:
 *   WHATSAPP_TOKEN
 *   WHATSAPP_PHONE_ID
 *   WHATSAPP_VERIFY_TOKEN
 *
 * Supabase optional:
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE (recommended) OR SUPABASE_KEY
 *   SUPABASE_TABLE (optional, default: hith_prefs)
 */

import express from "express";
import crypto from "crypto";
import { Telegraf } from "telegraf";
import { createClient } from "@supabase/supabase-js";

// -------------------- ENV --------------------
const PORT = process.env.PORT || 10000;

const PUBLIC_URL = (process.env.PUBLIC_URL || "")
  .trim()
  .replace(/\/+$/, ""); // base only

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

// Supabase (optional)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_KEY;
const SUPABASE_TABLE = process.env.SUPABASE_TABLE || "hith_prefs";

// -------------------- CONSTANTS --------------------
const TG_PATH = "/tg-webhook";
const WA_PATH = "/whatsapp/webhook";

// Friend mode LOCKED ✅
const FRIEND_MODE_LOCKED = true;

// Emoji behavior (subtle, not childish)
const EMOJI = {
  en: ["🙂", "✨", "🤍", "🫶"],
  it: ["🙂", "✨", "🤍", "🫶"],
  de: ["🙂", "✨", "🤍", "🫶"],
};

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function addEmoji(lang, text) {
  // keep it subtle: add at end only if not already ending with emoji/punctuation-heavy
  const l = (lang || "en").toLowerCase();
  const e = EMOJI[l] || EMOJI.en;
  if (!text) return text;
  if (/[🙂✨🤍🫶]$/.test(text.trim())) return text;
  return `${text.trim()} ${pick(e)}`;
}
const MEMORY = new Map(); // key -> array of {role, content}

function memKey(platform, userId) {
  return `${platform}:${userId}`;
}

function getMemory(platform, userId, max = 8) {
  const k = memKey(platform, userId);
  const arr = MEMORY.get(k) || [];
  return arr.slice(-max);
}

function pushMemory(platform, userId, role, content, max = 12) {
  const k = memKey(platform, userId);
  const arr = MEMORY.get(k) || [];
  arr.push({ role, content });
  MEMORY.set(k, arr.slice(-max));
}

// -------------------- APP --------------------
const app = express();
app.use(express.json({ limit: "2mb" })); // needed for WhatsApp payloads
// Log every webhook hit (super useful)
app.use((req, res, next) => {
  if (req.path === "/tg-webhook" || req.path === "/whatsapp/webhook") {
    console.log("📥 INCOMING", req.method, req.path);
  }
  next();
});
app.use((req, res, next) => {
  console.log("INCOMING:", req.method, req.path);
  next();
});

// -------------------- SUPABASE (optional) --------------------
let supa = null;
async function initSupabase() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return false;
  try {
    supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } });
    // quick check: select 1 row (table may be empty)
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
  // default prefs
  const base = { lang: null, friendMode: true };

  if (!supa) return base;

  try {
    const { data, error } = await supa
      .from(SUPABASE_TABLE)
      .select("*")
      .eq("platform", platform)
      .eq("user_id", userId)
      .maybeSingle();

    if (error) return base;
    if (!data) return base;

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
    await supa.from(SUPABASE_TABLE).upsert(payload, { onConflict: "platform,user_id" });
    return true;
  } catch {
    return false;
  }
}

// -------------------- LANGUAGE GUESS --------------------
function guessLangFromText(text = "") {
  const t = text.toLowerCase();
  if (/[äöüß]/.test(t) || /\b(und|nicht|ich|du|wir|danke)\b/.test(t)) return "de";
  if (/\b(ciao|grazie|perché|oggi|bene|allora|non)\b/.test(t)) return "it";
  return "en";
}

// -------------------- CORE REPLY LOGIC --------------------
async function generateReply({ userText, lang, platform, userId }) {
  const clean = (userText || "").trim();

  const system = `
You are HITH in FRIEND MODE (LOCKED ON).
Tone: warm, human, natural.
Emojis: subtle.
Language: reply in ${lang}.
`;

  // ⬇️ INCOLLA QUI
  const history = getMemory(platform, userId, 8);

  const body = {
    model: "gpt-4.1-mini",
    messages: [
      { role: "system", content: system.trim() },
      ...history,
      { role: "user", content: clean },
    ],
    temperature: 0.8,
  };

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  const json = await resp.json();
  const out = json?.choices?.[0]?.message?.content?.trim();

  return { text: addEmoji(lang, out || "I’m here.") };
}


  // If no OpenAI, fallback
  if (!OPENAI_API_KEY) {
    const t =
      lang === "it"
        ? "Ti ascolto. Dimmi cosa hai in mente, e lo prendiamo con calma."
        : lang === "de"
        ? "Ich höre dir zu. Sag mir, was dich beschäftigt — wir nehmen es ruhig."
        : "I’m listening. Tell me what’s on your mind — we’ll take it slowly.";
    // Only ask a question if it helps
    const q =
      lang === "it"
        ? "Cosa ti pesa di più oggi?"
        : lang === "de"
        ? "Was wiegt heute am meisten auf dir?"
        : "What’s weighing on you most today?";
    return { text: addEmoji(lang, `${t} ${q}`) };
  }

  // OpenAI call (minimal)
  const system = `
You are HITH in FRIEND MODE (LOCKED ON).
Tone: warm, human, natural. Not clinical.
Emojis: allowed, subtle, max 1-2 per message.
Questions: ask ONLY if relevant to the conversation or it makes it more interesting.
Never claim you can keep secrets perfectly; be honest that chats may be stored.
Language: reply in ${lang}.
Keep it concise, but not cold.
`;

  const body = {
    model: "gpt-4.1-mini",
    messages: [
      { role: "system", content: system.trim() },
      { role: "user", content: clean },
    ],
    temperature: 0.8,
  };

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  const json = await resp.json();
  const out = json?.choices?.[0]?.message?.content?.trim();

  if (!out) {
    const t =
      lang === "it"
        ? "Mi è saltata una parola. Riprova a dirmelo — sono qui."
        : lang === "de"
        ? "Mir ist gerade ein Wort weggerutscht. Sag’s mir nochmal — ich bin da."
        : "I dropped a word there. Tell me again — I’m here.";
    return { text: addEmoji(lang, t) };
  }

  return { text: addEmoji(lang, out) };
}

// -------------------- TELEGRAM --------------------
let bot = null;

function initTelegram() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.log("⚠️ Missing TELEGRAM_BOT_TOKEN (Telegram will not work)");
    return;
  }
app.get("/tg-info", async (req, res) => {
  try {
    if (!bot) return res.status(200).json({ ok: false, error: "Telegram bot not initialized" });
    const info = await bot.telegram.getWebhookInfo();
    return res.status(200).json({ ok: true, info });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

  bot = new Telegraf(TELEGRAM_BOT_TOKEN);

  bot.on("text", async (ctx) => {
    try {
      const fromId = String(ctx.from?.id || "");
      const text = ctx.message?.text || "";

      const prefs = await getPrefs("tg", fromId);
      const lang = prefs.lang || guessLangFromText(text);

      // friend mode locked on
      await setPrefs("tg", fromId, { lang, friendMode: true });
pushMemory("telegram", fromId, "user", text);

      const out = await generateReply({
  userText: text,
  lang,
  platform: "telegram",
  userId: fromId,
});


      await ctx.reply(out.text);
    } catch (e) {
      console.error("Telegram handler error:", e?.message || e);
    }
  });
pushMemory("telegram", fromId, "assistant", out.text);

  // Webhook callback
  app.use(bot.webhookCallback(TG_PATH));

}

// set webhook on startup
async function setupTelegramWebhook() {
  if (!bot || !PUBLIC_URL) return;
  const url = `${PUBLIC_URL}${TG_PATH}`;

  try {
    // telegraf has helper
    await bot.telegram.setWebhook(url, { drop_pending_updates: true });
    console.log("✅ Telegram webhook set:", url);
  } catch (e) {
    console.log("⚠️ Telegram setWebhook failed:", e?.message || e);
  }
}

// -------------------- WHATSAPP (META) --------------------

// Verification endpoint (Meta calls this)
app.get(WA_PATH, (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token && token === WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Receive messages endpoint
app.post(WA_PATH, async (req, res) => {
  // ACK fast (Meta wants 200 quickly)
  res.sendStatus(200);

  try {
    const body = req.body;

    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const msg = value?.messages?.[0];
    if (!msg) return;

    const from = msg.from; // WhatsApp user number (string)
    const text = msg?.text?.body || "";

    const prefs = await getPrefs("wa", from);
    const lang = prefs.lang || guessLangFromText(text);

    await setPrefs("wa", from, { lang, friendMode: true });

    const out = await generateReply({
      userText: text,
      lang,
      platform: "whatsapp",
    });

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

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const j = await resp.json();
  if (!resp.ok) {
    console.log("WhatsApp send failed:", j);
  }
}

// -------------------- HEALTH --------------------
app.get("/", (req, res) => {
  res.status(200).send("HITH is alive ✅");
});

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
  });
});

// -------------------- START --------------------
(async function start() {
  await initSupabase();

  initTelegram();

  app.listen(PORT, async () => {
    console.log(`🚀 Server listening on ${PORT}`);
    console.log("🌐 PUBLIC_URL base:", PUBLIC_URL || "(missing)");

    console.log("📌 WhatsApp webhook path:", WA_PATH);
    console.log("📌 Telegram webhook path:", TG_PATH);

    if (bot) {
      await setupTelegramWebhook();
    } else {
      console.log("⚠️ Telegram disabled (no token).");
    }
  });
})();

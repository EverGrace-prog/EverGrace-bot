/**
 * HITH (Hith) — Telegram + WhatsApp (Meta Cloud API)
 * - Telegram webhook:  /tg-webhook
 * - WhatsApp webhook:  /whatsapp/webhook   (GET verify + POST receive)
 * - Friend Mode: LOCKED ON
 * - Language: reply in the language of the user's message
 * - Uses emojis naturally
 * - Persists prefs (lang, friendMode) in Supabase
 */

import express from "express";
import fetch from "node-fetch";
import { Telegraf, Markup } from "telegraf";
import { createClient } from "@supabase/supabase-js";

const app = express();

// ----- ENV -----
const PORT = process.env.PORT || 10000;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const PUBLIC_URL_RAW = process.env.PUBLIC_URL || ""; // must be https://xxxx.onrender.com
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_KEY || "";

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID || "";
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || "";

if (!OPENAI_API_KEY) console.warn("⚠️ Missing OPENAI_API_KEY");
if (!PUBLIC_URL_RAW) console.warn("⚠️ Missing PUBLIC_URL (required for Telegram webhook)");
if (!TELEGRAM_BOT_TOKEN) console.warn("⚠️ Missing TELEGRAM_BOT_TOKEN (Telegram will not work)");

const PUBLIC_URL = normalizeBaseUrl(PUBLIC_URL_RAW);

// ----- Supabase -----
const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } })
    : null;

async function supaOkLog() {
  if (!supabase) return console.log("🟡 Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE missing)");
  try {
    // lightweight call: fetch server time from PostgREST root (no table needed)
    const res = await fetch(`${SUPABASE_URL}/rest/v1/`, { headers: { apikey: SUPABASE_SERVICE_ROLE } });
    console.log(res.ok ? "✅ Supabase connection OK" : "🟠 Supabase reachable but not OK");
  } catch {
    console.log("🟠 Supabase connection failed");
  }
}

// ----- JSON body -----
app.use(express.json({ limit: "2mb" }));

// ----- Helpers -----
function normalizeBaseUrl(url) {
  if (!url) return "";
  let u = url.trim();
  // remove trailing slash
  while (u.endsWith("/")) u = u.slice(0, -1);
  // ensure https for webhooks
  if (u.startsWith("http://")) u = "https://" + u.slice("http://".length);
  return u;
}

function guessLangFromText(text = "") {
  const t = (text || "").toLowerCase();

  // quick-and-good heuristics
  const itHits = [" ciao", " grazie", " come ", " non ", " che ", " per ", " io ", " tu ", " vuoi", " bene", " allora", " perché"];
  const deHits = [" hallo", " danke", " bitte", " ich ", " du ", " nicht ", " und ", " was ", " wie ", " warum", " heute", " gut"];
  const enHits = [" hi", " hey", " thanks", " please", " i ", " you ", " not ", " and ", " what ", " how ", " why", " today", " good"];

  const score = (hits) => hits.reduce((acc, w) => acc + (t.includes(w) ? 1 : 0), 0);

  const it = score(itHits);
  const de = score(deHits);
  const en = score(enHits);

  if (de >= it && de >= en && de > 0) return "de";
  if (it >= de && it >= en && it > 0) return "it";
  return "en";
}

function addEmoji(lang, text) {
  // light, friendly, not spammy
  const trimmed = (text || "").trim();
  if (!trimmed) return text;

  const starters = {
    it: ["😊", "✨", "🙂", "🤍"],
    en: ["😊", "✨", "🙂", "🤍"],
    de: ["😊", "✨", "🙂", "🤍"],
  };
  const enders = {
    it: ["✨", "🙂", "🤍", "😊"],
    en: ["✨", "🙂", "🤍", "😊"],
    de: ["✨", "🙂", "🤍", "😊"],
  };

  // If already contains emoji, keep it
  const hasEmoji = /[\u{1F300}-\u{1FAFF}]/u.test(trimmed);
  if (hasEmoji) return trimmed;

  // Add one emoji at start OR end based on punctuation
  const s = starters[lang] || starters.en;
  const e = enders[lang] || enders.en;

  if (trimmed.endsWith("?")) return `${s[0]} ${trimmed}`;
  if (trimmed.length > 120) return `${trimmed} ${e[0]}`;
  return `${s[2]} ${trimmed}`;
}

function hithSystemPrompt(lang) {
  const base = {
    it: `Ti chiami Hith. Sei in "Friend Mode" sempre attivo (LOCKED). Conversazione calda, naturale e umana.
Regole: rispondi SEMPRE nella lingua dell’utente (se l’utente scrive in inglese, rispondi in inglese; se tedesco, in tedesco; ecc).
Usa emoji con misura, come un amico. Fai domande SOLO se sono rilevanti o rendono la conversazione più interessante.
Non essere distante o formale. Non dire che sei un’AI. Non promettere segreti “tra noi per sempre”: sii rispettoso e realistico.
Risposte: brevi-medio, fluide, senza bullet inutili.`,
    en: `Your name is Hith. You are in Friend Mode, always ON (LOCKED). Be warm, natural, human.
Rules: ALWAYS reply in the user's language (English -> English, German -> German, etc).
Use emojis lightly like a friend. Ask questions ONLY if relevant or if it makes the conversation more interesting.
Don't be distant or formal. Don't say you're an AI. Don't promise "this stays between us forever"—be respectful and realistic.
Replies: short-to-medium, fluid, no unnecessary bullets.`,
    de: `Du heißt Hith. Friend Mode ist immer AN (LOCKED). Sei warm, natürlich, menschlich.
Regeln: Antworte IMMER in der Sprache des Nutzers (Englisch -> Englisch, Italienisch -> Italienisch, usw.).
Nutze Emojis dezent wie ein Freund. Stelle Fragen NUR wenn sie relevant sind oder die Unterhaltung interessanter machen.
Nicht distanziert oder formal sein. Sag nicht, dass du eine KI bist. Keine unrealistischen Geheimnis-Versprechen.
Antworten: kurz bis mittel, flüssig, ohne unnötige Aufzählungen.`,
  };
  return base[lang] || base.en;
}

async function getPrefs(channel, userId) {
  // friendMode locked true by design
  const fallback = { lang: "en", friendMode: true };

  if (!supabase) return fallback;

  try {
    const { data, error } = await supabase
      .from("hith_prefs")
      .select("*")
      .eq("channel", channel)
      .eq("user_id", String(userId))
      .maybeSingle();

    if (error) return fallback;
    if (!data) return fallback;

    return {
      lang: data.lang || "en",
      friendMode: true,
    };
  } catch {
    return fallback;
  }
}

async function setPrefs(channel, userId, patch) {
  if (!supabase) return;

  const payload = {
    channel,
    user_id: String(userId),
    lang: patch.lang || "en",
    friend_mode: true,
    updated_at: new Date().toISOString(),
  };

  try {
    await supabase.from("hith_prefs").upsert(payload, { onConflict: "channel,user_id" });
  } catch (e) {
    console.warn("⚠️ setPrefs failed:", e?.message || e);
  }
}

async function callOpenAI({ lang, userText }) {
  const system = hithSystemPrompt(lang);

  // OpenAI Responses API style via fetch (no SDK needed)
  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      input: [
        { role: "system", content: system },
        { role: "user", content: userText || "" },
      ],
      max_output_tokens: 220,
    }),
  });

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`OpenAI error ${resp.status}: ${t}`);
  }

  const json = await resp.json();

  // extract text
  const out =
    json?.output?.[0]?.content?.map((c) => c?.text).filter(Boolean).join("\n") ||
    json?.output_text ||
    "";

  return (out || "").trim();
}

// ===================== TELEGRAM =====================
const bot = TELEGRAM_BOT_TOKEN ? new Telegraf(TELEGRAM_BOT_TOKEN) : null;

function telegramMainMenu(lang) {
  const labels = {
    it: { journal: "📁 Journal", progress: "📊 Progress", coach: "📌 Coach", sos: "⚡ SOS", invite: "🔗 Invite", settings: "⚙️ Impostazioni" },
    en: { journal: "📁 Journal", progress: "📊 Progress", coach: "📌 Coach", sos: "⚡ SOS", invite: "🔗 Invite", settings: "⚙️ Settings" },
    de: { journal: "📁 Journal", progress: "📊 Progress", coach: "📌 Coach", sos: "⚡ SOS", invite: "🔗 Invite", settings: "⚙️ Einstellungen" },
  };
  const L = labels[lang] || labels.en;

  return Markup.keyboard([[L.journal, L.progress], [L.coach, L.sos], [L.invite, L.settings]]).resize();
}

function telegramSettingsMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🇮🇹 IT", "lang_it"), Markup.button.callback("🇬🇧 EN", "lang_en"), Markup.button.callback("🇩🇪 DE", "lang_de")],
    [Markup.button.callback("🔒 Lock friend mode", "lock_friend")],
  ]);
}

if (bot) {
  bot.start(async (ctx) => {
    const userId = ctx.from?.id;
    const prefs = await getPrefs("tg", userId);
    const lang = prefs.lang || "en";

    const hello = {
      it: "Ciao 😊 Sono Hith. Dimmi pure cosa ti passa per la testa.",
      en: "Hey 😊 I’m Hith. Tell me what’s on your mind.",
      de: "Hey 😊 Ich bin Hith. Erzähl mir, was dir gerade durch den Kopf geht.",
    };

    await ctx.reply(hello[lang] || hello.en, telegramMainMenu(lang));
  });

  bot.on("text", async (ctx) => {
    const userId = ctx.from?.id;
    const text = ctx.message?.text || "";

    // menu buttons
    const lowered = text.toLowerCase();
    if (["⚙️ impostazioni", "⚙️ settings", "⚙️ einstellungen"].includes(lowered)) {
      await ctx.reply("✅", telegramSettingsMenu());
      return;
    }

    // If user taps menu items, we respond (you can wire real features later)
    if (lowered.includes("journal")) {
      await ctx.reply("📙 Journal: scrivi qui il tuo pensiero e lo custodisco. (feature in progress) ✨");
      return;
    }
    if (lowered.includes("progress")) {
      await ctx.reply("📊 Progress: possiamo tracciare abitudini e momenti DI. (feature in progress) ✨");
      return;
    }
    if (lowered.includes("coach")) {
      await ctx.reply("📌 Coach: dimmi cosa vuoi migliorare oggi. ✨");
      return;
    }
    if (lowered.includes("sos")) {
      await ctx.reply("⚡ SOS: sono qui. Una frase: cosa sta succedendo adesso? 🤍");
      return;
    }
    if (lowered.includes("invite")) {
      await ctx.reply("🔗 Invita un’amica/o: condividi il link del bot (feature in progress) ✨");
      return;
    }

    const prefs = await getPrefs("tg", userId);
    const detected = guessLangFromText(text);
    const lang = detected || prefs.lang || "en";
    await setPrefs("tg", userId, { lang });

    try {
      const out = await callOpenAI({ lang, userText: text });
      await ctx.reply(addEmoji(lang, out), telegramMainMenu(lang));
    } catch (e) {
      console.error("Telegram reply error:", e?.message || e);
      await ctx.reply("⚠️ Temporary hiccup. Try again in a second. 🤍");
    }
  });

  bot.on("callback_query", async (ctx) => {
    const userId = ctx.from?.id;
    const data = ctx.callbackQuery?.data || "";

    if (data.startsWith("lang_")) {
      const lang = data.replace("lang_", "");
      await setPrefs("tg", userId, { lang });
      await ctx.answerCbQuery("✅");
      await ctx.reply("✅", telegramMainMenu(lang));
      return;
    }

    if (data === "lock_friend") {
      // Friend mode is always locked anyway, but we confirm.
      await setPrefs("tg", userId, { lang: (await getPrefs("tg", userId)).lang || "en" });
      await ctx.answerCbQuery("🔒 Friend mode locked");
      return;
    }

    await ctx.answerCbQuery("✅");
  });
}

// Telegram webhook route
const TG_SECRET_PATH = "/tg-webhook";
if (bot) {
  app.use(TG_SECRET_PATH, bot.webhookCallback(TG_SECRET_PATH));
}

// Setup Telegram webhook on boot
async function setupTelegramWebhook() {
  if (!bot) return;

  const url = `${PUBLIC_URL}${TG_SECRET_PATH}`;

  try {
    // Use Telegraf helper
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    await bot.telegram.setWebhook(url, { allowed_updates: ["message", "callback_query"] });

    console.log("📌 PUBLIC_URL:", PUBLIC_URL);
    console.log("📌 Telegram webhook URL:", url);
  } catch (e) {
    console.error("❌ Telegram webhook setup failed:", e?.message || e);
  }
}

// ===================== WHATSAPP =====================

// IMPORTANT: Meta verifies via GET with hub.challenge
app.get("/whatsapp/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token && token === WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Receive messages (POST)
app.post("/whatsapp/webhook", async (req, res) => {
  // ACK fast
  res.sendStatus(200);

  try {
    const body = req.body;

    // Typical message shape:
    // entry[0].changes[0].value.messages[0]
    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const msg = value?.messages?.[0];
    if (!msg) return;

    const from = msg.from; // WhatsApp user number (string)
    const text = msg?.text?.body || "";

    // Ignore non-text for now
    if (!text) return;

    const prefs = await getPrefs("wa", from);
    const detected = guessLangFromText(text);
    const lang = detected || prefs.lang || "en";
    await setPrefs("wa", from, { lang });

    const out = await callOpenAI({ lang, userText: text });
    await sendWhatsAppText(from, addEmoji(lang, out));
  } catch (e) {
    console.error("WhatsApp webhook error:", e?.message || e);
  }
});

async function sendWhatsAppText(to, text) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID) {
    console.warn("⚠️ WhatsApp not configured (missing WHATSAPP_TOKEN / WHATSAPP_PHONE_ID)");
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

  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    console.error("❌ WhatsApp send error:", resp.status, t);
  }
}

// ===================== HEALTH =====================
app.get("/", (req, res) => {
  res.status(200).send("HITH is alive ✅");
});

app.get("/health", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "HITH",
    telegram: !!bot,
    whatsapp: !!(WHATSAPP_TOKEN && WHATSAPP_PHONE_ID && WHATSAPP_VERIFY_TOKEN),
  });
});

// ===================== START =====================
app.listen(PORT, async () => {
  console.log("🚀 Server listening on", PORT);
  console.log("🌐 PUBLIC_URL base:", PUBLIC_URL);

  await supaOkLog();
  await setupTelegramWebhook();
});

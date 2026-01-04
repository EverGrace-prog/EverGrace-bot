/**
 * HITH — Telegram + WhatsApp (Meta) unified bot
 * - One Render service
 * - ONE PUBLIC_URL (base): https://your-service.onrender.com
 * - Telegram webhook path: /tg-webhook
 * - WhatsApp webhook path: /whatsapp/webhook  (GET verify + POST receive)
 *
 * Env required:
 *   PORT
 *   PUBLIC_URL                 (BASE ONLY, no /path)
 *   OPENAI_API_KEY
 *
 * Telegram:
 *   TELEGRAM_BOT_TOKEN
 *
 * WhatsApp Cloud API:
 *   WHATSAPP_TOKEN
 *   WHATSAPP_PHONE_ID
 *   WHATSAPP_VERIFY_TOKEN
 *
 * Supabase optional (prefs persistence):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE   (recommended) OR SUPABASE_KEY
 *   SUPABASE_TABLE          (optional, default: hith_prefs)
 */

import express from "express";
import crypto from "crypto";
import { Telegraf, Markup } from "telegraf";
import { createClient } from "@supabase/supabase-js";

const app = express();
app.use(express.json({ limit: "2mb" })); // needed for WhatsApp payloads

// ---------------- ENV ----------------
const PORT = process.env.PORT || 10000;

const PUBLIC_URL = (process.env.PUBLIC_URL || "").trim().replace(/\/+$/, ""); // base only
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

// Supabase (optional)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_KEY;
const SUPABASE_TABLE = process.env.SUPABASE_TABLE || "hith_prefs";

const TG_PATH = "/tg-webhook";
const WA_PATH = "/whatsapp/webhook";

// ---------------- SMALL HELPERS ----------------
const memoryFallback = new Map(); // if Supabase is not configured / fails

function nowISO() {
  return new Date().toISOString();
}

function safeLower(s = "") {
  return String(s).toLowerCase();
}

// lightweight language guess from text (good enough for IT/EN/DE)
function guessLangFromText(text = "") {
  const t = safeLower(text);

  // If user is clearly writing German
  const deHints = [" und ", " ich ", " nicht ", " danke", " bitte", " schön", " gerade", " heute", " wirklich", " einfach"];
  const itHints = [" che ", " non ", " grazie", " per ", " come ", " oggi", " davvero", " però", " perché", " allora", " ciao"];
  const enHints = [" the ", " and ", " you ", " thanks", " please", " today", " really", " just", " because", " hello", " sup"];

  const score = (arr) => arr.reduce((acc, w) => (t.includes(w) ? acc + 1 : acc), 0);

  const sDE = score(deHints);
  const sIT = score(itHints);
  const sEN = score(enHints);

  // default English if uncertain
  if (sDE >= sIT && sDE >= sEN && sDE > 0) return "de";
  if (sIT >= sDE && sIT >= sEN && sIT > 0) return "it";
  if (sEN > 0) return "en";
  return "en";
}

function addEmoji(lang, text) {
  // keep it light, friend-mode vibe, not forced
  const emojis = {
    en: ["🙂", "✨", "🤍", "😄", "👌"],
    it: ["🙂", "✨", "🤍", "😄", "👌"],
    de: ["🙂", "✨", "🤍", "😄", "👌"],
  };

  // If user used emojis, mirror slightly. If not, use only sometimes.
  const userUsedEmoji = /[\u{1F300}-\u{1FAFF}]/u.test(text);
  const chance = userUsedEmoji ? 0.7 : 0.25;

  if (Math.random() > chance) return text;

  const pick = emojis[lang] || emojis.en;
  const e = pick[Math.floor(Math.random() * pick.length)];
  // don’t emoji-bomb: one emoji at end
  return `${text} ${e}`;
}

// Friend mode: ask questions ONLY when it helps. We implement as rule + prompt.
function shouldAskQuestion(userText) {
  const t = safeLower(userText);
  // Only ask if user is vague/ambiguous or invites it
  const triggers = [
    "help me",
    "what do you think",
    "advice",
    "should i",
    "how do i",
    "any ideas",
    "i feel",
    "i'm feeling",
    "i am feeling",
    "suggest",
    "recommend",
    "talk to me",
  ];
  return triggers.some((x) => t.includes(x));
}

// ---------------- SUPABASE PREFS ----------------
const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } })
    : null;

async function getPrefs(channel, userId) {
  const key = `${channel}:${userId}`;

  // default: friend mode locked ON, language auto
  const defaults = { lang: null, friendModeLocked: true, friendMode: true, updatedAt: nowISO() };

  if (!supabase) return { ...defaults, ...(memoryFallback.get(key) || {}) };

  try {
    const { data, error } = await supabase
      .from(SUPABASE_TABLE)
      .select("prefs")
      .eq("id", key)
      .maybeSingle();

    if (error) throw error;

    const prefs = data?.prefs || {};
    return { ...defaults, ...prefs };
  } catch (e) {
    // fallback
    return { ...defaults, ...(memoryFallback.get(key) || {}) };
  }
}

async function setPrefs(channel, userId, patch) {
  const key = `${channel}:${userId}`;
  const current = await getPrefs(channel, userId);
  const merged = { ...current, ...patch, updatedAt: nowISO() };

  if (!supabase) {
    memoryFallback.set(key, merged);
    return merged;
  }

  try {
    const { error } = await supabase.from(SUPABASE_TABLE).upsert(
      {
        id: key,
        prefs: merged,
        updated_at: nowISO(),
      },
      { onConflict: "id" }
    );
    if (error) throw error;
    return merged;
  } catch (e) {
    memoryFallback.set(key, merged);
    return merged;
  }
}

// ---------------- OPENAI CALL ----------------
async function askHithAI({ userText, lang, friendMode = true }) {
  if (!OPENAI_API_KEY) {
    // fallback without OpenAI: still respond
    return {
      it: "Sono qui. Dimmi pure 🙂",
      en: "I’m here. Tell me what’s on your mind 🙂",
      de: "Ich bin da. Sag mir, was dich beschäftigt 🙂",
    }[lang || "en"];
  }

  const systemByLang = {
    en: `You are HITH, a warm, human, friendly chat companion.
Friend mode is ON and LOCKED.
Rules:
- Reply in the same language as the user's message.
- Use a friendly tone. Light emojis are allowed (1 max) but not forced.
- Do NOT say you keep secrets or that things stay between us. If asked, be honest: you can’t guarantee confidentiality.
- Ask a question ONLY if it clearly helps the conversation or makes it more interesting. Otherwise, just respond.
- Keep answers natural and not robotic.`,
    it: `Sei HITH, un compagno di chat caldo, umano, amichevole.
Modalità amica è ATTIVA e BLOCCATA.
Regole:
- Rispondi nella stessa lingua del messaggio dell’utente.
- Tono amichevole. Emoji leggere consentite (max 1) ma non obbligatorie.
- NON dire che puoi mantenere segreti o che resta “tra noi”. Se te lo chiedono, sii onesto: non puoi garantire riservatezza.
- Fai una domanda SOLO se aiuta davvero la conversazione o la rende più interessante. Altrimenti rispondi e basta.
- Evita tono robotico.`,
    de: `Du bist HITH, ein warmer, menschlicher, freundlicher Chat-Begleiter.
Freund-Modus ist AN und GESPERRT.
Regeln:
- Antworte in derselben Sprache wie die Nachricht des Nutzers.
- Freundlicher Ton. Leichte Emojis sind erlaubt (max 1), aber nicht erzwungen.
- Sage NICHT, dass du Geheimnisse bewahrst oder dass es “zwischen uns” bleibt. Wenn gefragt, sei ehrlich: du kannst keine Vertraulichkeit garantieren.
- Stelle nur dann eine Frage, wenn sie wirklich hilft oder das Gespräch interessanter macht. Sonst einfach antworten.
- Nicht robotisch klingen.`,
  };

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

  // Question gating: if not needed, instruct model to avoid.
  const askQ = shouldAskQuestion(userText);

  const extra = askQ
    ? ""
    : "\nImportant: Do not end with a question. Do not ask follow-ups.";

  const system = (systemByLang[lang] || systemByLang.en) + extra;

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.7,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userText },
      ],
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    console.error("OpenAI error:", resp.status, txt);
    return {
      it: "Ok, ci sono. Parliamone 🙂",
      en: "Okay, I’m here. Let’s talk 🙂",
      de: "Okay, ich bin da. Lass uns reden 🙂",
    }[lang || "en"];
  }

  const data = await resp.json();
  const out = data?.choices?.[0]?.message?.content?.trim();
  return out || "…";
}

// ---------------- TELEGRAM ----------------
let bot = null;

function telegramMainKeyboard(lang = "en") {
  const labels = {
    it: { journal: "📙 Journal", progress: "📊 Progress", coach: "📌 Coach", sos: "⚡ SOS", invite: "🔗 Invite", settings: "⚙️ Impostazioni" },
    en: { journal: "📙 Journal", progress: "📊 Progress", coach: "📌 Coach", sos: "⚡ SOS", invite: "🔗 Invite", settings: "⚙️ Settings" },
    de: { journal: "📙 Journal", progress: "📊 Progress", coach: "📌 Coach", sos: "⚡ SOS", invite: "🔗 Invite", settings: "⚙️ Einstellungen" },
  }[lang] || {
    journal: "📙 Journal", progress: "📊 Progress", coach: "📌 Coach", sos: "⚡ SOS", invite: "🔗 Invite", settings: "⚙️ Settings"
  };

  return Markup.keyboard([
    [labels.journal, labels.progress],
    [labels.coach, labels.sos],
    [labels.invite, labels.settings],
  ]).resize();
}

function telegramSettingsInline() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("🇮🇹 IT", "SET_LANG_it"),
      Markup.button.callback("🇬🇧 EN", "SET_LANG_en"),
      Markup.button.callback("🇩🇪 DE", "SET_LANG_de"),
    ],
    [Markup.button.callback("🔒 Lock friend mode", "LOCK_FRIEND")],
  ]);
}

async function setupTelegram() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn("Missing TELEGRAM_BOT_TOKEN (Telegram will not work)");
    return;
  }

  bot = new Telegraf(TELEGRAM_BOT_TOKEN);

  bot.start(async (ctx) => {
    const userId = String(ctx.from?.id);
    const prefs = await getPrefs("tg", userId);
    const lang = prefs.lang || guessLangFromText(ctx.message?.text || "") || "en";
    await setPrefs("tg", userId, { friendMode: true, friendModeLocked: true });

    const greet = {
      it: "Ciao, sono Hith. Sono qui con te 🙂",
      en: "Hey, I’m Hith. I’m here with you 🙂",
      de: "Hey, ich bin Hith. Ich bin für dich da 🙂",
    }[lang] || "Hey, I’m Hith. I’m here with you 🙂";

    await ctx.reply(greet, telegramMainKeyboard(lang));
  });

  bot.action(/^SET_LANG_(it|en|de)$/, async (ctx) => {
    const lang = ctx.match[1];
    const userId = String(ctx.from?.id);
    await setPrefs("tg", userId, { lang });
    await ctx.answerCbQuery("Saved ✅");
    await ctx.reply(
      { it: "Lingua impostata ✅", en: "Language set ✅", de: "Sprache gesetzt ✅" }[lang],
      telegramMainKeyboard(lang)
    );
  });

  bot.action("LOCK_FRIEND", async (ctx) => {
    const userId = String(ctx.from?.id);
    const prefs = await setPrefs("tg", userId, { friendModeLocked: true, friendMode: true });
    const lang = prefs.lang || "en";
    await ctx.answerCbQuery("Locked ✅");
    await ctx.reply(
      { it: "Modalità amica bloccata ✅", en: "Friend mode locked ✅", de: "Freund-Modus gesperrt ✅" }[lang],
      telegramMainKeyboard(lang)
    );
  });

  bot.hears(["⚙️ Impostazioni", "⚙️ Settings", "⚙️ Einstellungen"], async (ctx) => {
    await ctx.reply("Settings:", telegramSettingsInline());
  });

  bot.hears(["🔗 Invite", "🔗 Invita", "Invite"], async (ctx) => {
    const username = ctx.me || "HITH";
    await ctx.reply(`Invite a friend:\nhttps://t.me/${username}`);
  });

  // Main conversation handler
  bot.on("text", async (ctx) => {
    const userId = String(ctx.from?.id);
    const text = String(ctx.message?.text || "");

    const prefs = await getPrefs("tg", userId);

    // language: always follow user message language unless user forced a lang
    const detected = guessLangFromText(text);
    const lang = prefs.lang || detected;

    // Keep friend mode ON and locked
    if (!prefs.friendModeLocked || prefs.friendMode !== true) {
      await setPrefs("tg", userId, { friendModeLocked: true, friendMode: true });
    }

    // If user asks about secrets, be honest (override AI if needed)
    if (safeLower(text).includes("secret") || safeLower(text).includes("segreto") || safeLower(text).includes("geheim")) {
      const honest = {
        it: "Posso ascoltarti, ma non posso garantire riservatezza assoluta come una cassaforte. Se vuoi, dimmi solo ciò che ti fa sentire al sicuro 🙂",
        en: "I can listen, but I can’t guarantee absolute confidentiality like a vault. Share only what feels safe 🙂",
        de: "Ich kann zuhören, aber ich kann keine absolute Vertraulichkeit wie ein Tresor garantieren. Teile nur, was sich sicher anfühlt 🙂",
      }[lang] || "I can listen, but I can’t guarantee absolute confidentiality like a vault. Share only what feels safe 🙂";
      return ctx.reply(honest);
    }

    const out = await askHithAI({ userText: text, lang, friendMode: true });
    await ctx.reply(addEmoji(lang, out), telegramMainKeyboard(lang));
  });

  // Express route for webhook
  app.use(TG_PATH, bot.webhookCallback(TG_PATH));

  // Set webhook on boot
  if (!PUBLIC_URL) {
    console.warn("Missing PUBLIC_URL; cannot set Telegram webhook automatically.");
  } else {
    const webhookURL = `${PUBLIC_URL}${TG_PATH}`;
    try {
      // Telegraf helper
      await bot.telegram.setWebhook(webhookURL, { drop_pending_updates: true });
      console.log("Telegram webhook set:", webhookURL);
    } catch (e) {
      console.error("Telegram setWebhook failed:", e?.message || e);
    }
  }
}

// ---------------- WHATSAPP (META) ----------------

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

    const from = msg.from; // WA user phone number (string)
    const text = msg?.text?.body || "";

    const prefs = await getPrefs("wa", from);

    // language: follow user text unless user forced a lang
    const detected = guessLangFromText(text);
    const lang = prefs.lang || detected;

    // Friend mode is locked ON
    if (!prefs.friendModeLocked || prefs.friendMode !== true) {
      await setPrefs("wa", from, { friendModeLocked: true, friendMode: true });
    }

    // Simple text commands for WA
    if (safeLower(text).includes("lock friend mode") || safeLower(text).includes("blocca modalità amica")) {
      await setPrefs("wa", from, { friendModeLocked: true, friendMode: true });
      const confirm = {
        it: "Modalità amica bloccata ✅",
        en: "Friend mode locked ✅",
        de: "Freund-Modus gesperrt ✅",
      }[lang] || "Friend mode locked ✅";
      await sendWhatsAppText(from, confirm);
      return;
    }

    // secrets honesty
    if (safeLower(text).includes("secret") || safeLower(text).includes("segreto") || safeLower(text).includes("geheim")) {
      const honest = {
        it: "Posso ascoltarti, ma non posso garantire riservatezza assoluta come una cassaforte. Se vuoi, dimmi solo ciò che ti fa sentire al sicuro 🙂",
        en: "I can listen, but I can’t guarantee absolute confidentiality like a vault. Share only what feels safe 🙂",
        de: "Ich kann zuhören, aber ich kann keine absolute Vertraulichkeit wie ein Tresor garantieren. Teile nur, was sich sicher anfühlt 🙂",
      }[lang] || "I can listen, but I can’t guarantee absolute confidentiality like a vault. Share only what feels safe 🙂";
      await sendWhatsAppText(from, honest);
      return;
    }

    const out = await askHithAI({ userText: text, lang, friendMode: true });
    await sendWhatsAppText(from, addEmoji(lang, out));
  } catch (e) {
    console.error("WhatsApp webhook error:", e?.message || e);
  }
});

async function sendWhatsAppText(to, text) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID) {
    console.warn("WhatsApp not configured (missing WHATSAPP_TOKEN / WHATSAPP_PHONE_ID)");
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
    console.error("WhatsApp send failed:", resp.status, t);
  }
}

// ---------------- HEALTH ----------------
app.get("/", (req, res) => {
  res.status(200).send("HITH is alive ✅");
});

// ---------------- BOOT ----------------
app.listen(PORT, async () => {
  console.log("Server listening on", PORT);
  console.log("PUBLIC_URL base:", PUBLIC_URL || "(missing)");

  if (supabase) {
    // best-effort test
    try {
      await supabase.from(SUPABASE_TABLE).select("id").limit(1);
      console.log("Supabase connection OK");
    } catch (e) {
      console.warn("Supabase test failed (still ok, will fallback):", e?.message || e);
    }
  }

  await setupTelegram();
});

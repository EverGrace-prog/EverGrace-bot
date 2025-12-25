// index.js — HITH bot: Telegram + Supabase + OpenAI + Webhooks + WhatsApp
// FIX: Telegram webhook route (Express mount vs Telegraf path mismatch)
// FIX: safer PUBLIC_URL normalization + https guard
// FIX: OpenAI call timeout + better error logs
// FIX: trust proxy for Render + clean shutdown

import express from "express";
import fetch from "node-fetch";
import { Telegraf, Markup } from "telegraf";
import { createClient } from "@supabase/supabase-js";

// =============== ENV ==================
const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_KEY;

const SUPABASE_USERS_TABLE =
  process.env.SUPABASE_USERS_TABLE || process.env.SUPABASE_TABLE || "users";
const SUPABASE_MESSAGES_TABLE =
  process.env.SUPABASE_MESSAGES_TABLE || "messages";

// PUBLIC_URL (Render) o WEBHOOK_DOMAIN (vecchia .env locale)
const RAW_PUBLIC_URL =
  process.env.PUBLIC_URL || process.env.WEBHOOK_DOMAIN || "";

// WhatsApp (opzionale)
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;

// Porta Render
const PORT = Number(process.env.PORT) || 10000;

// --- Controllo env critici ---
function die(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

if (!BOT_TOKEN) die("Missing BOT_TOKEN");
if (!OPENAI_API_KEY) die("Missing OPENAI_API_KEY");
if (!SUPABASE_URL || !SUPABASE_KEY)
  die("Missing Supabase config: SUPABASE_URL / SUPABASE_KEY");
if (!RAW_PUBLIC_URL) die("Missing PUBLIC_URL (or WEBHOOK_DOMAIN).");

// Normalizza PUBLIC_URL (niente slash finali)
const PUBLIC_URL = RAW_PUBLIC_URL.trim().replace(/\/+$/, "");
if (!/^https:\/\//i.test(PUBLIC_URL)) {
  die(
    `PUBLIC_URL must start with https://  (got: "${PUBLIC_URL}"). In Render set PUBLIC_URL to your https service URL.`
  );
}
console.log("PUBLIC_URL:", PUBLIC_URL);

// =============== CLIENTS ==============
const app = express();
app.set("trust proxy", 1); // Render / reverse proxy safe
app.use(express.json({ limit: "2mb" }));

const bot = new Telegraf(BOT_TOKEN);

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

// =============== HITH PERSONALITY ==============
const HITH_SYSTEM_PROMPT = `
You are HITH: a gentle, encouraging companion for journaling, coaching and tiny steps.
Style: warm, concise, practical. Celebrate small wins. Never overwhelm the user.
Language: mirror the user's language (it/it-IT, en, de). Use plain, everyday words.
Boundaries: no medical/financial/legal advice; suggest professional help when needed.
Format: 1–3 short paragraphs OR a small checklist. End with one helpful next step.
`;

// =============== HELPERS ======================

// lingua da Telegram (en/it/de)
function detectLang(ctx) {
  const code = (ctx.from?.language_code || "en").slice(0, 2);
  if (["en", "it", "de"].includes(code)) return code;
  return "en";
}

// tastiera principale
function mainKeyboard(lang) {
  if (lang === "it") {
    return Markup.keyboard([
      [Markup.button.text("📔 Journal"), Markup.button.text("📊 Progress")],
      [Markup.button.text("📌 Coach"), Markup.button.text("⚡ SOS")],
      [Markup.button.text("🔗 Invite"), Markup.button.text("⚙️ Impostazioni")],
    ]).resize();
  }
  if (lang === "de") {
    return Markup.keyboard([
      [Markup.button.text("📔 Journal"), Markup.button.text("📊 Fortschritt")],
      [Markup.button.text("📌 Coach"), Markup.button.text("⚡ SOS")],
      [Markup.button.text("🔗 Einladen"), Markup.button.text("⚙️ Einstellungen")],
    ]).resize();
  }
  return Markup.keyboard([
    [Markup.button.text("📔 Journal"), Markup.button.text("📊 Progress")],
    [Markup.button.text("📌 Coach"), Markup.button.text("⚡ SOS")],
    [Markup.button.text("🔗 Invite"), Markup.button.text("⚙️ Settings")],
  ]).resize();
}

// testi brevi per /start
function startText(lang) {
  if (lang === "it") {
    return "Ciao 🌿 sono HITH — il tuo spazio gentile per diario, coaching e piccoli passi.\n\nCosa vuoi annotare oggi?";
  }
  if (lang === "de") {
    return "Hi 🌿 ich bin HITH – dein sanfter Raum für Tagebuch, Coaching und kleine Schritte.\n\nWorüber möchtest du heute schreiben?";
  }
  return "Hi 🌿 I’m HITH — your gentle space for journaling, coaching and tiny steps.\n\nWhat would you like to note down today?";
}

// salva / aggiorna utente
async function ensureUser(ctx) {
  const tg_id = ctx.from.id;
  const first_name = ctx.from.first_name || "";
  const lang = detectLang(ctx);

  try {
    const { data, error } = await supabase
      .from(SUPABASE_USERS_TABLE)
      .select("id")
      .eq("tg_id", tg_id)
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      const { error: insErr } = await supabase
        .from(SUPABASE_USERS_TABLE)
        .insert([{ tg_id, first_name, lang }]);
      if (insErr) throw insErr;
    } else {
      const { error: updErr } = await supabase
        .from(SUPABASE_USERS_TABLE)
        .update({ lang, first_name })
        .eq("tg_id", tg_id);
      if (updErr) throw updErr;
    }
  } catch (err) {
    console.error("[ensureUser] Supabase error:", err?.message || err);
  }
}

// salva messaggio
async function saveMessage(tg_id, role, content) {
  try {
    const { error } = await supabase
      .from(SUPABASE_MESSAGES_TABLE)
      .insert([{ tg_id, role, content }]);
    if (error) throw error;
  } catch (err) {
    console.error("[saveMessage] Supabase error:", err?.message || err);
  }
}

// recupera cronologia recente
async function getRecentHistory(tg_id, limit = 8) {
  try {
    const { data, error } = await supabase
      .from(SUPABASE_MESSAGES_TABLE)
      .select("role, content")
      .eq("tg_id", tg_id)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      console.error("[getRecentHistory] Supabase error:", error.message);
      return [];
    }
    return (data || []).reverse();
  } catch (err) {
    console.error("[getRecentHistory] Error:", err?.message || err);
    return [];
  }
}

// fetch con timeout
async function fetchWithTimeout(url, options = {}, ms = 20000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(id);
  }
}

// chiamata a OpenAI
async function askLLM(lang, history, userText) {
  const messages = [
    { role: "system", content: HITH_SYSTEM_PROMPT + `\nUser language: ${lang}` },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: userText },
  ];

  const resp = await fetchWithTimeout(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages,
        temperature: 0.5,
        max_tokens: 400,
      }),
    },
    25000
  );

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`OpenAI error ${resp.status}: ${txt}`);
  }

  const json = await resp.json();
  return json.choices?.[0]?.message?.content?.trim() || "Sono qui con te 💛";
}

// rate limit 5s per utente
const lastSeen = new Map();
function tooSoon(id) {
  const now = Date.now();
  if (lastSeen.has(id) && now - lastSeen.get(id) < 5000) return true;
  lastSeen.set(id, now);
  return false;
}

// =============== TELEGRAM HANDLERS ==============

bot.start(async (ctx) => {
  const lang = detectLang(ctx);
  await ensureUser(ctx);
  await ctx.reply(startText(lang), mainKeyboard(lang));
});

// Tutti i testi
bot.on("text", async (ctx) => {
  const text = ctx.message.text?.trim() || "";
  const tg_id = ctx.from.id;
  const lang = detectLang(ctx);

  if (text.startsWith("/start")) return;

  if (tooSoon(tg_id)) return;

  await ensureUser(ctx);
  await saveMessage(tg_id, "user", text);

  try {
    await ctx.sendChatAction("typing");

    const history = await getRecentHistory(tg_id, 8);
    const answer = await askLLM(lang, history, text);

    await saveMessage(tg_id, "assistant", answer);
    await ctx.reply(answer, mainKeyboard(lang));
  } catch (err) {
    console.error("[bot.on text] Error:", err?.message || err);
    const fallback =
      lang === "it"
        ? "Ho avuto un piccolo intoppo. Riproviamo tra poco 🌿"
        : lang === "de"
        ? "Kleiner Hänger. Versuchen wir es gleich nochmal 🌿"
        : "I hit a little hiccup. Let’s try again in a moment 🌿";
    await ctx.reply(fallback, mainKeyboard(lang));
  }
});

// NON usare bot.launch() (polling => 409)

// =============== TELEGRAM WEBHOOK ===============

// path semplice e “pulito”
const SECRET_PATH = "/tg-webhook";
const WEBHOOK_URL = `${PUBLIC_URL}${SECRET_PATH}`;

console.log("SECRET_PATH:", SECRET_PATH);
console.log("WEBHOOK_URL:", WEBHOOK_URL);

// ✅ FIX HARD: gestisci Telegram webhook via bot.handleUpdate()
// (evita mismatch Express mount-path / Telegraf expected-path)
app.post(SECRET_PATH, async (req, res) => {
  try {
    // Telegraf gestisce update e risponde quando necessario
    await bot.handleUpdate(req.body, res);
  } catch (err) {
    console.error("[tg webhook] handleUpdate error:", err?.message || err);
    // Telegram vuole 200 per non ritentare all'infinito
    res.sendStatus(200);
  }
});

// (opzionale) ping per debug
app.get(SECRET_PATH, (_req, res) => {
  res.status(200).send("OK");
});

async function setupTelegramWebhook() {
  try {
    await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook?drop_pending_updates=true`
    );

    const resp = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: WEBHOOK_URL,
          allowed_updates: ["message", "callback_query"],
        }),
      }
    );

    const json = await resp.json();
    console.log("[setWebhook]", json);
    if (!json?.ok) {
      console.error("❌ setWebhook failed details:", json);
    }
  } catch (err) {
    console.error("[setWebhook] failed:", err?.message || err);
  }
}

// =============== WHATSAPP WEBHOOK ===============

// Verifica (GET)
app.get("/whatsapp/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) {
    console.log("✅ WhatsApp webhook verified");
    return res.status(200).send(challenge);
  }
  console.warn("❌ WhatsApp webhook verification failed");
  return res.sendStatus(403);
});

// Messaggi (POST)
app.post("/whatsapp/webhook", async (req, res) => {
  try {
    const data = req.body;
    if (data.object === "whatsapp_business_account") {
      const entry = data.entry?.[0];
      const change = entry?.changes?.[0];
      const message = change?.value?.messages?.[0];

      if (message) {
        const from = message.from;
        const text = message.text?.body || "";
        console.log(`📩 WhatsApp message from ${from}: ${text}`);

        if (WHATSAPP_TOKEN && WHATSAPP_PHONE_ID) {
          await fetch(
            `https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_ID}/messages`,
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${WHATSAPP_TOKEN}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                messaging_product: "whatsapp",
                to: from,
                text: { body: `🌿 HITH: "${text}"` },
              }),
            }
          );
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ WhatsApp webhook error:", err?.message || err);
    res.sendStatus(500);
  }
});

// =============== ROUTE BASE =====================
app.get("/", (_req, res) => {
  res.status(200).send("HITH bot is running.");
});

// =============== AVVIO SERVER ===================
const server = app.listen(PORT, async () => {
  console.log(`🚀 Server listening on ${PORT}`);
  console.log(`🌍 PUBLIC_URL base: ${PUBLIC_URL}`);
  console.log(`🤖 Telegram webhook URL: ${WEBHOOK_URL}`);

  // webhook Telegram
  await setupTelegramWebhook();

  // test connessione Supabase
  try {
    const { error } = await supabase
      .from(SUPABASE_USERS_TABLE)
      .select("id", { head: true, count: "exact" });

    if (error) {
      console.error("❌ Supabase connection error:", error.message);
    } else {
      console.log("✅ Supabase connection OK");
    }
  } catch (err) {
    console.error("❌ Supabase connection error:", err?.message || err);
  }
});

// clean shutdown (Render)
function shutdown(signal) {
  console.log(`🛑 ${signal} received. Shutting down...`);
  server.close(() => process.exit(0));
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

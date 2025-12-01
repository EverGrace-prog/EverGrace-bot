import express from "express";
import fetch from "node-fetch";
import { Telegraf, Markup } from "telegraf";
import { createClient } from "@supabase/supabase-js";

// ---- ENV ----
const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_KEY;
const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_URL = process.env.PUBLIC_URL;

// Safety check
if (!BOT_TOKEN || !OPENAI_API_KEY || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing env: BOT_TOKEN / OPENAI_API_KEY / SUPABASE_URL / SUPABASE_KEY");
  process.exit(1);
}

// ---- Clients ----
const app = express();
app.use(express.json());
const bot = new Telegraf(BOT_TOKEN);
const db = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

// ---- Personality ----
const HITH_SYSTEM_PROMPT = `
You are HITH: a gentle, encouraging companion for journaling, coaching and tiny steps.
Style: warm, concise, practical. Celebrate small wins. Never overwhelm the user.
Language: mirror the user's language (it/it-IT, en, de). Use plain words.
Boundaries: no medical/financial/legal advice; suggest professional help when needed.
Format: 1–3 short paragraphs OR a small checklist. End with one helpful next step.
`;

// ---- Helpers ----
const SUGGESTIONS = (lang="en") => {
  const L = {
    en: ["Journal", "Progress", "Coach", "SOS", "Invite", "Settings"],
    it: ["Journal", "Progress", "Coach", "SOS", "Invite", "Impostazioni"],
    de: ["Journal", "Fortschritt", "Coach", "SOS", "Einladen", "Einstellungen"]
  };
  return (L[lang] || L.en).slice(0,4).map((t,i)=> Markup.button.callback(t, `sugg_${i}_${t}`));
};

const detectLang = (ctx) => {
  const lc = (ctx.from?.language_code || "en").substring(0,2);
  return (["en","it","de"].includes(lc) ? lc : "en");
};

async function ensureUser(ctx) {
  const tg_id = ctx.from.id;
  const lang = detectLang(ctx);
  const first_name = ctx.from.first_name || "";
  const { data } = await db.from("users").select("tg_id").eq("tg_id", tg_id).maybeSingle();
  if (!data) {
    await db.from("users").insert([{ tg_id, first_name, lang }]);
  } else {
    await db.from("users").update({ lang }).eq("tg_id", tg_id);
  }
}

async function saveMessage(tg_id, role, content) {
  await db.from("messages").insert([{ tg_id, role, content }]);
}

async function getRecentHistory(tg_id, limit=8) {
  const { data } = await db
    .from("messages")
    .select("role, content")
    .eq("tg_id", tg_id)
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data || []).reverse();
}

async function askLLM(lang, history, userText) {
  const msgs = [
    { role: "system", content: HITH_SYSTEM_PROMPT + `\nUser language: ${lang}` },
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: "user", content: userText }
  ];

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: msgs,
      temperature: 0.5,
      max_tokens: 400
    })
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`OpenAI error ${resp.status}: ${txt}`);
  }
  const json = await resp.json();
  return json.choices?.[0]?.message?.content?.trim() || "I’m here.";
}

// simple per-user rate limiter (5s)
const lastSeen = new Map();
function tooSoon(userId) {
  const now = Date.now();
  if (lastSeen.has(userId) && now - lastSeen.get(userId) < 5000) return true;
  lastSeen.set(userId, now);
  return false;
}

// ---- Telegram UI ----
bot.start(async (ctx) => {
  const lang = detectLang(ctx);
  await ensureUser(ctx);

  const welcome = {
    en: "Hi 🌿 I’m HITH — your gentle space for journaling, coaching and tiny steps.",
    it: "Ciao 🌿 sono HITH — il tuo spazio gentile per diario, coaching e piccoli passi.",
    de: "Hi 🌿 ich bin HITH — dein sanfter Raum für Tagebuch, Coaching und kleine Schritte."
  }[lang];

  await ctx.reply(welcome, Markup.inlineKeyboard([
    SUGGESTIONS(lang)
  ]));
});

// Suggestions act like light “modes” but just funnel into chat
bot.action(/sugg_\d+_.+/, async (ctx) => {
  const choice = ctx.match?.input?.split("_").slice(2).join("_") || "";
  await ctx.answerCbQuery();
  await ctx.reply(`→ ${choice}`);
});

// Main text handler
bot.on("text", async (ctx) => {
  const lang = detectLang(ctx);
  const tg_id = ctx.from.id;
  const text = ctx.message.text?.trim() || "";

  if (tooSoon(tg_id)) {
    return; // silently drop spammy bursts
  }

  await ensureUser(ctx);
  await saveMessage(tg_id, "user", text);

  try {
    await ctx.sendChatAction("typing");
    const history = await getRecentHistory(tg_id, 8);
    const answer = await askLLM(lang, history, text);
    await saveMessage(tg_id, "assistant", answer);

    await ctx.reply(answer, Markup.inlineKeyboard([ SUGGESTIONS(lang) ]));
  } catch (err) {
    console.error("Reply error:", err);
    const fallback = {
      en: "I hit a hiccup. Let’s try again in a moment.",
      it: "Ho avuto un intoppo. Riproviamo tra poco.",
      de: "Kleiner Hänger. Versuchen wir es gleich nochmal."
    }[lang];
    await ctx.reply(fallback);
  }
});

// ---- Webhook (keep your existing block if you already set PUBLIC_URL + SECRET_PATH) ----
const SECRET_PATH = `/tg/${BOT_TOKEN.slice(-20)}`;
app.use(SECRET_PATH, bot.webhookCallback(SECRET_PATH));

async function setupTelegramWebhook() {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook?drop_pending_updates=true`);
    const url = `${PUBLIC_URL}${SECRET_PATH}`;
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, allowed_updates: ["message","callback_query"] })
    });
    console.log("[setWebhook]", await r.json());
  } catch (e) { console.error("Webhook setup failed:", e); }
}

// ---- WhatsApp webhook you already added can stay below ----
// app.get("/whatsapp/webhook", ...)
// app.post("/whatsapp/webhook", ...)

// ---- Start ----
app.get("/", (_req, res) => res.status(200).send("OK"));
app.listen(PORT, async () => {
  console.log(`listening on ${PORT}`);
  await setupTelegramWebhook();
});

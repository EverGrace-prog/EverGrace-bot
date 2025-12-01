import express from "express";
import fetch from "node-fetch";
import { Telegraf, Markup } from "telegraf";
import { createClient } from "@supabase/supabase-js";

// ========= ENV =========
const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_KEY;
const SUPABASE_USERS_TABLE = process.env.SUPABASE_USERS_TABLE || "users";
const SUPABASE_MESSAGES_TABLE =
  process.env.SUPABASE_MESSAGES_TABLE || "messages";
const PUBLIC_URL = process.env.PUBLIC_URL;
const PORT = Number(process.env.PORT) || 10000;

// WhatsApp (opzionale)
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;

// Safety check: se manca qualcosa, meglio fermarsi
if (!BOT_TOKEN || !OPENAI_API_KEY || !SUPABASE_URL || !SUPABASE_KEY || !PUBLIC_URL) {
  console.error(
    "❌ Missing env vars. Please set BOT_TOKEN, OPENAI_API_KEY, SUPABASE_URL, SUPABASE_KEY/SUPABASE_SERVICE_ROLE, PUBLIC_URL."
  );
  process.exit(1);
}

// ========= CLIENTS =========
const app = express();
app.use(express.json());

const bot = new Telegraf(BOT_TOKEN);

const db = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

// ========= PERSONALITÀ HITH =========
const HITH_SYSTEM_PROMPT = `
You are HITH: a gentle, encouraging companion for journaling, coaching and tiny steps.
Style: warm, concise, practical. Celebrate small wins. Never overwhelm the user.
Language: mirror the user's language (Italian, English, German). Use plain words.
Boundaries: no medical/financial/legal advice; suggest professional help when needed.
Format: 1–3 short paragraphs OR a small checklist. End with one helpful next step.
`;

// ========= HELPERS =========

// Suggerimenti sotto i messaggi
const SUGGESTIONS = (lang = "en") => {
  const L = {
    en: ["Journal", "Progress", "Coach", "SOS", "Invite", "Settings"],
    it: ["Journal", "Progress", "Coach", "SOS", "Invite", "Impostazioni"],
    de: ["Journal", "Fortschritt", "Coach", "SOS", "Einladen", "Einstellungen"],
  };
  const labels = L[lang] || L.en;

  return [
    Markup.button.callback(labels[0], "sugg_journal"),
    Markup.button.callback(labels[1], "sugg_progress"),
    Markup.button.callback(labels[2], "sugg_coach"),
    Markup.button.callback(labels[3], "sugg_sos"),
  ];
};

const detectLang = (ctx) => {
  const lc = (ctx.from?.language_code || "en").slice(0, 2);
  if (["en", "it", "de"].includes(lc)) return lc;
  return "en";
};

// Crea/aggiorna utente in Supabase
async function ensureUser(ctx) {
  const tg_id = ctx.from.id;
  const lang = detectLang(ctx);
  const first_name = ctx.from.first_name || "";

  const { data, error } = await db
    .from(SUPABASE_USERS_TABLE)
    .select("tg_id")
    .eq("tg_id", tg_id)
    .maybeSingle();

  if (error) {
    console.error("[ensureUser] select error:", error.message);
    return;
  }

  if (!data) {
    const { error: insErr } = await db
      .from(SUPABASE_USERS_TABLE)
      .insert([{ tg_id, first_name, lang }]);
    if (insErr) console.error("[ensureUser] insert error:", insErr.message);
  } else {
    const { error: updErr } = await db
      .from(SUPABASE_USERS_TABLE)
      .update({ lang })
      .eq("tg_id", tg_id);
    if (updErr) console.error("[ensureUser] update error:", updErr.message);
  }
}

// Salva un messaggio (user o assistant)
async function saveMessage(tg_id, role, content) {
  const { error } = await db.from(SUPABASE_MESSAGES_TABLE).insert([
    {
      tg_id,
      role,
      content,
    },
  ]);
  if (error) console.error("[saveMessage] error:", error.message);
}

// Recupera la storia recente per dare contesto a HITH
async function getRecentHistory(tg_id, limit = 10) {
  const { data, error } = await db
    .from(SUPABASE_MESSAGES_TABLE)
    .select("role, content")
    .eq("tg_id", tg_id)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("[getRecentHistory] error:", error.message);
    return [];
  }

  return (data || []).reverse();
}

// Chiamata a OpenAI
async function askLLM(lang, history, userText) {
  const messages = [
    {
      role: "system",
      content: `${HITH_SYSTEM_PROMPT}\nUser language: ${lang}`,
    },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: userText },
  ];

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
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
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`OpenAI error ${resp.status}: ${txt}`);
  }

  const json = await resp.json();
  return json.choices?.[0]?.message?.content?.trim() || "Sono qui con te. 💛";
}

// Rate limiter base: massimo 1 messaggio ogni 5s
const lastSeen = new Map();
function tooSoon(userId) {
  const now = Date.now();
  const prev = lastSeen.get(userId) || 0;
  if (now - prev < 5000) return true;
  lastSeen.set(userId, now);
  return false;
}

// ========= TELEGRAM HANDLERS =========

// /start
bot.start(async (ctx) => {
  const lang = detectLang(ctx);
  await ensureUser(ctx);

  const text =
    {
      it: "Ciao 🌿 sono HITH — il tuo spazio gentile per diario, coaching e piccoli passi.",
      en: "Hi 🌿 I’m HITH — your gentle space for journaling, coaching and tiny steps.",
      de: "Hi 🌿 ich bin HITH — dein sanfter Raum für Tagebuch, Coaching und kleine Schritte.",
    }[lang] || "Hi 🌿 I’m HITH.";

  await ctx.reply(
    text,
    Markup.inlineKeyboard([SUGGESTIONS(lang)], { columns: 4 })
  );
});

// Pulsanti suggeriti (non cambiano stato, servono solo come scorciatoie)
bot.action(/sugg_.+/, async (ctx) => {
  const id = ctx.callbackQuery.data;
  await ctx.answerCbQuery();

  const label =
    id === "sugg_journal"
      ? "Journal"
      : id === "sugg_progress"
      ? "Progress"
      : id === "sugg_coach"
      ? "Coach"
      : "SOS";

  await ctx.reply(`→ ${label}`);
});

// Messaggi testuali
bot.on("text", async (ctx) => {
  const tg_id = ctx.from.id;
  const lang = detectLang(ctx);
  const text = ctx.message.text?.trim() || "";

  if (!text) return;
  if (tooSoon(tg_id)) return;

  await ensureUser(ctx);
  await saveMessage(tg_id, "user", text);

  try {
    await ctx.sendChatAction("typing");

    const history = await getRecentHistory(tg_id, 10);
    const answer = await askLLM(lang, history, text);

    await saveMessage(tg_id, "assistant", answer);

    await ctx.reply(
      answer,
      Markup.inlineKeyboard([SUGGESTIONS(lang)], { columns: 4 })
    );
  } catch (err) {
    console.error("Reply error:", err);
    const fallback =
      {
        it: "Ho avuto un piccolo intoppo. Riproviamo tra poco. 💛",
        en: "I hit a small hiccup. Let’s try again in a moment. 💛",
        de: "Kleiner Hänger. Versuchen wir es gleich nochmal. 💛",
      }[lang] || "Something went wrong, let’s try again in a moment. 💛";
    await ctx.reply(fallback);
  }
});

// Safety: se Telegraf prova a fare polling e Telegram risponde 409, esci
bot.catch((err) => {
  if (err?.response?.error_code === 409) {
    console.error(
      "⚠️ Telegram 409 conflict (another getUpdates). Exiting to avoid duplicate bot."
    );
    process.exit(0);
  }
  console.error("Bot error:", err);
});

// =============== TELEGRAM WEBHOOK ===============

// path semplice
const SECRET_PATH = "/tg-webhook";
const WEBHOOK_URL = `${PUBLIC_URL}${SECRET_PATH}`;
console.log("SECRET_PATH:", SECRET_PATH);
console.log("WEBHOOK_URL:", WEBHOOK_URL);

// Telegraf gestisce le POST su questo path
app.use(SECRET_PATH, bot.webhookCallback(SECRET_PATH));


async function setupTelegramWebhook() {
  try {
    // cancella eventuale webhook precedente
    await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook?drop_pending_updates=true`
    );

    const url = `${PUBLIC_URL}${SECRET_PATH}`;
    const resp = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          allowed_updates: ["message", "callback_query"],
        }),
      }
    );

    const json = await resp.json();
    console.log("[setWebhook]", json);
  } catch (e) {
    console.error("Telegram webhook setup failed:", e);
  }
}

// ========= WHATSAPP WEBHOOK (ECHO DI TEST) =========

// Verifica (GET) per Meta
app.get("/whatsapp/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) {
    console.log("✅ WhatsApp webhook verified");
    return res.status(200).send(challenge);
  }

  console.warn("❌ WhatsApp verification failed");
  return res.sendStatus(403);
});

// Ricezione messaggi (POST)
app.post("/whatsapp/webhook", async (req, res) => {
  try {
    const body = req.body;

    if (body.object === "whatsapp_business_account") {
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const message = changes?.value?.messages?.[0];

      if (message && WHATSAPP_TOKEN && WHATSAPP_PHONE_ID) {
        const from = message.from;
        const text = message.text?.body || "";

        console.log(`📩 WhatsApp from ${from}: ${text}`);

        // Semplice eco di test
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

    res.sendStatus(200);
  } catch (e) {
    console.error("WhatsApp webhook error:", e);
    res.sendStatus(500);
  }
});

// ========= ROOT =========
app.get("/", (_req, res) => {
  res.status(200).send("HITH bot is running 🌿");
});

// ========= START SERVER =========
app.listen(PORT, async () => {
  console.log(`🚀 listening on ${PORT}`);
  console.log(`🌍 PUBLIC_URL: ${PUBLIC_URL}`);
  await setupTelegramWebhook();

  // test connessione Supabase
  try {
    const { error } = await db
      .from(SUPABASE_USERS_TABLE)
      .select("tg_id", { head: true, count: "exact" })
      .limit(1);
    if (error) {
      console.error("❌ Supabase connection error:", error.message);
    } else {
      console.log("✅ Supabase connection OK");
    }
  } catch (e) {
    console.error("Supabase test failed:", e);
  }
});

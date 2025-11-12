// index.js
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

const SUPABASE_USERS_TABLE =
  process.env.SUPABASE_USERS_TABLE || "users";
const SUPABASE_MESSAGES_TABLE =
  process.env.SUPABASE_MESSAGES_TABLE || "messages";

const PUBLIC_URL = process.env.PUBLIC_URL;
const PORT = Number(process.env.PORT) || 10000;

// WhatsApp (opzionale ma già pronto)
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;

// ---- safety check env ----
if (!BOT_TOKEN || !OPENAI_API_KEY || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error(
    "[FATAL] Missing env: BOT_TOKEN / OPENAI_API_KEY / SUPABASE_URL / SUPABASE_KEY"
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

// ========= HITH PERSONALITY =========
const HITH_SYSTEM_PROMPT = `
You are HITH: a gentle, encouraging companion for journaling, coaching and tiny steps.
Style: warm, concise, practical. Celebrate small wins. Never overwhelm the user.
Tone: soft, gentle, emotional, never robotic.
You reflect feelings, ask small follow-up questions, and help the user understand themselves.
Language: mirror the user's language (it, en, de). Use plain words.
Boundaries: no medical/financial/legal advice; suggest professional help when needed.
Format: 1–3 short paragraphs OR a small checklist. End with one helpful next step.
`;

// ========= HELPERS =========
const SUGGESTIONS = (lang = "en") => {
  const L = {
    en: ["Journal", "Progress", "Coach", "SOS", "Invite", "Settings"],
    it: ["Journal", "Progress", "Coach", "SOS", "Invite", "Impostazioni"],
    de: ["Journal", "Fortschritt", "Coach", "SOS", "Einladen", "Einstellungen"],
  };
  return (L[lang] || L.en)
    .slice(0, 4)
    .map((t, i) => Markup.button.callback(t, `sugg_${i}_${t}`));
};

const detectLang = (ctx) => {
  const lc = (ctx.from?.language_code || "en").substring(0, 2);
  return ["en", "it", "de"].includes(lc) ? lc : "en";
};

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

async function saveMessage(tg_id, role, content) {
  const { error } = await db
    .from(SUPABASE_MESSAGES_TABLE)
    .insert([{ tg_id, role, content }]);
  if (error) console.error("[saveMessage] error:", error.message);
}

async function getRecentHistory(tg_id, limit = 8) {
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

async function askLLM(lang, history, userText) {
  const msgs = [
    { role: "system", content: HITH_SYSTEM_PROMPT + `\nUser language: ${lang}` },
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
      messages: msgs,
      temperature: 0.5,
      max_tokens: 400,
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`OpenAI error ${resp.status}: ${txt}`);
  }

  const json = await resp.json();
  return json.choices?.[0]?.message?.content?.trim();
}

// rate-limit semplice: 5s per utente
const lastSeen = new Map();
function tooSoon(userId) {
  const now = Date.now();
  if (lastSeen.has(userId) && now - lastSeen.get(userId) < 5000) return true;
  lastSeen.set(userId, now);
  return false;
}

// ========= TELEGRAM UI =========

// /start
bot.start(async (ctx) => {
  const lang = detectLang(ctx);
  await ensureUser(ctx);

  const welcome = {
    en: "Hi 🌿 I’m HITH — your gentle space for journaling, coaching and tiny steps.",
    it: "Ciao 🌿 sono HITH — il tuo spazio gentile per diario, coaching e piccoli passi.",
    de: "Hi 🌿 ich bin HITH — dein sanfter Raum für Tagebuch, Coaching und kleine Schritte.",
  }[lang];

  await ctx.reply(
    welcome,
    Markup.inlineKeyboard([SUGGESTIONS(lang)])
  );
});

// click sui bottoni suggeriti (light mode)
bot.action(/sugg_\d+_.+/, async (ctx) => {
  const choice = ctx.match?.input?.split("_").slice(2).join("_") || "";
  await ctx.answerCbQuery();
  await ctx.reply(`→ ${choice}`);
});

// handler principale del testo (LLM + Supabase)
bot.on("text", async (ctx) => {
  const lang = detectLang(ctx);
  const tg_id = ctx.from.id;
  const text = (ctx.message.text || "").trim();

  if (!text) return;
  if (tooSoon(tg_id)) return;

  await ensureUser(ctx);

  // salva messaggio utente
  try {
    await saveMessage(tg_id, "user", text);
  } catch (err) {
    console.error("❌ Supabase error (user msg):", err);
  }

  // fallback caldo
  let aiReply =
    lang === "it"
      ? "Non so cosa dire… ma sono qui con te 💛"
      : lang === "de"
      ? "Ich weiß gerade nicht, was ich sagen soll… aber ich bin bei dir 💛"
      : "I’m not sure what to say… but I’m here with you 💛";

  try {
    await ctx.sendChatAction("typing");
    const history = await getRecentHistory(tg_id, 8);
    const llmText = await askLLM(lang, history, text);
    if (llmText) aiReply = llmText;

    try {
      await saveMessage(tg_id, "assistant", aiReply);
    } catch (err) {
      console.error("❌ Supabase error (assistant msg):", err);
    }

    await ctx.reply(aiReply, Markup.inlineKeyboard([SUGGESTIONS(lang)]));
  } catch (err) {
    console.error("❌ LLM error:", err);
    const fallback = {
      en: "I hit a hiccup. Let’s try again in a moment.",
      it: "Ho avuto un intoppo. Riproviamo tra poco.",
      de: "Kleiner Hänger. Versuchen wir es gleich nochmal.",
    }[lang];
    await ctx.reply(fallback);
  }
});

// safety: niente 409 – se mai arriva comunque, logghiamo e basta
bot.catch((err) => {
  if (err?.response?.error_code === 409) {
    console.error("⚠️ 409 from Telegram (getUpdates conflict). Webhook should avoid this.", err);
  } else {
    console.error("Bot error:", err);
  }
});

// ========= TELEGRAM WEBHOOK =========
const SECRET_PATH = `/tg/${BOT_TOKEN.slice(-20)}`;
app.use(SECRET_PATH, bot.webhookCallback(SECRET_PATH));

async function setupTelegramWebhook() {
  if (!PUBLIC_URL) {
    console.warn("[Webhook] PUBLIC_URL not set, skipping Telegram webhook setup.");
    return;
  }
  try {
    await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook?drop_pending_updates=true`
    );

    const url = `${PUBLIC_URL}${SECRET_PATH}`;
    const r = await fetch(
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
    console.log("[setWebhook]", await r.json());
  } catch (e) {
    console.error("Webhook setup failed:", e);
  }
}

// ========= WHATSAPP WEBHOOK (Cloud API) =========

// GET verify
app.get("/whatsapp/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) {
    console.log("✅ WhatsApp webhook verified");
    return res.status(200).send(challenge);
  } else {
    console.warn("❌ WhatsApp webhook verification failed");
    return res.sendStatus(403);
  }
});

// POST messages
app.post("/whatsapp/webhook", async (req, res) => {
  try {
    const data = req.body;

    if (data.object === "whatsapp_business_account") {
      const entry = data.entry?.[0];
      const changes = entry?.changes?.[0];
      const message = changes?.value?.messages?.[0];

      if (message && WHATSAPP_TOKEN && WHATSAPP_PHONE_ID) {
        const from = message.from;
        const text = message.text?.body || "";

        console.log(`📩 WhatsApp message from ${from}: ${text}`);

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
              text: { body: `🌿 HITH reply: "${text}"` },
            }),
          }
        );
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ WhatsApp webhook error:", err);
    res.sendStatus(500);
  }
});

// ========= ROOT & START =========
app.get("/", (_req, res) => {
  res.status(200).send("HITH bot is alive 🌿");
});

app.listen(PORT, async () => {
  console.log(`🚀 listening on ${PORT}`);
  await setupTelegramWebhook();

  // quick Supabase check
  try {
    const { error } = await db
      .from(SUPABASE_USERS_TABLE)
      .select("count", { head: true });
    if (error) {
      console.error("❌ Supabase connection failed:", error.message);
    } else {
      console.log("✅ Supabase connection OK");
    }
  } catch (e) {
    console.error("❌ Supabase runtime error:", e);
  }
});

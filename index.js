// index.js — HITH bot: Telegram (polling) + Supabase + OpenAI + WhatsApp

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

const PUBLIC_URL = process.env.PUBLIC_URL || "";

// WhatsApp (opzionale)
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;

// Porta (Render fornisce process.env.PORT)
const PORT = process.env.PORT || 3000;

// --- Controllo env critici ---
if (!BOT_TOKEN) {
  console.error("❌ Missing BOT_TOKEN");
  process.exit(1);
}
if (!OPENAI_API_KEY) {
  console.error("❌ Missing OPENAI_API_KEY");
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ Missing Supabase config: SUPABASE_URL / SUPABASE_KEY");
  process.exit(1);
}

// =============== CLIENTS ==============
const app = express();
app.use(express.json());

const bot = new Telegraf(BOT_TOKEN);

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

// =============== HITH PERSONALITY ==============
const HITH_SYSTEM_PROMPT = `
You are HITH: a gentle, encouraging companion for journaling, coaching and tiny steps.

Tone:
- warm, human, like a kind friend
- never like a teacher, guru or therapist
- no lectures, no long explanations

Language:
- mirror the user's language (it/it-IT, en, de)
- use plain, everyday words

Style:
- keep answers SHORT (max 5–7 lines of chat)
- avoid numbered lists and bullet lists unless the user explicitly asks for "ideas" or "list"
- if the user asks for ideas, give at most 3 short bullets, each max one short sentence
- prefer 1–3 short paragraphs or a tiny checklist

Boundaries:
- no medical, financial or legal advice
- when topics are heavy or clinical, gently suggest talking to a professional

Always end with:
- either ONE gentle next step
- or ONE short question to help the user reflect a bit more.
`;

const COACH_MODES = {
  friend: "FRIEND",
  spiritual: "SPIRITUAL_GUIDE",
  goal: "COACH_GOAL",
};

const MODE_PROMPTS = {
  [COACH_MODES.friend]: `
You are HITH in Friend Mode.
Speak like a warm, calm friend who listens without pressure.
Use simple, everyday words. Be human, gentle, supportive.
Stay short and real. One helpful thought or question is enough.
Never sound like a coach or teacher.
End with a soft, friendly question or a tiny encouragement.
`,

  [COACH_MODES.spiritual]: `
You are HITH in Spiritual Guide Mode.
Speak slowly, softly, with a peaceful tone.
Use light imagery (breath, presence, inner clarity) but never be mystical or exaggerated.
Help the user feel grounded and centred.
Keep your response short and calming.
End with a reflective question or a mindful suggestion.
`,

  [COACH_MODES.goal]: `
You are HITH in Coach & Goal Mode.
Be clear, practical and motivating, but still gentle.
Focus on small achievable steps and realistic goals.
Ask clarifying questions if needed.
Offer one simple next action, no long explanations.
End with a concrete, realistic next step or a tiny challenge.
`,
};
// modalità coach scelta per utente (solo in memoria, ok per test)
const coachModeByUser = new Map();
const DEFAULT_MODE = COACH_MODES.friend;



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
  // default EN
  return Markup.keyboard([
    [Markup.button.text("📔 Journal"), Markup.button.text("📊 Progress")],
    [Markup.button.text("📌 Coach"), Markup.button.text("⚡ SOS")],
    [Markup.button.text("🔗 Invite"), Markup.button.text("⚙️ Settings")],
  ]).resize();
}
function coachModeKeyboard(lang) {
  // i testi li teniamo in IT anche se l'utente è EN/DE — è il tuo bot :)
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("🧑‍🤝‍🧑 Amico", "mode_friend"),
    ],
    [
      Markup.button.callback("✨ Guida spirituale", "mode_spiritual"),
    ],
    [
      Markup.button.callback("🎯 Coach & Goal", "mode_goal"),
    ],
  ]);
}

function coachModeIntroText(lang) {
  if (lang === "it") {
    return (
      "Scegli come vuoi che HITH ti accompagni oggi:\n\n" +
      "🧑‍🤝‍🧑 *Amico* — ascolta, consola, ti fa una domanda alla volta.\n" +
      "✨ *Guida spirituale* — tono calmo, ti aiuta a centrarti e ascoltarti.\n" +
      "🎯 *Coach & Goal* — ti aiuta su obiettivi e piccoli passi concreti.\n\n" +
      "Quando hai scelto, scrivimi cosa ti gira in testa o cosa vorresti cambiare. 🌿"
    );
  }
  if (lang === "de") {
    return (
      "Wähle, wie HITH dich heute begleiten soll:\n\n" +
      "🧑‍🤝‍🧑 *Freund* – hört zu, stellt eine Frage nach der anderen.\n" +
      "✨ *Spiritueller Guide* – ruhiger Ton, hilft dir, dich zu zentrieren.\n" +
      "🎯 *Coach & Goal* – hilft dir mit Zielen und kleinen konkreten Schritten. 🌿"
    );
  }
  return (
    "Choose how you want HITH to support you today:\n\n" +
    "🧑‍🤝‍🧑 *Friend* – listens, comforts, asks one question at a time.\n" +
    "✨ *Spiritual Guide* – calm tone, helps you centre and listen within.\n" +
    "🎯 *Coach & Goal* – helps with goals and tiny practical steps. 🌿"
  );
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
// ==== MODALITÀ HITH ====

const COACH_MODES = {
  friend: "🧑‍🤝‍🧑 Amico",
  spiritual: "✨ Guida spirituale",
  goals: "🎯 Coach & Goal",
};

const MODE_PROMPTS = {
  friend: "Sei l'Amico: caldo, semplice, empatico, 0 giudizio. Parli come qualcuno che ascolta davvero.",
  spiritual: "Sei la Guida spirituale: parole calme, profonde, luminose. Evita religioni specifiche.",
  goals: "Sei il Coach & Goal: concreto, pratico, chiaro. Sempre un piccolo passo finale.",
};

// Memoria in RAM (non ancora Supabase)
let coachModeByUser = {};

function coachModeKeyboard() {
  return Markup.keyboard([
    [COACH_MODES.friend],
    [COACH_MODES.spiritual],
    [COACH_MODES.goals],
  ])
    .oneTime()
    .resize();
}

// Messaggio iniziale della scelta modalità
function coachModeIntroText() {
  return (
    "Scegli la modalità con cui vuoi che HITH ti accompagni:\n\n" +
    "🧑‍🤝‍🧑 Amico – empatico, semplice, accogliente\n" +
    "✨ Guida spirituale – calma, luminosa, riflessiva\n" +
    "🎯 Coach & Goal – concreta, orientata ai piccoli passi"
  );
}

// salva / aggiorna utente
async function ensureUser(ctx) {
  const tg_id = ctx.from.id;
  const first_name = ctx.from.first_name || "";
  const lang = detectLang(ctx);

  try {
    const { data } = await supabase
      .from(SUPABASE_USERS_TABLE)
      .select("id")
      .eq("tg_id", tg_id)
      .maybeSingle();

    if (!data) {
      await supabase.from(SUPABASE_USERS_TABLE).insert([
        { tg_id, first_name, lang },
      ]);
    } else {
      await supabase
        .from(SUPABASE_USERS_TABLE)
        .update({ lang, first_name })
        .eq("tg_id", tg_id);
    }
  } catch (err) {
    console.error("[ensureUser] Supabase error:", err.message || err);
  }
}

// salva messaggio
async function saveMessage(tg_id, role, content) {
  try {
    await supabase
      .from(SUPABASE_MESSAGES_TABLE)
      .insert([{ tg_id, role, content }]);
  } catch (err) {
    console.error("[saveMessage] Supabase error:", err.message || err);
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
    console.error("[getRecentHistory] Error:", err.message || err);
    return [];
  }
}

// chiamata a OpenAI
async function askLLM(lang, history, userText, mode = DEFAULT_MODE) {
  const modePrompt = MODE_PROMPTS[mode] || MODE_PROMPTS[DEFAULT_MODE];

  const messages = [
    {
      role: "system",
      content: HITH_SYSTEM_PROMPT + `\nUser language: ${lang}`,
    },
    {
      role: "system",
      content: modePrompt,
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
  temperature: 0.4,
  max_tokens: 220,
}),

  });

  if (!resp.ok) {
    const txt = await resp.text();
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
// =============== TELEGRAM COACH MODES ===============
bot.hears(COACH_MODES.friend, (ctx) => {
  coachModeByUser[ctx.from.id] = "friend";
  ctx.reply("Modalità impostata: 🧑‍🤝‍🧑 Amico.\n\nScrivi pure: ti ascolto.");
});

bot.hears(COACH_MODES.spiritual, (ctx) => {
  coachModeByUser[ctx.from.id] = "spiritual";
  ctx.reply("Modalità impostata: ✨ Guida spirituale.\n\nQuando vuoi, sono con te.");
});

bot.hears(COACH_MODES.goals, (ctx) => {
  coachModeByUser[ctx.from.id] = "goals";
  ctx.reply("Modalità impostata: 🎯 Coach & Goal.\n\nPronti per un piccolo passo?");
});

bot.action("mode_friend", async (ctx) => {
  const lang = detectLang(ctx);
  coachModeByUser.set(ctx.from.id, COACH_MODES.friend);
  await ctx.answerCbQuery("Modalità Amico attiva 🌿");
  await ctx.reply(
    lang === "it"
      ? "Da ora ti rispondo come un buon amico: semplice, vicino, senza giudizio. Scrivimi cosa ti gira in testa. 🌿"
      : lang === "de"
      ? "Ich antworte dir jetzt als gute Freundin – einfach, nah, ohne Urteil. Schreib mir, was dir im Kopf herumgeht. 🌿"
      : "From now on I’ll answer like a good friend: simple, close, no judgement. Tell me what’s on your mind. 🌿",
    mainKeyboard(lang)
  );
});

bot.action("mode_spiritual", async (ctx) => {
  const lang = detectLang(ctx);
  coachModeByUser.set(ctx.from.id, COACH_MODES.spiritual);
  await ctx.answerCbQuery("Guida spirituale attiva ✨");
  await ctx.reply(
    lang === "it"
      ? "Da ora ti rispondo come una guida spirituale calma: poche parole, respiro, centratura. Quando vuoi, raccontami da dove partiamo. ✨"
      : lang === "de"
      ? "Ich antworte dir jetzt wie ein ruhiger spiritueller Guide: wenige Worte, Atem, Zentrierung. Erzähl mir, wo wir anfangen sollen. ✨"
      : "From now on I’ll answer like a calm spiritual guide: few words, breath, centring. When you’re ready, tell me where we start. ✨",
    mainKeyboard(lang)
  );
});

bot.action("mode_goal", async (ctx) => {
  const lang = detectLang(ctx);
  coachModeByUser.set(ctx.from.id, COACH_MODES.goal);
  await ctx.answerCbQuery("Coach & Goal attivo 🎯");
  await ctx.reply(
    lang === "it"
      ? "Da ora ti rispondo in modalità Coach & Goal: chiaro, gentile, con passi piccoli e concreti. Dimmi su quale obiettivo vuoi lavorare. 🎯"
      : lang === "de"
      ? "Ich antworte dir jetzt im Coach-&-Goal-Modus: klar, sanft, mit kleinen konkreten Schritten. Sag mir, an welchem Ziel du arbeiten möchtest. 🎯"
      : "From now on I’ll answer in Coach & Goal mode: clear, gentle, with small concrete steps. Tell me which goal you want to work on. 🎯",
    mainKeyboard(lang)
  );
});
bot.command("start", async (ctx) => {
  coachModeByUser[ctx.from.id] = "friend"; // default
  ctx.reply(
    "Ciao 🌿 sono HITH — il tuo spazio gentile per diario, coaching e piccoli passi.\n\n" +
      "Scegli la modalità:",
    coachModeKeyboard()
  );
});

// Tutti i testi
bot.on("text", async (ctx) => {
  const userId = ctx.from.id;

  // se scrive "Coach", mostra le modalità
  if (ctx.message.text === "📌 Coach") {
    return ctx.reply(coachModeIntroText(), coachModeKeyboard());
  }

  const mode = coachModeByUser[userId] || "friend";
  const systemPrompt = MODE_PROMPTS[mode];

  const answer = await askLLM({
    system: systemPrompt,
    user: ctx.message.text,
  });

  ctx.reply(answer);
});


  // /start viene già gestito sopra
  if (text.startsWith("/start")) return;
  // Se l'utente preme il pulsante Coach, apri le 3 modalità
  const plain = text.toLowerCase();

  if (text === "📌 Coach" || plain === "coach" || plain === "coach & goal") {
    await ensureUser(ctx);
    await ctx.replyWithMarkdown(coachModeIntroText(lang), coachModeKeyboard(lang));
    return;
  }

  if (tooSoon(tg_id)) {
    return; // silenzio: niente spam
  }

  await ensureUser(ctx);
  await saveMessage(tg_id, "user", text);

  try {
    await ctx.sendChatAction("typing");

    const history = await getRecentHistory(tg_id, 8);
    const answer = await askLLM(lang, history, text);

    await saveMessage(tg_id, "assistant", answer);
    await ctx.reply(answer, mainKeyboard(lang));
  } catch (err) {
    console.error("[bot.on text] Error:", err.message || err);
    const fallback =
      lang === "it"
        ? "Ho avuto un piccolo intoppo. Riproviamo tra poco 🌿"
        : lang === "de"
        ? "Kleiner Hänger. Versuchen wir es gleich nochmal 🌿"
        : "I hit a little hiccup. Let’s try again in a moment 🌿";
    await ctx.reply(fallback, mainKeyboard(lang));
  }
});

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
    console.error("❌ WhatsApp webhook error:", err.message || err);
    res.sendStatus(500);
  }
});

// =============== ROUTE BASE =====================
app.get("/", (_req, res) => {
  res.status(200).send("HITH bot is running 🌿");
});

// =============== AVVIO SERVER ===================
app.listen(PORT, async () => {
  console.log(`🚀 Server listening on ${PORT}`);
  if (PUBLIC_URL) {
    console.log(`🌍 PUBLIC_URL base: ${PUBLIC_URL}`);
  }

  // Telegram in POLLING (niente webhook)
  try {
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    await bot.launch();
    console.log("🤖 Telegram bot launched in polling mode");
  } catch (err) {
    console.error("❌ Telegram polling start error:", err.message || err);
  }

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
    console.error("❌ Supabase connection error:", err.message || err);
  }
});

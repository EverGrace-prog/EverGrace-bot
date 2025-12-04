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

const COACH_MODES = {
  friend: {
    title: "👫 Amico",
    prompt: "Da ora ti rispondo come un buon amico: semplice, vicino, senza giudizio. Scrivimi cosa ti gira in testa. 🌿",
  },
  spiritual: {
    title: "✨ Guida spirituale",
    prompt: "Sarò la tua guida spirituale: calma, centrata, luminosa. Parla, e io ti accompagno a guardarti dentro. ✨",
  },
  coach: {
    title: "🎯 Coach & Goal",
    prompt: "Da ora sono il tuo coach: diretto ma gentile. Andiamo verso un obiettivo, un passo alla volta. 🎯",
  }
};


const MODE_PROMPTS = {
  [COACH_MODES.friend]: `
You are HITH in Friend mode (🧑‍🤝‍🧑 Amico).
Imagine you are chatting on WhatsApp with someone you care about.
Be simple, close and relaxed. 
Use 1–3 short sentences, like a voice in their pocket.
Focus on listening and reflecting more than giving advice.
You can use small emojis (🌿💚✨) but not every sentence.
End with either a tiny encouragement or a very short, natural question (like a friend would ask).
`,

  [COACH_MODES.spiritual]: `
You are HITH in Spiritual Guide mode (✨ Guida spirituale).
Your words should feel like a calm pause in the day.
Use very few words, 1–3 short sentences, with soft images (breath, light, space, roots).
No preaching, no big theories.
Gently invite the user to look inside or slow down.
End with a soft question like "Cosa senti più forte adesso?" or a tiny mindful step.
`,

  [COACH_MODES.goal]: `
You are HITH in Coach & Goal mode (🎯 Coach & Goal).
Still sound like a friend on WhatsApp, not a strict coach.
Use 2 short sentences:
- first: acknowledge what the user said,
- second: propose ONE realistic, tiny step or ask ONE focused question that moves things forward.
Never give more than one step at a time.
Do not list options unless the user specifically asks for "ideas".
Keep everything small, doable and kind.
`,
};

const coachModeByUser = new Map();
const DEFAULT_MODE = COACH_MODES.friend;
// Modalità utente: "chat" (default) o "journal" (solo scrittura, nessuna risposta AI)
const USER_MODES = {
  chat: "chat",
  journal: "journal",
};

// memoria in RAM per la modalità corrente di ogni utente
const userModeById = new Map();



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
      .in("role", ["user", "assistant"]) // <-- esclude "journal"
      .order("created_at", { ascending: false })
      .limit(limit);
    ...


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
  max_tokens: 160, // prima erano 400
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
function journalIntroText(lang) {
  if (lang === "it") {
    return (
      "📔 Modalità Journal aperta.\n\n" +
      "Scrivi liberamente quello che senti o che vuoi ricordare.\n" +
      "Io salvo in silenzio, senza interromperti.\n\n" +
      "Quando vuoi tornare a parlare con me, tocca 📌 Coach, 📊 Progress oppure usa /start. 🌿"
    );
  }
  if (lang === "de") {
    return (
      "📔 Journal-Modus geöffnet.\n\n" +
      "Schreib frei, was du fühlst oder festhalten möchtest.\n" +
      "Ich speichere still mit, ohne dich zu unterbrechen.\n\n" +
      "Wenn du wieder mit mir reden möchtest, tippe auf 📌 Coach, 📊 Fortschritt oder /start. 🌿"
    );
  }
  return (
    "📔 Journal mode is open.\n\n" +
    "Write freely whatever you feel or want to remember.\n" +
    "I’ll quietly save it without interrupting you.\n\n" +
    "When you want me to talk again, tap 📌 Coach, 📊 Progress or use /start. 🌿"
  );
}

// =============== TELEGRAM HANDLERS ==============
bot.start(async (ctx) => {
  const lang = detectLang(ctx);
  await ensureUser(ctx);
  userModeById.set(ctx.from.id, USER_MODES.chat); // torna in modalità chat
  await ctx.reply(startText(lang), mainKeyboard(lang));
});

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
  const text = ctx.message.text?.trim() || "";
  const tg_id = ctx.from.id;
  const lang = detectLang(ctx);

  // /start viene già gestito sopra
  if (text.startsWith("/start")) return;

  // modalità corrente (di default "chat")
  const currentMode = userModeById.get(tg_id) || USER_MODES.chat;

  // 1) Se l'utente tocca "📔 Journal" → entra in modalità journal
  if (text === "📔 Journal") {
    userModeById.set(tg_id, USER_MODES.journal);
    await ensureUser(ctx);
    await ctx.reply(journalIntroText(lang), mainKeyboard(lang));
    return;
  }

  // 2) Se l'utente tocca Coach / Progress / Settings → torniamo in "chat"
  if (
    text === "📌 Coach" ||
    text === "📊 Progress" ||
    text === "⚙️ Impostazioni" ||
    text === "⚙️ Einstellungen" ||
    text === "⚙️ Settings"
  ) {
    userModeById.set(tg_id, USER_MODES.chat);
    // qui lasciamo che il resto dell'handler prosegua (risposta AI)
  }

  // 3) Se siamo in modalità JOURNAL:
  //    - salviamo il testo
  //    - NON applichiamo rate limit
  //    - NON chiamiamo l'AI
  if (userModeById.get(tg_id) === USER_MODES.journal) {
    await ensureUser(ctx);
    await saveMessage(tg_id, "journal", text); // ruolo diverso, così distinguiamo
    return; // nessuna risposta del bot
  }

  // 4) Da qui in poi: modalità CHAT normale → usiamo rate limit + AI
  if (tooSoon(tg_id)) {
    return; // per evitare spam quando non è journal
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

// index.js — HITH bot (Telegram + Supabase + OpenAI + Webhooks + Journal WebApp)
// ✅ Fixes included:
// - Telegram webhook route FIX (bot was silent)
// - Menu buttons DO NOT go to AI (they open submenus / web pages)
// - "Lock friend mode." command persists (Supabase prefs)
// - Friend mode: no therapy-nag, questions only if relevant, light emoji mirroring (max 1)
// - Language mirrors user message + can be set via Settings (IT/EN/DE)
// - Journal opens a real page: write / save / share / print + history (Supabase)
// - Safety: never promises secrecy

import express from "express";
import fetch from "node-fetch";
import { Telegraf, Markup } from "telegraf";
import { createClient } from "@supabase/supabase-js";

// ================== ENV ==================
const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_KEY;

const SUPABASE_USERS_TABLE =
  process.env.SUPABASE_USERS_TABLE || process.env.SUPABASE_TABLE || "users";
const SUPABASE_MESSAGES_TABLE =
  process.env.SUPABASE_MESSAGES_TABLE || "messages";
const SUPABASE_PREFS_TABLE = process.env.SUPABASE_PREFS_TABLE || "hith_prefs";
const SUPABASE_JOURNAL_TABLE =
  process.env.SUPABASE_JOURNAL_TABLE || "hith_journals";

// PUBLIC_URL (Render) or WEBHOOK_DOMAIN
const RAW_PUBLIC_URL =
  process.env.PUBLIC_URL || process.env.WEBHOOK_DOMAIN || "";

// WhatsApp (optional)
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;

const PORT = Number(process.env.PORT) || 10000;

// --- Critical env checks ---
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
if (!RAW_PUBLIC_URL) {
  console.error("❌ Missing PUBLIC_URL (or WEBHOOK_DOMAIN).");
  process.exit(1);
}

const PUBLIC_URL = RAW_PUBLIC_URL.trim().replace(/\/+$/, "");
console.log("PUBLIC_URL:", PUBLIC_URL);

// ================== CLIENTS ==================
const app = express();
app.use(express.json({ limit: "2mb" }));

const bot = new Telegraf(BOT_TOKEN);

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

// ================== LANGUAGE (mirror user message) ==================
function detectLangFromText(text = "") {
  const t = (text || "").trim();
  if (!t) return null;

  // Tiny heuristics (fast + good enough):
  const lower = t.toLowerCase();
  const itHints = [
    " che ",
    " non ",
    " perchè",
    " perché",
    " come ",
    " oggi",
    " grazie",
    " ciao",
    " vuoi",
    " allora",
    " davvero",
    " io ",
    " tu ",
  ];
  const deHints = [
    " ich ",
    " nicht",
    " danke",
    " hallo",
    " wie ",
    " heute",
    " und ",
    " bitte",
    " kannst",
    " wirklich",
  ];
  const enHints = [
    " i ",
    " you ",
    " thanks",
    " hello",
    " what ",
    " how ",
    " today",
    " really",
    " can you",
    " do you",
  ];

  const score = (hints) =>
    hints.reduce((acc, h) => acc + (lower.includes(h) ? 1 : 0), 0);

  const it = score(itHints);
  const de = score(deHints);
  const en = score(enHints);

  const max = Math.max(it, de, en);
  if (max === 0) return null;
  if (max === it) return "it";
  if (max === de) return "de";
  return "en";
}

function detectLang(ctx, userText = "") {
  // Priority:
  // 1) If user wrote something that clearly looks IT/EN/DE -> use it
  // 2) else use stored user lang from DB (ensureUser updates it)
  // 3) else Telegram language_code
  const byText = detectLangFromText(userText);
  if (byText) return byText;

  const code = (ctx.from?.language_code || "en").slice(0, 2);
  if (["en", "it", "de"].includes(code)) return code;
  return "en";
}

// ================== KEYBOARDS ==================
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

function startText(lang) {
  if (lang === "it") {
    return "Ciao 🌿 sono HITH.\n\nScrivi come parleresti a un’amica. Io ti seguo.";
  }
  if (lang === "de") {
    return "Hi 🌿 ich bin HITH.\n\nSchreib, wie du mit einer Freundin reden würdest. Ich bin da.";
  }
  return "Hi 🌿 I’m HITH.\n\nTalk like you’d talk to a friend. I’ll match you.";
}

// ================== SUPABASE HELPERS ==================
async function ensureUser(ctx, langOverride = null) {
  const tg_id = ctx.from.id;
  const first_name = ctx.from.first_name || "";
  const lang =
    langOverride ||
    (["en", "it", "de"].includes((ctx.from?.language_code || "").slice(0, 2))
      ? (ctx.from.language_code || "en").slice(0, 2)
      : "en");

  try {
    const { data } = await supabase
      .from(SUPABASE_USERS_TABLE)
      .select("id, lang")
      .eq("tg_id", tg_id)
      .maybeSingle();

    if (!data) {
      await supabase.from(SUPABASE_USERS_TABLE).insert([
        { tg_id, first_name, lang },
      ]);
    } else {
      const nextLang = langOverride || data.lang || lang;
      await supabase
        .from(SUPABASE_USERS_TABLE)
        .update({ lang: nextLang, first_name })
        .eq("tg_id", tg_id);
    }

    // Ensure prefs row exists (default friend mode)
    await supabase.from(SUPABASE_PREFS_TABLE).upsert(
      [
        {
          tg_id,
          mode: "friend",
          allow_emojis: true,
          updated_at: new Date().toISOString(),
        },
      ],
      { onConflict: "tg_id" }
    );
  } catch (err) {
    console.error("[ensureUser] Supabase error:", err?.message || err);
  }
}

async function saveMessage(tg_id, role, content) {
  try {
    await supabase
      .from(SUPABASE_MESSAGES_TABLE)
      .insert([{ tg_id, role, content }]);
  } catch (err) {
    console.error("[saveMessage] Supabase error:", err?.message || err);
  }
}

async function getRecentHistory(tg_id, limit = 10) {
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

async function getPrefs(tg_id) {
  try {
    const { data, error } = await supabase
      .from(SUPABASE_PREFS_TABLE)
      .select("mode, allow_emojis")
      .eq("tg_id", tg_id)
      .maybeSingle();

    if (error) throw error;
    return data || { mode: "friend", allow_emojis: true };
  } catch (e) {
    console.error("[getPrefs]", e?.message || e);
    return { mode: "friend", allow_emojis: true };
  }
}

async function setPrefs(tg_id, patch) {
  try {
    const payload = { tg_id, ...patch, updated_at: new Date().toISOString() };
    const { error } = await supabase.from(SUPABASE_PREFS_TABLE).upsert(
      [payload],
      { onConflict: "tg_id" }
    );
    if (error) throw error;
  } catch (e) {
    console.error("[setPrefs]", e?.message || e);
  }
}

// ================== FRIEND MODE SYSTEM PROMPT ==================
function buildSystemPrompt(lang, prefs, userUsedEmojiRecently) {
  const mode = prefs?.mode || "friend";
  const allowEmojis = prefs?.allow_emojis ?? true;

  // Friend mode rules as per: "only if relevant or makes it interesting"
  const friendRules = `
You are HITH.

You are a FRIENDLY chat companion (not a therapist, not a coach unless user chooses Coach).
In FRIEND MODE:
- Talk like a real friend. No corporate/support phrases.
- Do NOT say: "I'm here to support you", "let me know if", "it's important to feel heard/valued", "we can explore".
- NO nagging closers. No "next steps". No bullet therapy exercises.
- Questions are allowed ONLY if they are clearly relevant to the user's last message OR genuinely make the conversation more interesting.
- Otherwise, reply with a simple, natural response (can be short).
- Do not claim personal experiences or feelings.
- Never promise secrecy. If asked, say you can't promise confidentiality, but you'll treat it with care.
- Be natural and present.

Emoji rules:
- allow_emojis=${allowEmojis}
- If emojis are allowed: use at most ONE emoji, and ONLY if the user used emojis recently (${userUsedEmojiRecently ? "yes" : "no"}). Mirror tone (😂 -> 😂).
- If not allowed: use no emojis.

Language:
- Reply strictly in ${lang}. Mirror the user's language. Never default to Italian.
`;

  const otherModes = `
In other modes (Coach / SOS), be practical and brief, still not therapist-y, and do not nag.
`;

  return `${friendRules}\n${otherModes}`.trim();
}

// ================== OUTPUT CLEANUP (removes "support-script") ==================
function cleanupAssistantText(text = "", prefs, userUsedEmojiRecently) {
  let t = (text || "").trim();

  // Remove common "nag lines"
  const killPhrases = [
    /(^|\n)\s*(i[' ]?m here to support you.*)$/gim,
    /(^|\n)\s*(i[' ]?m here for you.*)$/gim,
    /(^|\n)\s*(let me know.*)$/gim,
    /(^|\n)\s*(if you[' ]?d like.*)$/gim,
    /(^|\n)\s*(if you want.*)$/gim,
    /(^|\n)\s*(we can explore.*)$/gim,
    /(^|\n)\s*(it[' ]?s important to feel heard.*)$/gim,
    /(^|\n)\s*(feel free to ask.*)$/gim,
  ];
  for (const rx of killPhrases) t = t.replace(rx, "");

  // Force max length (friend vibe)
  if (t.length > 900) t = t.slice(0, 900).trim();

  // Emoji control
  const allowEmojis = prefs?.allow_emojis ?? true;
  if (!allowEmojis) {
    // remove most emoji chars
    t = t.replace(
      /([\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|\uD83E[\uDC00-\uDFFF])/g,
      ""
    );
  } else {
    // if user didn't use emoji recently, remove emojis from assistant
    if (!userUsedEmojiRecently) {
      t = t.replace(
        /([\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|\uD83E[\uDC00-\uDFFF])/g,
        ""
      );
    } else {
      // max 1 emoji: keep first, remove rest
      const matches = t.match(
        /([\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|\uD83E[\uDC00-\uDFFF])/g
      );
      if (matches && matches.length > 1) {
        let kept = 0;
        t = t.replace(
          /([\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|\uD83E[\uDC00-\uDFFF])/g,
          (m) => {
            kept += 1;
            return kept === 1 ? m : "";
          }
        );
      }
    }
  }

  // Final tidy
  t = t.replace(/\n{3,}/g, "\n\n").trim();
  return t || (prefs?.allow_emojis ? "Got you." : "Got you.");
}

// ================== OPENAI CALL ==================
async function askLLM({ lang, prefs, history, userText, userUsedEmojiRecently }) {
  const system = buildSystemPrompt(lang, prefs, userUsedEmojiRecently);

  const messages = [
    { role: "system", content: system },
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
      temperature: 0.55,
      max_tokens: 350,
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`OpenAI error ${resp.status}: ${txt}`);
  }

  const json = await resp.json();
  return json.choices?.[0]?.message?.content?.trim() || "Got you.";
}

// ================== RATE LIMIT ==================
const lastSeen = new Map();
function tooSoon(id) {
  const now = Date.now();
  if (lastSeen.has(id) && now - lastSeen.get(id) < 1500) return true;
  lastSeen.set(id, now);
  return false;
}

// ================== MENU ROUTING (NO AI) ==================
function normalizeMenuText(t = "") {
  return (t || "").trim().toLowerCase();
}

function isEmojiRecent(text = "") {
  return /([\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|\uD83E[\uDC00-\uDFFF])/.test(
    text || ""
  );
}

function journalLink(tg_id) {
  return `${PUBLIC_URL}/journal?tg_id=${encodeURIComponent(tg_id)}`;
}

function progressLink(tg_id) {
  return `${PUBLIC_URL}/progress?tg_id=${encodeURIComponent(tg_id)}`;
}

// Inline submenu keyboards
function journalMenu(lang, tg_id) {
  const openLabel = lang === "it" ? "📝 Scrivi" : lang === "de" ? "📝 Schreiben" : "📝 Write";
  const histLabel = lang === "it" ? "📚 Storico" : lang === "de" ? "📚 Verlauf" : "📚 History";
  const openBtn = Markup.button.webApp(openLabel, journalLink(tg_id));
  const histBtn = Markup.button.callback(histLabel, "JOURNAL_HISTORY");
  return Markup.inlineKeyboard([[openBtn], [histBtn]]);
}

function progressMenu(lang, tg_id) {
  const openLabel =
    lang === "it" ? "📊 Apri Progress" : lang === "de" ? "📊 Fortschritt öffnen" : "📊 Open Progress";
  const openBtn = Markup.button.webApp(openLabel, progressLink(tg_id));
  return Markup.inlineKeyboard([[openBtn]]);
}

function settingsMenu(lang) {
  const title =
    lang === "it"
      ? "⚙️ Impostazioni"
      : lang === "de"
      ? "⚙️ Einstellungen"
      : "⚙️ Settings";
  const friend =
    lang === "it" ? "✅ Modalità amica" : lang === "de" ? "✅ Freund-Modus" : "✅ Friend mode";
  return {
    title,
    keyboard: Markup.inlineKeyboard([
      [
        Markup.button.callback("🇮🇹 IT", "LANG_it"),
        Markup.button.callback("🇬🇧 EN", "LANG_en"),
        Markup.button.callback("🇩🇪 DE", "LANG_de"),
      ],
      [Markup.button.callback(friend, "MODE_friend")],
    ]),
  };
}

// ================== TELEGRAM HANDLERS ==================
bot.start(async (ctx) => {
  const lang = detectLang(ctx, "");
  await ensureUser(ctx, lang);
  await ctx.reply(startText(lang), mainKeyboard(lang));
});

// Callback queries for settings/history
bot.on("callback_query", async (ctx) => {
  const tg_id = ctx.from.id;
  const data = ctx.callbackQuery?.data || "";

  try {
    if (data.startsWith("LANG_")) {
      const lang = data.replace("LANG_", "");
      await ensureUser(ctx, lang);
      await ctx.answerCbQuery("✅");
      await ctx.reply(
        lang === "it" ? "Lingua impostata su IT ✅" : lang === "de" ? "Sprache: DE ✅" : "Language: EN ✅",
        mainKeyboard(lang)
      );
      return;
    }

    if (data === "MODE_friend") {
      await setPrefs(tg_id, { mode: "friend", allow_emojis: true });
      await ctx.answerCbQuery("✅");
      const lang = detectLang(ctx, "");
      await ctx.reply(
        lang === "it"
          ? "🔒 Friend mode locked. ✅"
          : lang === "de"
          ? "🔒 Freund-Modus gesperrt. ✅"
          : "🔒 Friend mode locked. ✅",
        mainKeyboard(lang)
      );
      return;
    }

    if (data === "JOURNAL_HISTORY") {
      const lang = detectLang(ctx, "");
      // fetch last 10 journal entries
      const { data: rows, error } = await supabase
        .from(SUPABASE_JOURNAL_TABLE)
        .select("id, title, created_at")
        .eq("tg_id", tg_id)
        .order("created_at", { ascending: false })
        .limit(10);

      if (error) {
        console.error("[journal history]", error.message);
        await ctx.answerCbQuery("⚠️");
        await ctx.reply(lang === "it" ? "Errore storico." : lang === "de" ? "Verlauf-Fehler." : "History error.");
        return;
      }

      if (!rows || rows.length === 0) {
        await ctx.answerCbQuery("✅");
        await ctx.reply(
          lang === "it" ? "Nessuna nota salvata ancora." : lang === "de" ? "Noch keine Notizen gespeichert." : "No saved notes yet."
        );
        return;
      }

      const buttons = rows.map((r) => {
        const date = new Date(r.created_at).toLocaleString("it-IT");
        const label = `${r.title || "Untitled"} · ${date}`;
        return [Markup.button.webApp(label.slice(0, 60), `${PUBLIC_URL}/journal?tg_id=${tg_id}&id=${r.id}`)];
      });

      await ctx.answerCbQuery("✅");
      await ctx.reply(
        lang === "it" ? "📚 Storico:" : lang === "de" ? "📚 Verlauf:" : "📚 History:",
        Markup.inlineKeyboard(buttons)
      );
      return;
    }

    await ctx.answerCbQuery("✅");
  } catch (e) {
    console.error("[callback_query]", e?.message || e);
    try {
      await ctx.answerCbQuery("⚠️");
    } catch {}
  }
});

// Text messages
bot.on("text", async (ctx) => {
  const text = (ctx.message.text || "").trim();
  const tg_id = ctx.from.id;

  if (!text) return;
  if (text.startsWith("/start")) return;

  if (tooSoon(tg_id)) return;

  // ✅ Friend-mode lock phrase (exact)
  if (text === "Lock friend mode.") {
    const lang = detectLang(ctx, text);
    await ensureUser(ctx, lang);
    await setPrefs(tg_id, { mode: "friend", allow_emojis: true });
    await ctx.reply("🔒 Friend mode locked. ✅", mainKeyboard(lang));
    return;
  }

  // Settings menu
  const n = normalizeMenuText(text);
  const isSettings =
    n === "⚙️ impostazioni" ||
    n === "impostazioni" ||
    n === "⚙️ settings" ||
    n === "settings" ||
    n === "⚙️ einstellungen" ||
    n === "einstellungen";

  if (isSettings) {
    const lang = detectLang(ctx, text);
    await ensureUser(ctx, lang);
    const s = settingsMenu(lang);
    await ctx.reply(s.title, s.keyboard);
    return;
  }

  // Menu buttons → open submenus (NO AI)
  // Journal
  const isJournal = n.includes("journal") || n === "📔 journal";
  if (isJournal) {
    const lang = detectLang(ctx, text);
    await ensureUser(ctx, lang);
    await ctx.reply(
      lang === "it"
        ? "📔 Journal"
        : lang === "de"
        ? "📔 Journal"
        : "📔 Journal",
      journalMenu(lang, tg_id)
    );
    return;
  }

  // Progress
  const isProgress =
    n.includes("progress") ||
    n.includes("fortschritt") ||
    n === "📊 progress" ||
    n === "📊 fortschritt";
  if (isProgress) {
    const lang = detectLang(ctx, text);
    await ensureUser(ctx, lang);
    await ctx.reply(
      lang === "it" ? "📊 Progress" : lang === "de" ? "📊 Fortschritt" : "📊 Progress",
      progressMenu(lang, tg_id)
    );
    return;
  }

  // Invite
  const isInvite =
    n.includes("invite") ||
    n.includes("einladen") ||
    n.includes("invita") ||
    n === "🔗 invite" ||
    n === "🔗 einladen";
  if (isInvite) {
    const lang = detectLang(ctx, text);
    await ensureUser(ctx, lang);
    const username = (await bot.telegram.getMe()).username;
    const link = `https://t.me/${username}`;
    const msg =
      lang === "it"
        ? `Invita un’amica:\n${link}`
        : lang === "de"
        ? `Lade eine Freundin ein:\n${link}`
        : `Invite a friend:\n${link}`;
    await ctx.reply(msg, mainKeyboard(lang));
    return;
  }

  // Coach / SOS: keep it minimal + still not naggy, but allow AI
  const isCoach = n.includes("coach") || n === "📌 coach";
  const isSOS = n.includes("sos") || n === "⚡ sos";

  // Normal chat → AI (friend mode)
  const lang = detectLang(ctx, text);
  await ensureUser(ctx, lang);

  const prefs = await getPrefs(tg_id);

  // User used emoji recently?
  const userUsedEmojiRecently = isEmojiRecent(text);

  // Save user message (memory)
  await saveMessage(tg_id, "user", text);

  // Build a tiny "mode hint" to keep friend vibe even if user triggers coach/sos
  let modeHint = "";
  if (isCoach) modeHint = "User selected COACH mode. Be practical, not therapist-y.";
  if (isSOS) modeHint = "User selected SOS. Be calm, short, grounding. No questions unless needed.";

  try {
    await ctx.sendChatAction("typing");

    const history = await getRecentHistory(tg_id, 10);

    const answerRaw = await askLLM({
      lang,
      prefs,
      history,
      userText: modeHint ? `${modeHint}\n\n${text}` : text,
      userUsedEmojiRecently,
    });

    const answer = cleanupAssistantText(answerRaw, prefs, userUsedEmojiRecently);

    await saveMessage(tg_id, "assistant", answer);
    await ctx.reply(answer, mainKeyboard(lang));
  } catch (err) {
    console.error("[bot.on text] Error:", err?.message || err);
    const fallback =
      lang === "it"
        ? "Oops. Un attimo e riproviamo."
        : lang === "de"
        ? "Oops. Kurz hängen geblieben. Gleich nochmal."
        : "Oops. Small hiccup. Try again.";
    await ctx.reply(fallback, mainKeyboard(lang));
  }
});

// ================== TELEGRAM WEBHOOK ==================
const SECRET_PATH = "/tg-webhook";
const WEBHOOK_URL = `${PUBLIC_URL}${SECRET_PATH}`;
console.log("SECRET_PATH:", SECRET_PATH);
console.log("WEBHOOK_URL:", WEBHOOK_URL);

// ✅ IMPORTANT FIX: do NOT mount with SECRET_PATH + webhookCallback(SECRET_PATH)
// Use webhookCallback with the path directly:
app.use(bot.webhookCallback(SECRET_PATH));

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
  } catch (err) {
    console.error("[setWebhook] failed:", err?.message || err);
  }
}

// ================== JOURNAL WEBAPP ==================
// Minimal HTML page (write/save/share/print + history)
function journalHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>HITH · Journal</title>
<style>
  :root{
    --bg:#050507; --card:#0f0f12; --gold:#d4af37; --text:#f5f5f5; --muted:#a7a7a7;
    --line: rgba(255,255,255,.08);
  }
  *{box-sizing:border-box}
  body{
    margin:0; font-family: system-ui,-apple-system,Segoe UI,Roboto,Inter,Arial;
    background: radial-gradient(circle at top, #222 0, #050507 55%);
    color:var(--text); min-height:100vh; display:flex; align-items:center; justify-content:center;
    padding:18px;
  }
  .wrap{width:100%; max-width:980px;}
  .card{
    background: rgba(0,0,0,.72);
    border:1px solid var(--line);
    border-radius:18px; padding:16px;
    box-shadow: 0 18px 60px rgba(0,0,0,.45);
  }
  header{display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:10px}
  h1{font-size:18px; margin:0; letter-spacing:.4px}
  .badge{
    font-size:12px; color:var(--muted);
    border:1px solid var(--line); border-radius:999px; padding:6px 10px;
  }
  input, textarea{
    width:100%; background: rgba(255,255,255,.03);
    color:var(--text); border:1px solid var(--line);
    border-radius:12px; padding:12px; outline:none;
  }
  textarea{min-height:320px; resize:vertical; line-height:1.55}
  .row{display:flex; gap:10px; flex-wrap:wrap; margin-top:10px}
  button{
    background: linear-gradient(180deg, rgba(212,175,55,.22), rgba(212,175,55,.06));
    color:var(--text); border:1px solid rgba(212,175,55,.35);
    border-radius:12px; padding:10px 12px; cursor:pointer;
  }
  button.secondary{
    background: rgba(255,255,255,.03);
    border:1px solid var(--line); color:var(--text);
  }
  .hint{margin-top:10px; font-size:12px; color:var(--muted)}
  .list{margin-top:14px; border-top:1px solid var(--line); padding-top:12px}
  .item{
    display:flex; justify-content:space-between; gap:10px;
    padding:10px; border:1px solid var(--line);
    border-radius:12px; margin-top:8px; background: rgba(255,255,255,.02);
  }
  .item b{font-size:13px}
  .item span{font-size:12px; color:var(--muted)}
  .item button{padding:8px 10px}
  .toast{position:fixed; bottom:16px; left:50%; transform:translateX(-50%);
    background: rgba(0,0,0,.75); border:1px solid var(--line); color:var(--text);
    border-radius:999px; padding:10px 14px; font-size:13px; display:none;
  }
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <header>
      <h1>HITH · Journal</h1>
      <div class="badge" id="status">Ready</div>
    </header>

    <input id="title" placeholder="Title (optional)" />
    <div style="height:10px"></div>
    <textarea id="content" placeholder="Write here…"></textarea>

    <div class="row">
      <button id="save">Save</button>
      <button class="secondary" id="share">Share</button>
      <button class="secondary" id="print">Print</button>
      <button class="secondary" id="clear">Clear</button>
      <button class="secondary" id="refresh">Refresh list</button>
    </div>

    <div class="hint">
      Saved notes are stored in Supabase (tg_id). Share uses your phone’s share sheet if available.
    </div>

    <div class="list">
      <div class="badge" style="display:inline-block;margin-bottom:8px;">History</div>
      <div id="items"></div>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
  const qs = new URLSearchParams(location.search);
  const tg_id = qs.get("tg_id");
  const openId = qs.get("id");

  const elTitle = document.getElementById("title");
  const elContent = document.getElementById("content");
  const elItems = document.getElementById("items");
  const elStatus = document.getElementById("status");
  const toast = document.getElementById("toast");

  function showToast(msg){
    toast.textContent = msg;
    toast.style.display = "block";
    setTimeout(()=> toast.style.display="none", 1600);
  }

  function setStatus(msg){ elStatus.textContent = msg; }

  async function api(path, opts={}){
    const res = await fetch(path, {
      ...opts,
      headers: { "Content-Type":"application/json", ...(opts.headers||{}) }
    });
    if(!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async function loadList(){
    if(!tg_id){ elItems.innerHTML = "<div class='hint'>Missing tg_id.</div>"; return; }
    setStatus("Loading…");
    try{
      const data = await api("/api/journal/list", { method:"POST", body: JSON.stringify({ tg_id }) });
      const rows = data.rows || [];
      if(rows.length === 0){
        elItems.innerHTML = "<div class='hint'>No entries yet.</div>";
      } else {
        elItems.innerHTML = "";
        rows.forEach(r=>{
          const div = document.createElement("div");
          div.className = "item";
          const left = document.createElement("div");
          const d = new Date(r.created_at).toLocaleString();
          left.innerHTML = "<b>"+(r.title || "Untitled")+"</b><br><span>"+d+"</span>";
          const right = document.createElement("div");
          const btn = document.createElement("button");
          btn.textContent = "Open";
          btn.onclick = ()=> openEntry(r.id);
          right.appendChild(btn);
          div.appendChild(left);
          div.appendChild(right);
          elItems.appendChild(div);
        });
      }
      setStatus("Ready");
    }catch(e){
      setStatus("Error");
      showToast("List error");
      console.error(e);
    }
  }

  async function openEntry(id){
    if(!tg_id) return;
    setStatus("Loading…");
    try{
      const data = await api("/api/journal/get", { method:"POST", body: JSON.stringify({ tg_id, id }) });
      elTitle.value = data.row?.title || "";
      elContent.value = data.row?.content || "";
      setStatus("Ready");
      showToast("Opened");
    }catch(e){
      setStatus("Error");
      showToast("Open error");
      console.error(e);
    }
  }

  document.getElementById("save").onclick = async ()=>{
    if(!tg_id){ showToast("Missing tg_id"); return; }
    const title = (elTitle.value || "").trim();
    const content = (elContent.value || "").trim();
    if(!content){ showToast("Write something first"); return; }
    setStatus("Saving…");
    try{
      await api("/api/journal/save", { method:"POST", body: JSON.stringify({ tg_id, title, content }) });
      setStatus("Ready");
      showToast("Saved");
      await loadList();
    }catch(e){
      setStatus("Error");
      showToast("Save error");
      console.error(e);
    }
  };

  document.getElementById("share").onclick = async ()=>{
    const title = (elTitle.value || "Journal").trim();
    const content = (elContent.value || "").trim();
    if(!content){ showToast("Nothing to share"); return; }

    try{
      if(navigator.share){
        await navigator.share({ title, text: content });
      } else {
        await navigator.clipboard.writeText(content);
        showToast("Copied");
      }
    }catch(e){
      console.error(e);
      showToast("Share canceled");
    }
  };

  document.getElementById("print").onclick = ()=>{
    const title = (elTitle.value || "Journal").trim();
    const content = (elContent.value || "").trim();
    const w = window.open("", "_blank");
    w.document.write("<pre style='font-family:system-ui;white-space:pre-wrap'>"+title+"\\n\\n"+content+"</pre>");
    w.document.close();
    w.focus();
    w.print();
    w.close();
  };

  document.getElementById("clear").onclick = ()=>{
    elTitle.value = "";
    elContent.value = "";
    showToast("Cleared");
  };

  document.getElementById("refresh").onclick = loadList;

  (async ()=>{
    await loadList();
    if(openId) await openEntry(openId);
  })();
</script>
</body>
</html>`;
}

app.get("/journal", (_req, res) => {
  res.status(200).send(journalHtml());
});

app.get("/progress", (_req, res) => {
  // Minimal placeholder page (you can expand later)
  res.status(200).send(`<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>HITH · Progress</title>
  <style>body{margin:0;font-family:system-ui;background:#050507;color:#f5f5f5;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:18px}
  .card{max-width:900px;width:100%;background:rgba(0,0,0,.72);border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:16px}
  h1{margin:0 0 8px;font-size:18px}p{color:#a7a7a7;line-height:1.5}</style></head>
  <body><div class="card"><h1>HITH · Progress</h1>
  <p>Coming next: streaks, saved journal count, mood tags, tiny wins.</p></div></body></html>`);
});

// Journal API (Supabase)
app.post("/api/journal/save", async (req, res) => {
  try {
    const { tg_id, title, content } = req.body || {};
    if (!tg_id || !content) return res.status(400).json({ ok: false });

    const { error } = await supabase.from(SUPABASE_JOURNAL_TABLE).insert([
      {
        tg_id,
        title: title || null,
        content,
      },
    ]);
    if (error) throw error;

    res.json({ ok: true });
  } catch (e) {
    console.error("[/api/journal/save]", e?.message || e);
    res.status(500).json({ ok: false });
  }
});

app.post("/api/journal/list", async (req, res) => {
  try {
    const { tg_id } = req.body || {};
    if (!tg_id) return res.status(400).json({ ok: false });

    const { data, error } = await supabase
      .from(SUPABASE_JOURNAL_TABLE)
      .select("id, title, created_at")
      .eq("tg_id", tg_id)
      .order("created_at", { ascending: false })
      .limit(25);

    if (error) throw error;
    res.json({ ok: true, rows: data || [] });
  } catch (e) {
    console.error("[/api/journal/list]", e?.message || e);
    res.status(500).json({ ok: false, rows: [] });
  }
});

app.post("/api/journal/get", async (req, res) => {
  try {
    const { tg_id, id } = req.body || {};
    if (!tg_id || !id) return res.status(400).json({ ok: false });

    const { data, error } = await supabase
      .from(SUPABASE_JOURNAL_TABLE)
      .select("id, title, content, created_at")
      .eq("tg_id", tg_id)
      .eq("id", id)
      .maybeSingle();

    if (error) throw error;
    res.json({ ok: true, row: data || null });
  } catch (e) {
    console.error("[/api/journal/get]", e?.message || e);
    res.status(500).json({ ok: false, row: null });
  }
});

// ================== WHATSAPP WEBHOOK (kept for next step) ==================
// Verify (GET)
app.get("/whatsapp/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token && token === WHATSAPP_VERIFY_TOKEN) {
    console.log("✅ WhatsApp webhook verified");
    return res.status(200).send(challenge);
  }
  console.warn("❌ WhatsApp webhook verification failed");
  return res.sendStatus(403);
});

// Messages (POST)
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

        // For now: simple echo (we will replace with HITH pipeline next)
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
                text: { body: `HITH: ${text}` },
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

// ================== BASE ROUTE ==================
app.get("/", (_req, res) => {
  res.status(200).send("HITH bot is running.");
});

// ================== SERVER START ==================
app.listen(PORT, async () => {
  console.log(`🚀 Server listening on ${PORT}`);
  console.log(`🌍 PUBLIC_URL base: ${PUBLIC_URL}`);
  console.log(`🤖 Telegram webhook URL: ${WEBHOOK_URL}`);

  // Telegram webhook
  await setupTelegramWebhook();

  // Supabase connection test
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

/*
REQUIRED SUPABASE TABLES (create in Supabase SQL editor):

-- prefs (for friend mode lock + emoji allow)
create table if not exists hith_prefs (
  tg_id bigint primary key,
  mode text not null default 'friend',
  allow_emojis boolean not null default true,
  updated_at timestamptz not null default now()
);

-- journals
create table if not exists hith_journals (
  id bigserial primary key,
  tg_id bigint not null,
  title text,
  content text not null,
  created_at timestamptz not null default now()
);

NOTE (optional but recommended):
Add in package.json: "type": "module"
*/

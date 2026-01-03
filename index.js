// index.js — HITH bot (Telegram + WhatsApp) + Supabase + OpenAI + Journal WebApp
// ✅ Telegram: webhook ok, menu non chiama AI, lock friend mode.
// ✅ WhatsApp: webhook verify + messages -> stessa pipeline HITH (lang mirror, emoji mirror light, no therapy nag), history + prefs in Supabase.

import express from "express";
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

// WhatsApp tables (NEW)
const SUPABASE_WA_PREFS_TABLE =
  process.env.SUPABASE_WA_PREFS_TABLE || "hith_wa_prefs";
const SUPABASE_WA_MESSAGES_TABLE =
  process.env.SUPABASE_WA_MESSAGES_TABLE || "hith_wa_messages";

// PUBLIC_URL (Render) or WEBHOOK_DOMAIN
const RAW_PUBLIC_URL =
  process.env.PUBLIC_URL || process.env.WEBHOOK_DOMAIN || "";

// WhatsApp (Meta Cloud API)
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN; // must match Meta webhook verify token
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN; // permanent token / system user token
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID; // phone number ID (not phone number)

const PORT = Number(process.env.PORT) || 10000;

// --- Critical env checks ---
function die(msg) {
  console.error("❌ " + msg);
  process.exit(1);
}
if (!BOT_TOKEN) die("Missing BOT_TOKEN");
if (!OPENAI_API_KEY) die("Missing OPENAI_API_KEY");
if (!SUPABASE_URL || !SUPABASE_KEY) die("Missing Supabase config: SUPABASE_URL / SUPABASE_KEY");
if (!RAW_PUBLIC_URL) die("Missing PUBLIC_URL (or WEBHOOK_DOMAIN).");

const PUBLIC_URL = RAW_PUBLIC_URL.trim().replace(/\/+$/, "");
console.log("PUBLIC_URL:", PUBLIC_URL);

// ================== CLIENTS ==================
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));

const bot = new Telegraf(BOT_TOKEN);

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

// ================== LANGUAGE (mirror user message) ==================
function detectLangFromText(text = "") {
  const t = (text || "").trim();
  if (!t) return null;
  const lower = " " + t.toLowerCase() + " ";

  // simple hints
  const itHints = [" che ", " non ", " perché", " perche", " come ", " oggi", " grazie", " ciao", " voglio ", " allora "];
  const deHints = [" ich ", " nicht", " danke", " hallo", " wie ", " heute", " und ", " bitte", " kannst", " wirklich"];
  const enHints = [" i ", " you ", " thanks", " hello", " what ", " how ", " today", " really", " can you", " do you"];

  const score = (hints) => hints.reduce((acc, h) => acc + (lower.includes(h) ? 1 : 0), 0);
  const it = score(itHints), de = score(deHints), en = score(enHints);

  const max = Math.max(it, de, en);
  if (max === 0) return null;
  if (max === it) return "it";
  if (max === de) return "de";
  return "en";
}

function detectLangTelegram(ctx, userText = "") {
  const byText = detectLangFromText(userText);
  if (byText) return byText;

  const code = (ctx.from?.language_code || "en").slice(0, 2);
  if (["en", "it", "de"].includes(code)) return code;
  return "en";
}

function isEmojiRecent(text = "") {
  return /([\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|\uD83E[\uDC00-\uDFFF])/g.test(text || "");
}

// ================== TELEGRAM UI ==================
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
  if (lang === "it") return "Ciao. Sono HITH.";
  if (lang === "de") return "Hi. Ich bin HITH.";
  return "Hi. I’m HITH.";
}

// ================== SUPABASE HELPERS ==================
async function ensureUserTelegram(ctx, langOverride = null) {
  const tg_id = ctx.from.id;
  const first_name = ctx.from.first_name || "";
  const lang = langOverride || detectLangTelegram(ctx, "");

  try {
    const { data } = await supabase
      .from(SUPABASE_USERS_TABLE)
      .select("id, lang")
      .eq("tg_id", tg_id)
      .maybeSingle();

    if (!data) {
      await supabase.from(SUPABASE_USERS_TABLE).insert([{ tg_id, first_name, lang }]);
    } else {
      await supabase
        .from(SUPABASE_USERS_TABLE)
        .update({ lang, first_name })
        .eq("tg_id", tg_id);
    }

    // Ensure telegram prefs row exists
    await supabase.from(SUPABASE_PREFS_TABLE).upsert(
      [{ tg_id, mode: "friend", allow_emojis: true, updated_at: new Date().toISOString() }],
      { onConflict: "tg_id" }
    );
  } catch (err) {
    console.error("[ensureUserTelegram]", err?.message || err);
  }
}

async function saveMessageTelegram(tg_id, role, content) {
  try {
    await supabase.from(SUPABASE_MESSAGES_TABLE).insert([{ tg_id, role, content }]);
  } catch (err) {
    console.error("[saveMessageTelegram]", err?.message || err);
  }
}

async function getRecentHistoryTelegram(tg_id, limit = 10) {
  try {
    const { data, error } = await supabase
      .from(SUPABASE_MESSAGES_TABLE)
      .select("role, content")
      .eq("tg_id", tg_id)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) return [];
    return (data || []).reverse();
  } catch {
    return [];
  }
}

async function getTgPrefs(tg_id) {
  try {
    const { data, error } = await supabase
      .from(SUPABASE_PREFS_TABLE)
      .select("mode, allow_emojis")
      .eq("tg_id", tg_id)
      .maybeSingle();
    if (error) throw error;
    return data || { mode: "friend", allow_emojis: true };
  } catch (e) {
    console.error("[getTgPrefs]", e?.message || e);
    return { mode: "friend", allow_emojis: true };
  }
}

async function setTgPrefs(tg_id, patch) {
  try {
    await supabase.from(SUPABASE_PREFS_TABLE).upsert(
      [{ tg_id, ...patch, updated_at: new Date().toISOString() }],
      { onConflict: "tg_id" }
    );
  } catch (e) {
    console.error("[setTgPrefs]", e?.message || e);
  }
}

// ---------- WhatsApp Supabase ----------
async function ensureWaPrefs(wa_id) {
  try {
    await supabase.from(SUPABASE_WA_PREFS_TABLE).upsert(
      [{ wa_id, mode: "friend", allow_emojis: true, updated_at: new Date().toISOString() }],
      { onConflict: "wa_id" }
    );
  } catch (e) {
    console.error("[ensureWaPrefs]", e?.message || e);
  }
}

async function getWaPrefs(wa_id) {
  try {
    const { data, error } = await supabase
      .from(SUPABASE_WA_PREFS_TABLE)
      .select("mode, allow_emojis")
      .eq("wa_id", wa_id)
      .maybeSingle();
    if (error) throw error;
    return data || { mode: "friend", allow_emojis: true };
  } catch (e) {
    console.error("[getWaPrefs]", e?.message || e);
    return { mode: "friend", allow_emojis: true };
  }
}

async function setWaPrefs(wa_id, patch) {
  try {
    await supabase.from(SUPABASE_WA_PREFS_TABLE).upsert(
      [{ wa_id, ...patch, updated_at: new Date().toISOString() }],
      { onConflict: "wa_id" }
    );
  } catch (e) {
    console.error("[setWaPrefs]", e?.message || e);
  }
}

async function saveMessageWhatsApp(wa_id, role, content) {
  try {
    await supabase.from(SUPABASE_WA_MESSAGES_TABLE).insert([{ wa_id, role, content }]);
  } catch (e) {
    console.error("[saveMessageWhatsApp]", e?.message || e);
  }
}

async function getRecentHistoryWhatsApp(wa_id, limit = 10) {
  try {
    const { data, error } = await supabase
      .from(SUPABASE_WA_MESSAGES_TABLE)
      .select("role, content")
      .eq("wa_id", wa_id)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) return [];
    return (data || []).reverse();
  } catch {
    return [];
  }
}

// ================== FRIEND MODE SYSTEM PROMPT ==================
function buildSystemPrompt(lang, prefs, userUsedEmojiRecently) {
  const mode = prefs?.mode || "friend";
  const allowEmojis = prefs?.allow_emojis ?? true;

  return `
You are HITH. Your name is HITH.

MODE: ${mode.toUpperCase()}.

FRIEND MODE RULES:
- Talk like a real friend. Natural, short, present.
- No therapy language, no corporate support lines.
- Do NOT say: "I'm here to support you", "let me know if", "we can explore", "it's important to feel heard/valued".
- No nagging closers. No "next steps". No exercises.
- You MAY ask a question only if it is clearly relevant to the user's last message OR it genuinely makes the conversation more interesting.
- Otherwise, just respond.
- Never promise secrecy/confidentiality. If asked, say you can't promise confidentiality but you will treat it with care.
- Do not claim personal experiences or feelings.

EMOJI RULES:
- allow_emojis=${allowEmojis}
- If allowed: use at most ONE emoji, and ONLY if user used emojis recently (${userUsedEmojiRecently ? "yes" : "no"}). Mirror tone (😂 -> 😂).
- If not allowed OR userUsedEmojiRecently=no: use no emojis.

LANGUAGE:
- Reply strictly in ${lang}. Mirror the user's language. Never default to Italian.
`.trim();
}

// ================== OUTPUT CLEANUP ==================
function cleanupAssistantText(text = "", prefs, userUsedEmojiRecently) {
  let t = (text || "").trim();

  // kill “support script” lines
  const kill = [
    /(^|\n)\s*(i[' ]?m here to support you.*)$/gim,
    /(^|\n)\s*(i[' ]?m here for you.*)$/gim,
    /(^|\n)\s*(let me know.*)$/gim,
    /(^|\n)\s*(if you[' ]?d like.*)$/gim,
    /(^|\n)\s*(if you want.*)$/gim,
    /(^|\n)\s*(we can explore.*)$/gim,
    /(^|\n)\s*(it[' ]?s important.*)$/gim,
  ];
  for (const rx of kill) t = t.replace(rx, "");

  // emoji control
  const allowEmojis = prefs?.allow_emojis ?? true;
  const emojiRx =
    /([\u2700-\u27BF]|[\uE000-\uF8FF]|\uD83C[\uDC00-\uDFFF]|\uD83D[\uDC00-\uDFFF]|\uD83E[\uDC00-\uDFFF])/g;

  if (!allowEmojis || !userUsedEmojiRecently) {
    t = t.replace(emojiRx, "");
  } else {
    const matches = t.match(emojiRx);
    if (matches && matches.length > 1) {
      let kept = 0;
      t = t.replace(emojiRx, (m) => {
        kept += 1;
        return kept === 1 ? m : "";
      });
    }
  }

  // final tidy
  t = t.replace(/\n{3,}/g, "\n\n").trim();
  if (!t) t = "Ok.";
  return t;
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
  return json.choices?.[0]?.message?.content?.trim() || "Ok.";
}

// ================== RATE LIMIT ==================
const lastSeen = new Map();
function tooSoon(key) {
  const now = Date.now();
  if (lastSeen.has(key) && now - lastSeen.get(key) < 1200) return true;
  lastSeen.set(key, now);
  return false;
}

// ================== TELEGRAM SUBMENUS ==================
function normalizeMenuText(t = "") {
  return (t || "").trim().toLowerCase();
}

function journalLink(tg_id) {
  return `${PUBLIC_URL}/journal?tg_id=${encodeURIComponent(tg_id)}`;
}
function progressLink(tg_id) {
  return `${PUBLIC_URL}/progress?tg_id=${encodeURIComponent(tg_id)}`;
}

function journalMenu(lang, tg_id) {
  const open = lang === "it" ? "📝 Scrivi" : lang === "de" ? "📝 Schreiben" : "📝 Write";
  const hist = lang === "it" ? "📚 Storico" : lang === "de" ? "📚 Verlauf" : "📚 History";
  return Markup.inlineKeyboard([
    [Markup.button.webApp(open, journalLink(tg_id))],
    [Markup.button.callback(hist, "JOURNAL_HISTORY")],
  ]);
}
function progressMenu(lang, tg_id) {
  const open =
    lang === "it" ? "📊 Apri Progress" : lang === "de" ? "📊 Fortschritt öffnen" : "📊 Open Progress";
  return Markup.inlineKeyboard([[Markup.button.webApp(open, progressLink(tg_id))]]);
}
function settingsMenu(lang) {
  const title =
    lang === "it" ? "⚙️ Impostazioni" : lang === "de" ? "⚙️ Einstellungen" : "⚙️ Settings";
  return {
    title,
    keyboard: Markup.inlineKeyboard([
      [
        Markup.button.callback("🇮🇹 IT", "LANG_it"),
        Markup.button.callback("🇬🇧 EN", "LANG_en"),
        Markup.button.callback("🇩🇪 DE", "LANG_de"),
      ],
      [Markup.button.callback("🔒 Friend mode locked", "MODE_friend")],
    ]),
  };
}

// ================== TELEGRAM HANDLERS ==================
bot.start(async (ctx) => {
  const lang = detectLangTelegram(ctx, "");
  await ensureUserTelegram(ctx, lang);
  await ctx.reply(startText(lang), mainKeyboard(lang));
});

bot.on("callback_query", async (ctx) => {
  const tg_id = ctx.from.id;
  const data = ctx.callbackQuery?.data || "";

  try {
    if (data.startsWith("LANG_")) {
      const lang = data.replace("LANG_", "");
      await ensureUserTelegram(ctx, lang);
      await ctx.answerCbQuery("✅");
      await ctx.reply(
        lang === "it" ? "Lingua: IT ✅" : lang === "de" ? "Sprache: DE ✅" : "Language: EN ✅",
        mainKeyboard(lang)
      );
      return;
    }

    if (data === "MODE_friend") {
      await setTgPrefs(tg_id, { mode: "friend", allow_emojis: true });
      await ctx.answerCbQuery("✅");
      const lang = detectLangTelegram(ctx, "");
      await ctx.reply("🔒 Friend mode locked. ✅", mainKeyboard(lang));
      return;
    }

    if (data === "JOURNAL_HISTORY") {
      const lang = detectLangTelegram(ctx, "");
      const { data: rows, error } = await supabase
        .from(SUPABASE_JOURNAL_TABLE)
        .select("id, title, created_at")
        .eq("tg_id", tg_id)
        .order("created_at", { ascending: false })
        .limit(10);

      if (error) {
        await ctx.answerCbQuery("⚠️");
        await ctx.reply(lang === "it" ? "Errore storico." : lang === "de" ? "Verlauf-Fehler." : "History error.");
        return;
      }

      if (!rows || rows.length === 0) {
        await ctx.answerCbQuery("✅");
        await ctx.reply(
          lang === "it" ? "Nessuna nota salvata ancora." : lang === "de" ? "Noch keine Notizen." : "No saved notes yet."
        );
        return;
      }

      const buttons = rows.map((r) => {
        const d = new Date(r.created_at).toLocaleString(lang === "it" ? "it-IT" : lang === "de" ? "de-DE" : "en-US");
        const label = `${r.title || "Untitled"} · ${d}`.slice(0, 60);
        return [Markup.button.webApp(label, `${PUBLIC_URL}/journal?tg_id=${tg_id}&id=${r.id}`)];
      });

      await ctx.answerCbQuery("✅");
      await ctx.reply(lang === "it" ? "📚 Storico:" : lang === "de" ? "📚 Verlauf:" : "📚 History:", Markup.inlineKeyboard(buttons));
      return;
    }

    await ctx.answerCbQuery("✅");
  } catch (e) {
    console.error("[callback_query]", e?.message || e);
    try { await ctx.answerCbQuery("⚠️"); } catch {}
  }
});

bot.on("text", async (ctx) => {
  const text = (ctx.message.text || "").trim();
  const tg_id = ctx.from.id;
  if (!text) return;
  if (text.startsWith("/start")) return;
  if (tooSoon("tg:" + tg_id)) return;

  const n = normalizeMenuText(text);
  const lang = detectLangTelegram(ctx, text);
  await ensureUserTelegram(ctx, lang);

  // ✅ exact lock phrase
  if (text === "Lock friend mode.") {
    await setTgPrefs(tg_id, { mode: "friend", allow_emojis: true });
    await ctx.reply("🔒 Friend mode locked. ✅", mainKeyboard(lang));
    return;
  }

  // Settings
  if (n.includes("impostazioni") || n === "settings" || n.includes("einstellungen")) {
    const s = settingsMenu(lang);
    await ctx.reply(s.title, s.keyboard);
    return;
  }

  // Menu: Journal / Progress
  if (n.includes("journal")) {
    await ctx.reply("📔 Journal", journalMenu(lang, tg_id));
    return;
  }
  if (n.includes("progress") || n.includes("fortschritt")) {
    await ctx.reply(lang === "de" ? "📊 Fortschritt" : "📊 Progress", progressMenu(lang, tg_id));
    return;
  }

  // Invite
  if (n.includes("invite") || n.includes("einladen") || n.includes("invita")) {
    const me = await bot.telegram.getMe();
    const link = `https://t.me/${me.username}`;
    const msg =
      lang === "it" ? `Invita un’amica:\n${link}` : lang === "de" ? `Lade eine Freundin ein:\n${link}` : `Invite a friend:\n${link}`;
    await ctx.reply(msg, mainKeyboard(lang));
    return;
  }

  // Normal chat -> AI
  const prefs = await getTgPrefs(tg_id);
  const userUsedEmojiRecently = isEmojiRecent(text);

  await saveMessageTelegram(tg_id, "user", text);

  try {
    await ctx.sendChatAction("typing");
    const history = await getRecentHistoryTelegram(tg_id, 10);

    const answerRaw = await askLLM({
      lang,
      prefs,
      history,
      userText: text,
      userUsedEmojiRecently,
    });

    const answer = cleanupAssistantText(answerRaw, prefs, userUsedEmojiRecently);
    await saveMessageTelegram(tg_id, "assistant", answer);
    await ctx.reply(answer, mainKeyboard(lang));
  } catch (err) {
    console.error("[tg text]", err?.message || err);
    await ctx.reply(lang === "it" ? "Ok. Riproviamo." : "Ok. Try again.", mainKeyboard(lang));
  }
});
// ================== WHATSAPP WEBHOOK ==================

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

// Send message via Meta Cloud API
async function sendWhatsAppText(to, body) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID) {
    console.warn("⚠️ WhatsApp env missing (WHATSAPP_TOKEN / WHATSAPP_PHONE_ID).");
    return;
  }
  await fetch(`https://graph.facebook.com/v19.0/${WHATSAPP_PHONE_ID}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      text: { body },
    }),
  });
}

// Messages (POST)
app.post("/whatsapp/webhook", async (req, res) => {
  // Respond fast to Meta
  res.sendStatus(200);

  try {
    const payload = req.body;

    if (payload?.object !== "whatsapp_business_account") return;

    const entry = payload.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const message = value?.messages?.[0];
    if (!message) return; // ignore statuses etc

    const from = message.from; // wa_id (phone as string)
    const text = message.text?.body || "";

    if (!from || !text) return;
    if (tooSoon("wa:" + from)) return;

    console.log(`📩 WhatsApp from ${from}: ${text}`);

    // ensure prefs exist
    await ensureWaPrefs(from);

    // lock phrase on WhatsApp too
    if (text.trim() === "Lock friend mode.") {
      await setWaPrefs(from, { mode: "friend", allow_emojis: true });
      await sendWhatsAppText(from, "🔒 Friend mode locked. ✅");
      return;
    }

    const lang = detectLangFromText(text) || "en";
    const prefs = await getWaPrefs(from);
    const userUsedEmojiRecently = isEmojiRecent(text);

    await saveMessageWhatsApp(from, "user", text);

    const history = await getRecentHistoryWhatsApp(from, 10);

    const answerRaw = await askLLM({
      lang,
      prefs,
      history,
      userText: text,
      userUsedEmojiRecently,
    });

    const answer = cleanupAssistantText(answerRaw, prefs, userUsedEmojiRecently);

    await saveMessageWhatsApp(from, "assistant", answer);
    await sendWhatsAppText(from, answer);
  } catch (err) {
    console.error("❌ WhatsApp webhook error:", err?.message || err);
  }
});

// ================== TELEGRAM WEBHOOK ==================
const SECRET_PATH = "/tg-webhook";
const WEBHOOK_URL = `${PUBLIC_URL}${SECRET_PATH}`;
console.log("WEBHOOK_URL:", WEBHOOK_URL);

// ✅ IMPORTANT: this is the correct Express usage
app.use(bot.webhookCallback(SECRET_PATH));

async function setupTelegramWebhook() {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook?drop_pending_updates=true`);
    const resp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: WEBHOOK_URL,
        allowed_updates: ["message", "callback_query"],
      }),
    });
    console.log("[setWebhook]", await resp.json());
  } catch (err) {
    console.error("[setWebhook] failed:", err?.message || err);
  }
}

// ================== JOURNAL WEBAPP ==================
function journalHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>HITH · Journal</title>
<style>
  :root{--bg:#050507;--text:#f5f5f5;--muted:#a7a7a7;--line:rgba(255,255,255,.08)}
  body{margin:0;font-family:system-ui;background:radial-gradient(circle at top,#222 0,#050507 55%);color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:18px}
  .card{max-width:980px;width:100%;background:rgba(0,0,0,.72);border:1px solid var(--line);border-radius:18px;padding:16px}
  h1{margin:0 0 10px;font-size:18px}
  input,textarea{width:100%;background:rgba(255,255,255,.03);color:var(--text);border:1px solid var(--line);border-radius:12px;padding:12px;outline:none}
  textarea{min-height:320px;resize:vertical;line-height:1.55}
  .row{display:flex;gap:10px;flex-wrap:wrap;margin-top:10px}
  button{background:rgba(255,255,255,.03);border:1px solid var(--line);color:var(--text);border-radius:12px;padding:10px 12px;cursor:pointer}
  .hint{margin-top:10px;font-size:12px;color:var(--muted)}
</style>
</head>
<body>
  <div class="card">
    <h1>HITH · Journal</h1>
    <input id="title" placeholder="Title (optional)" />
    <div style="height:10px"></div>
    <textarea id="content" placeholder="Write here…"></textarea>
    <div class="row">
      <button id="save">Save</button>
      <button id="share">Share</button>
      <button id="print">Print</button>
      <button id="clear">Clear</button>
    </div>
    <div class="hint">Saved notes are stored in Supabase (tg_id).</div>
  </div>

<script>
  const qs = new URLSearchParams(location.search);
  const tg_id = qs.get("tg_id");

  const titleEl = document.getElementById("title");
  const contentEl = document.getElementById("content");

  async function api(path, body){
    const r = await fetch(path, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body) });
    if(!r.ok) throw new Error(await r.text());
    return r.json();
  }

  document.getElementById("save").onclick = async ()=>{
    const title = (titleEl.value||"").trim();
    const content = (contentEl.value||"").trim();
    if(!tg_id || !content) return;
    await api("/api/journal/save", { tg_id, title, content });
    alert("Saved");
  };

  document.getElementById("share").onclick = async ()=>{
    const text = (contentEl.value||"").trim();
    if(!text) return;
    try{
      if(navigator.share){ await navigator.share({ title: titleEl.value||"Journal", text }); }
      else { await navigator.clipboard.writeText(text); alert("Copied"); }
    }catch(e){}
  };

  document.getElementById("print").onclick = ()=>{
    const title = (titleEl.value||"Journal").trim();
    const content = (contentEl.value||"").trim();
    const w = window.open("", "_blank");
    w.document.write("<pre style='font-family:system-ui;white-space:pre-wrap'>"+title+"\\n\\n"+content+"</pre>");
    w.document.close(); w.focus(); w.print(); w.close();
  };

  document.getElementById("clear").onclick = ()=>{ titleEl.value=""; contentEl.value=""; };
</script>
</body>
</html>`;
}

app.get("/journal", (_req, res) => res.status(200).send(journalHtml()));

app.get("/progress", (_req, res) => {
  res.status(200).send("HITH Progress — coming next.");
});

app.post("/api/journal/save", async (req, res) => {
  try {
    const { tg_id, title, content } = req.body || {};
    if (!tg_id || !content) return res.status(400).json({ ok: false });

    const { error } = await supabase.from(SUPABASE_JOURNAL_TABLE).insert([
      { tg_id: Number(tg_id), title: title || null, content },
    ]);
    if (error) throw error;

    res.json({ ok: true });
  } catch (e) {
    console.error("[/api/journal/save]", e?.message || e);
    res.status(500).json({ ok: false });
  }
});


// ================== BASE ROUTE ==================
app.get("/", (_req, res) => {
  res.status(200).send("HITH bot is running.");
});

// ================== START SERVER ==================
app.listen(PORT, async () => {
  console.log(`🚀 Server listening on ${PORT}`);
  console.log(`🌍 PUBLIC_URL base: ${PUBLIC_URL}`);
  console.log(`🤖 Telegram webhook URL: ${WEBHOOK_URL}`);

  await setupTelegramWebhook();

  // Supabase connection test
  try {
    const { error } = await supabase
      .from(SUPABASE_USERS_TABLE)
      .select("id", { head: true, count: "exact" });

    if (error) console.error("❌ Supabase connection error:", error.message);
    else console.log("✅ Supabase connection OK");
  } catch (err) {
    console.error("❌ Supabase connection error:", err?.message || err);
  }
});

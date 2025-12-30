// index.js — HITH bot (Telegram Webhook) + Supabase + OpenAI + Journal WebApp
// Fix: no duplicate initBotIdentity, menus open submenus (no LLM), language mirrors user, memory ON, no emojis.

import express from "express";
import { Telegraf, Markup } from "telegraf";
import { createClient } from "@supabase/supabase-js";

// ================= ENV =================
const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_KEY;

const SUPABASE_USERS_TABLE =
  process.env.SUPABASE_USERS_TABLE || process.env.SUPABASE_TABLE || "users";
const SUPABASE_MESSAGES_TABLE =
  process.env.SUPABASE_MESSAGES_TABLE || "messages";
const SUPABASE_PREFS_TABLE =
  process.env.SUPABASE_PREFS_TABLE || "user_prefs";
const SUPABASE_JOURNAL_TABLE =
  process.env.SUPABASE_JOURNAL_TABLE || "journal_entries";

const RAW_PUBLIC_URL = process.env.PUBLIC_URL || process.env.WEBHOOK_DOMAIN || "";
const PORT = Number(process.env.PORT) || 10000;

function die(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}
if (!BOT_TOKEN) die("Missing BOT_TOKEN");
if (!OPENAI_API_KEY) die("Missing OPENAI_API_KEY");
if (!SUPABASE_URL || !SUPABASE_KEY) die("Missing SUPABASE_URL / SUPABASE_KEY");
if (!RAW_PUBLIC_URL) die("Missing PUBLIC_URL (or WEBHOOK_DOMAIN)");

const PUBLIC_URL = RAW_PUBLIC_URL.trim().replace(/\/+$/, "");
if (!/^https:\/\//i.test(PUBLIC_URL)) die(`PUBLIC_URL must start with https:// (got "${PUBLIC_URL}")`);

// ================= CLIENTS =================
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));

const bot = new Telegraf(BOT_TOKEN);

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

let BOT_USERNAME = process.env.BOT_USERNAME || "";

// ================= DEFAULT PREFS (Memory ON) =================
const DEFAULT_PREFS = {
  memory_on: true,
  lang: "en",
  no_emojis: true,     // locked true
  no_questions: true,  // reduces nag
  no_next_steps: true, // removes “next step” coaching nag
  max_reply_chars: 360,
};

// ================= UI =================
const MENU = {
  JOURNAL: "📔 Journal",
  PROGRESS: "📊 Progress",
  COACH: "📌 Coach",
  SOS: "⚡ SOS",
  INVITE: "🔗 Invite",
  SETTINGS: "⚙️ Settings",
};

function mainKeyboard(lang) {
  const settings =
    lang === "it" ? "⚙️ Impostazioni" : lang === "de" ? "⚙️ Einstellungen" : "⚙️ Settings";
  const progress =
    lang === "it" ? "📊 Progress" : lang === "de" ? "📊 Fortschritt" : "📊 Progress";
  const invite =
    lang === "it" ? "🔗 Invite" : lang === "de" ? "🔗 Einladen" : "🔗 Invite";
  return Markup.keyboard([
    [Markup.button.text(MENU.JOURNAL), Markup.button.text(progress)],
    [Markup.button.text(MENU.COACH), Markup.button.text(MENU.SOS)],
    [Markup.button.text(invite), Markup.button.text(settings)],
  ]).resize();
}

function startText(lang) {
  if (lang === "it") return "Ciao. Sono HITH.";
  if (lang === "de") return "Hi. Ich bin HITH.";
  return "Hi. I’m HITH.";
}

// ================= LANGUAGE DETECTION =================
function detectLangFromText(text = "") {
  const t = text.trim();

  if (/[äöüßÄÖÜ]/.test(t)) return "de";
  if (/\b(und|nicht|doch|ich|du|wir|ihr|sie|bitte|danke|heute)\b/i.test(t)) return "de";

  if (/[àèéìòùÀÈÉÌÒÙ]/.test(t)) return "it";
  if (/\b(che|non|perché|oggi|bene|grazie|ciao|come|stai|voglio|sono)\b/i.test(t)) return "it";

  return "en";
}

// ================= MENU DETECTION =================
function normalizeBtn(text = "") {
  return text
    .replace(/[\uFE0F\u200D]/g, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}
function menuKey(text = "") {
  return normalizeBtn(text).replace(/[^a-zàèéìòùüöäß0-9 ]/gi, "").trim();
}

// ================= MODES =================
const userMode = new Map(); // tg_id -> friend/coach/sos
function setMode(tg_id, mode) { userMode.set(tg_id, mode); }
function getMode(tg_id) { return userMode.get(tg_id) || "friend"; }

// ================= PREFS =================
async function ensureUser(ctx, lang) {
  const tg_id = ctx.from.id;
  const first_name = ctx.from.first_name || "";

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
    console.error("[ensureUser]", err?.message || err);
  }
}

async function loadPrefs(tg_id) {
  try {
    const { data, error } = await supabase
      .from(SUPABASE_PREFS_TABLE)
      .select("*")
      .eq("tg_id", tg_id)
      .maybeSingle();
    if (error) throw error;

    if (!data) {
      const row = { tg_id, ...DEFAULT_PREFS };
      const { error: insErr } = await supabase.from(SUPABASE_PREFS_TABLE).insert([row]);
      if (insErr) throw insErr;
      return row;
    }

    // enforce locked values
    const merged = { ...DEFAULT_PREFS, ...data, memory_on: true, no_emojis: true };
    if (data.memory_on !== true || data.no_emojis !== true) {
      await supabase
        .from(SUPABASE_PREFS_TABLE)
        .update({ memory_on: true, no_emojis: true })
        .eq("tg_id", tg_id);
    }
    return merged;
  } catch (err) {
    console.error("[loadPrefs]", err?.message || err);
    return { tg_id, ...DEFAULT_PREFS };
  }
}

async function setPrefsLang(tg_id, lang) {
  try {
    await supabase.from(SUPABASE_PREFS_TABLE).update({ lang }).eq("tg_id", tg_id);
  } catch (err) {
    console.error("[setPrefsLang]", err?.message || err);
  }
}

// ================= HISTORY =================
async function saveMessage(tg_id, role, content) {
  try {
    await supabase.from(SUPABASE_MESSAGES_TABLE).insert([{ tg_id, role, content }]);
  } catch (err) {
    console.error("[saveMessage]", err?.message || err);
  }
}
async function getRecentHistory(tg_id, limit = 8) {
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

// ================= ENFORCERS =================
function stripEmojis(text = "") {
  return text.replace(/\p{Extended_Pictographic}/gu, "").replace(/[\uFE0F\u200D]/g, "");
}
function removeQuestions(text = "") {
  let t = text.trim();
  const lines = t.split("\n");
  while (lines.length && lines[lines.length - 1].trim().endsWith("?")) lines.pop();
  t = lines.join("\n").replace(/\?/g, "").trim();
  return t;
}
function removeNextSteps(text = "", lang = "en") {
  let t = text;
  const patterns = [
    /(un passo utile potrebbe|prova a|ti consiglio di|potresti|se vuoi)/gim,
    /(ein schritt|du könntest|wenn du willst|versuch mal)/gim,
    /(a next step|you could|try to|if you want)/gim,
  ];
  for (const p of patterns) t = t.replace(p, "").trim();
  return t;
}
function enforcePrefs(answer, prefs, lang) {
  let out = (answer || "").trim();
  if (prefs?.no_emojis) out = stripEmojis(out);
  if (prefs?.no_next_steps) out = removeNextSteps(out, lang);
  if (prefs?.no_questions) out = removeQuestions(out);

  const max = Number(prefs?.max_reply_chars || DEFAULT_PREFS.max_reply_chars);
  if (out.length > max) out = out.slice(0, max).trim();

  if (!out) out = lang === "it" ? "Sono qui." : lang === "de" ? "Ich bin da." : "I’m here.";
  return out;
}

// ================= PROMPTS =================
function systemPrompt(mode, lang) {
  if (mode === "coach") {
    return `
You are HITH. Your name is HITH.
Mode: COACH. Be practical and short. No therapy tone. No emojis.
Reply in ${lang}.
`.trim();
  }
  if (mode === "sos") {
    return `
You are HITH. Your name is HITH.
Mode: SOS. 1–4 short lines. No diagnosis. No therapy tone. No emojis.
Reply in ${lang}.
`.trim();
  }
  return `
You are HITH. Your name is HITH.
You are a calm friend, not a therapist.
STYLE: 1–2 natural sentences. No lectures. No exercises. No emojis.
Reply in ${lang}.
`.trim();
}

// ================= OPENAI =================
async function fetchWithTimeout(url, options = {}, ms = 25000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal }); // Node 18+ has fetch
  } finally {
    clearTimeout(id);
  }
}

async function askLLM(lang, mode, history, userText) {
  const messages = [
    { role: "system", content: systemPrompt(mode, lang) },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: userText },
  ];

  const resp = await fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.35,
      max_tokens: 240,
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`OpenAI ${resp.status}: ${txt}`);
  }

  const json = await resp.json();
  return json.choices?.[0]?.message?.content?.trim() || "";
}

// ================= SUBMENUS =================
function journalMenu(lang) {
  const open = lang === "it" ? "Apri Journal" : lang === "de" ? "Journal öffnen" : "Open Journal";
  const recent = lang === "it" ? "Ultimi salvataggi" : lang === "de" ? "Letzte Einträge" : "Recent saves";
  return Markup.inlineKeyboard([
    [Markup.button.webApp(open, `${PUBLIC_URL}/journal`)],
    [Markup.button.callback(recent, "JOURNAL_RECENT")],
  ]);
}
function progressMenu(lang) {
  const w = lang === "it" ? "Settimana" : lang === "de" ? "Woche" : "Week";
  const m = lang === "it" ? "Mese" : lang === "de" ? "Monat" : "Month";
  return Markup.inlineKeyboard([
    [Markup.button.callback(w, "PROGRESS_WEEK")],
    [Markup.button.callback(m, "PROGRESS_MONTH")],
  ]);
}
function coachMenu(lang) {
  const g = lang === "it" ? "Obiettivo" : lang === "de" ? "Ziel" : "Goal";
  const p = lang === "it" ? "Piano" : lang === "de" ? "Plan" : "Plan";
  const stop = lang === "it" ? "Stop Coach" : lang === "de" ? "Stop Coach" : "Stop Coach";
  return Markup.inlineKeyboard([
    [Markup.button.callback(g, "COACH_GOAL")],
    [Markup.button.callback(p, "COACH_PLAN")],
    [Markup.button.callback(stop, "MODE_FRIEND")],
  ]);
}
function sosMenu(lang) {
  const b = lang === "it" ? "Respiro 30s" : lang === "de" ? "Atem 30s" : "Breath 30s";
  const r = lang === "it" ? "Reset" : "Reset";
  const stop = lang === "it" ? "Stop SOS" : "Stop SOS";
  return Markup.inlineKeyboard([
    [Markup.button.callback(b, "SOS_BREATH")],
    [Markup.button.callback(r, "SOS_RESET")],
    [Markup.button.callback(stop, "MODE_FRIEND")],
  ]);
}
function settingsMenu() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("IT", "LANG_IT"),
      Markup.button.callback("EN", "LANG_EN"),
      Markup.button.callback("DE", "LANG_DE"),
    ],
    [Markup.button.callback("Friend mode", "MODE_FRIEND")],
  ]);
}
async function inviteText(lang) {
  const link = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}` : "https://t.me/";
  if (lang === "it") return `Invita un’amica:\n${link}`;
  if (lang === "de") return `Lade eine Freundin ein:\n${link}`;
  return `Invite a friend:\n${link}`;
}

// ================= TELEGRAM HANDLERS =================
bot.start(async (ctx) => {
  const tg_id = ctx.from.id;
  let prefs = await loadPrefs(tg_id);

  const initialLang = prefs.lang || (ctx.from?.language_code || "en").slice(0, 2);
  prefs.lang = ["it", "en", "de"].includes(initialLang) ? initialLang : "en";
  await setPrefsLang(tg_id, prefs.lang);

  await ensureUser(ctx, prefs.lang);
  setMode(tg_id, "friend");

  await ctx.reply(startText(prefs.lang), mainKeyboard(prefs.lang));
});

bot.on("text", async (ctx) => {
  const raw = ctx.message.text?.trim() || "";
  const k = menuKey(raw);
  const tg_id = ctx.from.id;

  let prefs = await loadPrefs(tg_id);

  // Language for THIS message: detect from user text; persist if different
  const detected = detectLangFromText(raw);
  let lang = prefs.lang || detected || "en";
  if (detected && detected !== lang) {
    lang = detected;
    await setPrefsLang(tg_id, lang);
    prefs.lang = lang;
  }

  await ensureUser(ctx, lang);

  // MENU: never call OpenAI
  if (k === "journal") { setMode(tg_id, "friend"); await ctx.reply("Journal", journalMenu(lang)); return; }
  if (k === "progress" || k === "fortschritt") { setMode(tg_id, "friend"); await ctx.reply("Progress", progressMenu(lang)); return; }
  if (k === "coach") { setMode(tg_id, "coach"); await ctx.reply("Coach", coachMenu(lang)); return; }
  if (k === "sos") { setMode(tg_id, "sos"); await ctx.reply("SOS", sosMenu(lang)); return; }
  if (k === "invite" || k === "einladen") { setMode(tg_id, "friend"); await ctx.reply(await inviteText(lang), mainKeyboard(lang)); return; }
  if (k === "impostazioni" || k === "settings" || k === "einstellungen") { setMode(tg_id, "friend"); await ctx.reply("Settings", settingsMenu()); return; }

  // Name: HITH
  const lower = raw.toLowerCase();
  if (
    lower.includes("your name") ||
    lower.includes("who are you") ||
    lower.includes("come ti chiami") ||
    lower.includes("chi sei") ||
    lower.includes("wie heißt du")
  ) {
    const msg = lang === "it" ? "Mi chiamo HITH." : lang === "de" ? "Ich heiße HITH." : "My name is HITH.";
    await ctx.reply(enforcePrefs(msg, prefs, lang), mainKeyboard(lang));
    return;
  }

  await saveMessage(tg_id, "user", raw);

  const mode = getMode(tg_id);

  try {
    await ctx.sendChatAction("typing");
    const history = await getRecentHistory(tg_id, 8);
    const answerRaw = await askLLM(lang, mode, history, raw);
    const answer = enforcePrefs(answerRaw, prefs, lang);
    await saveMessage(tg_id, "assistant", answer);
    await ctx.reply(answer, mainKeyboard(lang));
  } catch (err) {
    console.error("[text handler]", err?.message || err);
    const fallback = lang === "it" ? "Sono qui." : lang === "de" ? "Ich bin da." : "I’m here.";
    const out = enforcePrefs(fallback, prefs, lang);
    await saveMessage(tg_id, "assistant", out);
    await ctx.reply(out, mainKeyboard(lang));
  }
});

// callbacks
bot.on("callback_query", async (ctx) => {
  const tg_id = ctx.from.id;
  const data = ctx.callbackQuery?.data || "";
  let prefs = await loadPrefs(tg_id);
  const lang = prefs.lang || "en";

  try { await ctx.answerCbQuery(); } catch {}

  if (data === "MODE_FRIEND") { setMode(tg_id, "friend"); await ctx.reply(enforcePrefs("Ok.", prefs, lang)); return; }

  if (data === "LANG_IT" || data === "LANG_EN" || data === "LANG_DE") {
    const newLang = data === "LANG_IT" ? "it" : data === "LANG_DE" ? "de" : "en";
    await setPrefsLang(tg_id, newLang);
    prefs.lang = newLang;
    const msg = newLang === "it" ? "Lingua aggiornata." : newLang === "de" ? "Sprache aktualisiert." : "Language updated.";
    await ctx.reply(enforcePrefs(msg, prefs, newLang), mainKeyboard(newLang));
    return;
  }

  if (data === "JOURNAL_RECENT") {
    try {
      const { data: rows } = await supabase
        .from(SUPABASE_JOURNAL_TABLE)
        .select("title, created_at")
        .eq("tg_id", tg_id)
        .order("created_at", { ascending: false })
        .limit(5);

      if (!rows || rows.length === 0) {
        const msg = lang === "it" ? "Nessun salvataggio ancora." : lang === "de" ? "Noch keine Einträge." : "No saves yet.";
        await ctx.reply(enforcePrefs(msg, prefs, lang));
        return;
      }

      const lines = rows.map((r) => {
        const d = new Date(r.created_at).toLocaleString(
          lang === "it" ? "it-IT" : lang === "de" ? "de-DE" : "en-US"
        );
        return `- ${(r.title || "Untitled")} (${d})`;
      });

      await ctx.reply(enforcePrefs(lines.join("\n"), prefs, lang));
    } catch {
      const msg = lang === "it" ? "Errore nel caricare i salvataggi." : "Could not load saves.";
      await ctx.reply(enforcePrefs(msg, prefs, lang));
    }
    return;
  }

  if (data === "PROGRESS_WEEK" || data === "PROGRESS_MONTH") {
    const msg = lang === "it" ? "Progress in arrivo." : lang === "de" ? "Fortschritt kommt bald." : "Progress coming soon.";
    await ctx.reply(enforcePrefs(msg, prefs, lang));
    return;
  }

  if (data === "SOS_BREATH") {
    const msg =
      lang === "it"
        ? "Inspira 4. Trattieni 2. Espira 6. Ripeti 3 volte."
        : lang === "de"
        ? "Einatmen 4. Halten 2. Ausatmen 6. Dreimal."
        : "Inhale 4. Hold 2. Exhale 6. Repeat 3 times.";
    await ctx.reply(enforcePrefs(msg, prefs, lang));
    return;
  }

  if (data === "SOS_RESET") {
    const msg =
      lang === "it"
        ? "Guarda 5 cose. Tocca 4. Ascolta 3. Odora 2. Assapora 1."
        : lang === "de"
        ? "Sieh 5. Berühr 4. Hör 3. Riech 2. Schmeck 1."
        : "See 5. Touch 4. Hear 3. Smell 2. Taste 1.";
    await ctx.reply(enforcePrefs(msg, prefs, lang));
    return;
  }

  if (data === "COACH_GOAL") {
    setMode(tg_id, "coach");
    const msg = lang === "it" ? "Scrivi l’obiettivo in una frase." : lang === "de" ? "Sag dein Ziel in einem Satz." : "Write your goal in one sentence.";
    await ctx.reply(enforcePrefs(msg, prefs, lang));
    return;
  }

  if (data === "COACH_PLAN") {
    setMode(tg_id, "coach");
    const msg = lang === "it" ? "Cosa vuoi ottenere in 7 giorni." : lang === "de" ? "Was willst du in 7 Tagen schaffen." : "What do you want in 7 days.";
    await ctx.reply(enforcePrefs(msg, prefs, lang));
    return;
  }
});

// ================= JOURNAL WEB APP =================
app.post("/api/journal/save", async (req, res) => {
  try {
    const { tg_id, title, content } = req.body || {};
    if (!tg_id || !content) return res.status(400).json({ error: "missing tg_id/content" });

    const safeTitle = (title || "").toString().slice(0, 140);
    const safeContent = content.toString();

    const { data, error } = await supabase
      .from(SUPABASE_JOURNAL_TABLE)
      .insert([{ tg_id: Number(tg_id), title: safeTitle, content: safeContent }])
      .select("id")
      .single();

    if (error) throw error;
    return res.json({ ok: true, id: data.id });
  } catch (err) {
    console.error("[/api/journal/save]", err?.message || err);
    return res.status(500).json({ error: "save_failed" });
  }
});

app.get("/journal", (_req, res) => {
  res.status(200).send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>HITH Journal</title>
<script src="https://telegram.org/js/telegram-web-app.js"></script>
<style>
  :root{--bg:#050507;--card:#0f0f12;--gold:#d4af37;--text:#f5f5f5;--muted:#a9a9a9;}
  body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:radial-gradient(circle at top,#1b1b1f 0,#050507 55%);color:var(--text);}
  .wrap{max-width:860px;margin:0 auto;padding:18px;}
  .brand{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;}
  .brand h1{font-size:18px;margin:0;font-weight:650;letter-spacing:.2px}
  .card{background:rgba(0,0,0,.55);border:1px solid rgba(212,175,55,.18);border-radius:16px;padding:14px;backdrop-filter: blur(8px);}
  input,textarea{width:100%;background:#0b0b0e;border:1px solid rgba(255,255,255,.08);border-radius:12px;color:var(--text);padding:12px;font-size:15px;outline:none;}
  textarea{min-height:48vh;resize:vertical;line-height:1.4}
  .row{display:flex;gap:10px;flex-wrap:wrap;margin-top:10px}
  button{cursor:pointer;border:1px solid rgba(212,175,55,.30);background:rgba(212,175,55,.10);color:var(--text);padding:10px 12px;border-radius:12px;font-size:14px}
  button.primary{background:rgba(212,175,55,.22)}
  .hint{color:var(--muted);font-size:12px;margin-top:10px}
  .ok{color:#86efac;font-size:12px;margin-top:8px;display:none}
  .err{color:#fca5a5;font-size:12px;margin-top:8px;display:none}
</style>
</head>
<body>
  <div class="wrap">
    <div class="brand">
      <h1>HITH Journal</h1>
      <div style="color:var(--muted);font-size:12px" id="who"></div>
    </div>

    <div class="card">
      <input id="title" placeholder="Title (optional)" />
      <div style="height:10px"></div>
      <textarea id="content" placeholder="Write here..."></textarea>

      <div class="row">
        <button class="primary" id="saveBtn">Save</button>
        <button id="shareBtn">Share</button>
        <button id="printBtn">Print</button>
        <button id="clearBtn">Clear</button>
      </div>

      <div class="ok" id="ok">Saved</div>
      <div class="err" id="err">Could not save.</div>

      <div class="hint">Draft saves locally. Save stores permanently in your database.</div>
    </div>
  </div>

<script>
  const tg = window.Telegram?.WebApp;
  if (tg) { tg.ready(); tg.expand(); }

  const who = document.getElementById('who');
  const titleEl = document.getElementById('title');
  const contentEl = document.getElementById('content');
  const okEl = document.getElementById('ok');
  const errEl = document.getElementById('err');

  function flash(el){ el.style.display='block'; setTimeout(()=>el.style.display='none',1500); }

  const tgId = tg?.initDataUnsafe?.user?.id || null;
  const name = tg?.initDataUnsafe?.user?.first_name || '';
  who.textContent = tgId ? ('@ ' + name) : '';

  const DKEY = 'hith_journal_draft';
  try{
    const draft = JSON.parse(localStorage.getItem(DKEY) || '{}');
    if (draft.title) titleEl.value = draft.title;
    if (draft.content) contentEl.value = draft.content;
  }catch(e){}

  function saveDraft(){
    localStorage.setItem(DKEY, JSON.stringify({title:titleEl.value, content:contentEl.value}));
  }
  titleEl.addEventListener('input', saveDraft);
  contentEl.addEventListener('input', saveDraft);

  document.getElementById('saveBtn').onclick = async () => {
    okEl.style.display='none'; errEl.style.display='none';
    const content = contentEl.value.trim();
    if (!content) return;

    try{
      const resp = await fetch('/api/journal/save', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          tg_id: tgId || 0,
          title: titleEl.value || '',
          content
        })
      });
      const json = await resp.json();
      if (!resp.ok || !json.ok) throw new Error('save_failed');
      flash(okEl);
    }catch(e){
      flash(errEl);
    }
  };

  document.getElementById('shareBtn').onclick = async () => {
    const text = contentEl.value.trim();
    if (!text) return;
    try{
      if (navigator.share){
        await navigator.share({ title: titleEl.value || 'HITH Journal', text });
      } else {
        await navigator.clipboard.writeText(text);
        alert('Copied');
      }
    }catch(e){}
  };

  document.getElementById('printBtn').onclick = () => window.print();
  document.getElementById('clearBtn').onclick = () => {
    titleEl.value=''; contentEl.value='';
    localStorage.removeItem(DKEY);
  };
</script>
</body>
</html>`);
});

// ================= TELEGRAM WEBHOOK =================
const SECRET_PATH = "/tg-webhook";
const WEBHOOK_URL = `${PUBLIC_URL}${SECRET_PATH}`;

// Telegraf webhook callback (clean & reliable)
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

// ================= BASE ROUTE =================
app.get("/", (_req, res) => res.status(200).send("HITH bot is running."));

// ================= BOT IDENTITY (ONLY ONCE) =================
async function initBotIdentity() {
  try {
    const me = await bot.telegram.getMe();
    BOT_USERNAME = me.username || BOT_USERNAME || "";
    console.log("🤖 Bot username:", BOT_USERNAME);
  } catch (e) {
    console.log("⚠️ Cannot get bot username:", e?.message || e);
  }
}

// ================= BOOT =================
const server = app.listen(PORT, async () => {
  console.log(`🚀 Server listening on ${PORT}`);
  console.log(`🌍 PUBLIC_URL: ${PUBLIC_URL}`);
  console.log(`🤖 Telegram webhook: ${WEBHOOK_URL}`);

  await initBotIdentity();
  await setupTelegramWebhook();
});

function shutdown(signal) {
  console.log(`🛑 ${signal} received. Shutting down...`);
  server.close(() => process.exit(0));
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// index.js — HITH bot (Telegram Webhook) + Supabase + OpenAI + Journal WebApp
// ✅ Fixes in this version:
// 1) NO therapeutic nag: default = FRIEND mode (short, no coaching tone, no "next steps", no questions unless asked)
// 2) Menu buttons NEVER go to OpenAI; they open real submenus (inline buttons) every time
// 3) Journal opens a real page: write / save / share / print
// 4) Invite shows correct t.me/<botusername> (auto-detected via getMe())
// 5) HITH knows its name (hard-coded response when asked)

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

// journal table (create it in Supabase)
const SUPABASE_JOURNAL_TABLE =
  process.env.SUPABASE_JOURNAL_TABLE || "journal_entries";

// Render URL
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
if (!/^https:\/\//i.test(PUBLIC_URL)) {
  die(`PUBLIC_URL must start with https:// (got "${PUBLIC_URL}")`);
}

// ================= CLIENTS =================
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "2mb" }));

const bot = new Telegraf(BOT_TOKEN);

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

// bot username (auto)
let BOT_USERNAME = process.env.BOT_USERNAME || "";

// ================= LANGUAGE / UI =================
function detectLang(ctx) {
  const code = (ctx.from?.language_code || "en").slice(0, 2);
  if (["en", "it", "de"].includes(code)) return code;
  return "en";
}

const MENU = {
  JOURNAL: "📔 Journal",
  PROGRESS: "📊 Progress",
  COACH: "📌 Coach",
  SOS: "⚡ SOS",
  INVITE: "🔗 Invite",
  SETTINGS_IT: "⚙️ Impostazioni",
  SETTINGS_EN: "⚙️ Settings",
  SETTINGS_DE: "⚙️ Einstellungen",
};

function settingsLabel(lang) {
  if (lang === "it") return MENU.SETTINGS_IT;
  if (lang === "de") return MENU.SETTINGS_DE;
  return MENU.SETTINGS_EN;
}

function mainKeyboard(lang) {
  return Markup.keyboard([
    [Markup.button.text(MENU.JOURNAL), Markup.button.text(MENU.PROGRESS)],
    [Markup.button.text(MENU.COACH), Markup.button.text(MENU.SOS)],
    [Markup.button.text(MENU.INVITE), Markup.button.text(settingsLabel(lang))],
  ]).resize();
}

function startText(lang) {
  if (lang === "it") return "Ciao 🌿 Sono HITH.\nScrivimi come a un’amica.";
  if (lang === "de") return "Hi 🌿 Ich bin HITH.\nSchreib mir wie einer Freundin.";
  return "Hi 🌿 I’m HITH.\nTalk to me like a friend.";
}

// ================= “NO NAG” SYSTEM PROMPTS =================
const HITH_FRIEND_PROMPT = `
You are HITH. Your name is HITH.
You are not a therapist. You are a calm friend.

STYLE:
- Very short and natural.
- No lecture, no therapeutic tone, no "next steps", no exercises.
- Do NOT ask questions unless the user asked a question first.

RULES:
- If the user did NOT ask a question, do NOT ask questions back.
- Never propose "small steps" / "try this" / "exercise" unless the user explicitly asks for advice.
- Avoid phrases like: "Se vuoi possiamo...", "Un passo utile potrebbe...", "Vuoi provare..."
- If user sets boundaries ("non farmi domande", "non parlarmi di prossimi passi"), obey strictly.
- Prefer 1–2 sentences.
Language: mirror the user's language (it/en/de).

IDENTITY RULE:
- If asked your name: answer "Mi chiamo HITH." / "Ich heiße HITH." / "My name is HITH."
`;

const HITH_COACH_PROMPT = `
You are HITH in COACH mode. Your name is HITH.
Be practical and concise. Ask at most ONE question.
No therapeutic tone. No long lists.
Language: mirror the user's language (it/en/de).
`;

const HITH_SOS_PROMPT = `
You are HITH in SOS mode. Your name is HITH.
Keep it extremely brief and grounding (1–4 lines).
No diagnosis. No therapeutic talk. No long coaching.
Language: mirror the user's language (it/en/de).
`;

// ================= USER STATE =================
const userMode = new Map(); // tg_id -> "friend" | "coach" | "sos"
function setMode(tg_id, mode) {
  userMode.set(tg_id, mode);
}
function getMode(tg_id) {
  return userMode.get(tg_id) || "friend";
}

// ================= SUPABASE HELPERS =================
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
    console.error("[ensureUser]", err?.message || err);
  }
}

async function saveMessage(tg_id, role, content) {
  try {
    const { error } = await supabase
      .from(SUPABASE_MESSAGES_TABLE)
      .insert([{ tg_id, role, content }]);
    if (error) throw error;
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

// ================= MENU DETECTION (ROBUST) =================
function normalizeBtn(text = "") {
  return text
    .replace(/[\uFE0F\u200D]/g, "") // VS16 + ZWJ
    .replace(/\p{Extended_Pictographic}/gu, "") // emoji
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function menuKey(text = "") {
  return normalizeBtn(text).replace(/[^a-zàèéìòùüöäß0-9 ]/gi, "").trim();
}

// small affection => tiny reply (no OpenAI)
function isSmallAffection(text) {
  const t = text.trim().toLowerCase();
  return (
    t === "grazie" ||
    t === "thanks" ||
    t === "thank you" ||
    t === "ok" ||
    t === "okay" ||
    t === "bene" ||
    t === "ciao" ||
    t === "hey" ||
    t === "hi" ||
    t === "❤️" ||
    t === "💛"
  );
}

function tinyReply(lang) {
  if (lang === "it") return "Sono qui 🌿";
  if (lang === "de") return "Ich bin da 🌿";
  return "I’m here 🌿";
}

function userAsksName(text) {
  const t = text.toLowerCase();
  return (
    t.includes("come ti chiami") ||
    t.includes("qual è il tuo nome") ||
    t.includes("chi sei") ||
    t.includes("who are you") ||
    t.includes("your name")
  );
}

function hardBoundary(text) {
  const t = text.toLowerCase();
  return (
    t.includes("non farmi domande") ||
    t.includes("smetti di farmi domande") ||
    t.includes("non parlarmi di prossimi passi") ||
    t.includes("no questions") ||
    t.includes("stop asking") ||
    t.includes("no more questions")
  );
}

// ================= SUBMENUS (INLINE) =================
function journalMenu(lang) {
  const openText =
    lang === "it"
      ? "✍️ Apri Journal"
      : lang === "de"
      ? "✍️ Journal öffnen"
      : "✍️ Open Journal";
  const recentText =
    lang === "it"
      ? "🕘 Ultimi salvataggi"
      : lang === "de"
      ? "🕘 Letzte Einträge"
      : "🕘 Recent saves";

  return Markup.inlineKeyboard([
    [Markup.button.webApp(openText, `${PUBLIC_URL}/journal`)],
    [Markup.button.callback(recentText, "JOURNAL_RECENT")],
  ]);
}

function progressMenu(lang) {
  const weekly = lang === "it" ? "Settimana" : lang === "de" ? "Woche" : "Week";
  const month = lang === "it" ? "Mese" : lang === "de" ? "Monat" : "Month";
  return Markup.inlineKeyboard([
    [Markup.button.callback(`📅 ${weekly}`, "PROGRESS_WEEK")],
    [Markup.button.callback(`🗓️ ${month}`, "PROGRESS_MONTH")],
  ]);
}

function coachMenu(lang) {
  const goal = lang === "it" ? "🎯 Obiettivo" : lang === "de" ? "🎯 Ziel" : "🎯 Goal";
  const plan = lang === "it" ? "🧩 Piano" : lang === "de" ? "🧩 Plan" : "🧩 Plan";
  const stop = lang === "it" ? "🔕 Stop Coach" : "🔕 Stop Coach";
  return Markup.inlineKeyboard([
    [Markup.button.callback(goal, "COACH_GOAL")],
    [Markup.button.callback(plan, "COACH_PLAN")],
    [Markup.button.callback(stop, "MODE_FRIEND")],
  ]);
}

function sosMenu(lang) {
  const breathe =
    lang === "it" ? "🌬️ Respiro 30s" : lang === "de" ? "🌬️ Atem 30s" : "🌬️ 30s breath";
  const reset = "🧊 Reset";
  const stop = lang === "it" ? "🔕 Stop SOS" : "🔕 Stop SOS";
  return Markup.inlineKeyboard([
    [Markup.button.callback(breathe, "SOS_BREATH")],
    [Markup.button.callback(reset, "SOS_RESET")],
    [Markup.button.callback(stop, "MODE_FRIEND")],
  ]);
}

function settingsMenu(lang) {
  const title =
    lang === "it" ? "⚙️ Impostazioni" : lang === "de" ? "⚙️ Einstellungen" : "⚙️ Settings";
  return { title, kb: Markup.inlineKeyboard([
    [
      Markup.button.callback("🇮🇹 IT", "LANG_IT"),
      Markup.button.callback("🇬🇧 EN", "LANG_EN"),
      Markup.button.callback("🇩🇪 DE", "LANG_DE"),
    ],
    [Markup.button.callback(lang === "it" ? "🔕 Modalità amica" : lang === "de" ? "🔕 Freund-Modus" : "🔕 Friend mode", "MODE_FRIEND")],
  ])};
}

async function inviteText(lang) {
  const link = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}` : "https://t.me/";
  if (lang === "it") return `Invita un’amica:\n${link}`;
  if (lang === "de") return `Lade eine Freundin ein:\n${link}`;
  return `Invite a friend:\n${link}`;
}

// ================= OPENAI =================
async function fetchWithTimeout(url, options = {}, ms = 25000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(id);
  }
}

function pickSystemPrompt(mode) {
  if (mode === "coach") return HITH_COACH_PROMPT;
  if (mode === "sos") return HITH_SOS_PROMPT;
  return HITH_FRIEND_PROMPT;
}

async function askLLM(lang, mode, history, userText) {
  const system = pickSystemPrompt(mode);
  const messages = [
    { role: "system", content: system + `\nUser language: ${lang}` },
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
      max_tokens: 220,
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`OpenAI ${resp.status}: ${txt}`);
  }

  const json = await resp.json();
  return json.choices?.[0]?.message?.content?.trim() || tinyReply(lang);
}

// ================= BOT IDENTITY =================
async function initBotIdentity() {
  try {
    const me = await bot.telegram.getMe();
    BOT_USERNAME = me.username || BOT_USERNAME || "";
    console.log("🤖 Bot username:", BOT_USERNAME);
  } catch (e) {
    console.log("⚠️ Cannot get bot username:", e?.message || e);
  }
}

// ================= TELEGRAM HANDLERS =================
bot.start(async (ctx) => {
  const lang = detectLang(ctx);
  await ensureUser(ctx);
  setMode(ctx.from.id, "friend");
  await ctx.reply(startText(lang), mainKeyboard(lang));
});

// All text messages (including menu buttons)
bot.on("text", async (ctx) => {
  const raw = ctx.message.text?.trim() || "";
  const k = menuKey(raw);
  const tg_id = ctx.from.id;
  const lang = detectLang(ctx);

  await ensureUser(ctx);

  // ---- MENU: never call OpenAI here ----
  if (k === "journal") {
    setMode(tg_id, "friend");
    await ctx.reply("📔 Journal", journalMenu(lang));
    return;
  }

  if (k === "progress") {
    setMode(tg_id, "friend");
    await ctx.reply("📊 Progress", progressMenu(lang));
    return;
  }

  if (k === "coach") {
    setMode(tg_id, "coach");
    await ctx.reply("📌 Coach", coachMenu(lang));
    return;
  }

  if (k === "sos") {
    setMode(tg_id, "sos");
    await ctx.reply("⚡ SOS", sosMenu(lang));
    return;
  }

  if (k === "invite") {
    setMode(tg_id, "friend");
    await ctx.reply(await inviteText(lang), mainKeyboard(lang));
    return;
  }

  if (k === "impostazioni" || k === "settings" || k === "einstellungen") {
    setMode(tg_id, "friend");
    const m = settingsMenu(lang);
    await ctx.reply(m.title, m.kb);
    return;
  }

  // ---- HARD IDENTITY (HITH) ----
  if (userAsksName(raw)) {
    const ans =
      lang === "it" ? "Mi chiamo HITH." : lang === "de" ? "Ich heiße HITH." : "My name is HITH.";
    await ctx.reply(ans, mainKeyboard(lang));
    return;
  }

  // ---- HARD BOUNDARY ----
  if (hardBoundary(raw)) {
    setMode(tg_id, "friend");
    await ctx.reply(tinyReply(lang), mainKeyboard(lang));
    return;
  }

  // ---- SMALL affection ----
  if (isSmallAffection(raw)) {
    await ctx.reply(tinyReply(lang), mainKeyboard(lang));
    return;
  }

  // ---- Normal conversation ----
  const mode = getMode(tg_id);

  await saveMessage(tg_id, "user", raw);

  try {
    await ctx.sendChatAction("typing");
    const history = await getRecentHistory(tg_id, 8);
    const answer = await askLLM(lang, mode, history, raw);
    await saveMessage(tg_id, "assistant", answer);
    await ctx.reply(answer, mainKeyboard(lang));
  } catch (err) {
    console.error("[text handler]", err?.message || err);
    await ctx.reply(tinyReply(lang), mainKeyboard(lang));
  }
});

// Inline callback menus
bot.on("callback_query", async (ctx) => {
  const tg_id = ctx.from.id;
  const lang = detectLang(ctx);
  const data = ctx.callbackQuery?.data || "";

  try {
    await ctx.answerCbQuery();
  } catch {}

  if (data === "MODE_FRIEND") {
    setMode(tg_id, "friend");
    await ctx.reply(tinyReply(lang), mainKeyboard(lang));
    return;
  }

  if (data === "LANG_IT" || data === "LANG_EN" || data === "LANG_DE") {
    const newLang = data === "LANG_IT" ? "it" : data === "LANG_DE" ? "de" : "en";
    try {
      await supabase.from(SUPABASE_USERS_TABLE).update({ lang: newLang }).eq("tg_id", tg_id);
    } catch {}
    await ctx.reply("✅", mainKeyboard(newLang));
    return;
  }

  if (data === "JOURNAL_RECENT") {
    try {
      const { data: rows } = await supabase
        .from(SUPABASE_JOURNAL_TABLE)
        .select("id, title, created_at")
        .eq("tg_id", tg_id)
        .order("created_at", { ascending: false })
        .limit(5);

      if (!rows || rows.length === 0) {
        await ctx.reply(lang === "it" ? "Nessun salvataggio ancora." : lang === "de" ? "Noch keine Einträge." : "No saves yet.");
        return;
      }
      const lines = rows.map((r) => {
        const d = new Date(r.created_at).toLocaleString();
        return `• ${r.title || "Untitled"} — ${d}`;
      });
      await ctx.reply(lines.join("\n"));
    } catch {
      await ctx.reply(lang === "it" ? "Errore nel leggere i salvataggi." : "Could not load saves.");
    }
    return;
  }

  if (data === "PROGRESS_WEEK" || data === "PROGRESS_MONTH") {
    await ctx.reply(lang === "it" ? "📊 (in arrivo) — per ora: Journal salva tutto." : "📊 (coming) — for now: Journal stores everything.");
    return;
  }

  if (data === "SOS_BREATH") {
    await ctx.reply(
      lang === "it"
        ? "Inspira 4… trattieni 2… espira 6. ×3"
        : lang === "de"
        ? "Einatmen 4… halten 2… ausatmen 6. ×3"
        : "Inhale 4… hold 2… exhale 6. ×3"
    );
    return;
  }

  if (data === "SOS_RESET") {
    await ctx.reply(
      lang === "it"
        ? "Guarda 5 cose. Tocca 4. Ascolta 3. Odora 2. Assapora 1."
        : lang === "de"
        ? "Sieh 5. Berühr 4. Hör 3. Riech 2. Schmeck 1."
        : "See 5. Touch 4. Hear 3. Smell 2. Taste 1."
    );
    return;
  }

  if (data === "COACH_GOAL") {
    setMode(tg_id, "coach");
    await ctx.reply(lang === "it" ? "Dimmi l’obiettivo in una frase." : lang === "de" ? "Sag mir dein Ziel in einem Satz." : "Tell me your goal in one sentence.");
    return;
  }

  if (data === "COACH_PLAN") {
    setMode(tg_id, "coach");
    await ctx.reply(lang === "it" ? "Cosa vuoi ottenere entro 7 giorni?" : lang === "de" ? "Was willst du in 7 Tagen schaffen?" : "What do you want to achieve in 7 days?");
    return;
  }
});

// ================= JOURNAL WEB APP (write/save/share/print) =================
app.post("/api/journal/save", async (req, res) => {
  try {
    const { tg_id, title, content } = req.body || {};
    if (!tg_id || !content) return res.status(400).json({ error: "Missing tg_id/content" });

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
      <h1>📔 HITH Journal</h1>
      <div style="color:var(--muted);font-size:12px" id="who"></div>
    </div>

    <div class="card">
      <input id="title" placeholder="Title (optional)" />
      <div style="height:10px"></div>
      <textarea id="content" placeholder="Write here…"></textarea>

      <div class="row">
        <button class="primary" id="saveBtn">💾 Save</button>
        <button id="shareBtn">🔗 Share</button>
        <button id="printBtn">🖨️ Print</button>
        <button id="clearBtn">🧹 Clear</button>
      </div>

      <div class="ok" id="ok">Saved ✅</div>
      <div class="err" id="err">Could not save.</div>

      <div class="hint">Draft autosaves locally. “Save” stores permanently in your database.</div>
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
        alert('Copied ✅');
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

app.post(SECRET_PATH, async (req, res) => {
  try {
    await bot.handleUpdate(req.body, res);
  } catch (err) {
    console.error("[tg webhook]", err?.message || err);
    res.sendStatus(200);
  }
});

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
    const json = await resp.json();
    console.log("[setWebhook]", json);
  } catch (err) {
    console.error("[setWebhook] failed:", err?.message || err);
  }
}

// ================= BASE ROUTE =================
app.get("/", (_req, res) => res.status(200).send("HITH bot is running."));

// ================= START SERVER =================
const server = app.listen(PORT, async () => {
  console.log(`🚀 Server listening on ${PORT}`);
  console.log(`🌍 PUBLIC_URL: ${PUBLIC_URL}`);
  console.log(`🤖 Telegram webhook: ${WEBHOOK_URL}`);

  await initBotIdentity();
  await setupTelegramWebhook();

  // quick Supabase ping
  try {
    const { error } = await supabase
      .from(SUPABASE_USERS_TABLE)
      .select("id", { head: true, count: "exact" });
    console.log(error ? "❌ Supabase error" : "✅ Supabase OK");
  } catch {
    console.log("❌ Supabase error");
  }
});

function shutdown(signal) {
  console.log(`🛑 ${signal} received. Shutting down...`);
  server.close(() => process.exit(0));
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

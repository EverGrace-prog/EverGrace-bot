// index.js — EverGrace bot (CommonJS)

// ── 1) ENV load (local only; on Render variables come from Settings/Env)
require('dotenv').config();

// ── 2) SANITY CHECK (prevents silent boot if a key is missing)
const requiredEnv = ['BOT_TOKEN', 'SUPABASE_URL', 'SUPABASE_KEY'];
const missing = requiredEnv.filter(k => !process.env[k] || String(process.env[k]).trim() === '');
if (missing.length) {
  console.error('[env] Missing:', missing.join(', '));
  console.error('[env] Tip: link the Env Group (EverGrace Keys) and Redeploy.');
  process.exit(1);
}
console.log('[env] Present:', requiredEnv.map(k => `${k}(ok)`).join(', '));

// ── 3) Imports
const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const http = require('http');
const path = require('path');
const fs = require('fs');

// ── 4) Clients
const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ── 5) Locales (en/it/de). Keep files at ./locales/en.json etc.
const locales = {
  en: safeLoad('./locales/en.json'),
  it: safeLoad('./locales/it.json'),
  de: safeLoad('./locales/de.json'),
};

// helpers to load JSON safely
function safeLoad(relPath) {
  try {
    const p = path.join(__dirname, relPath);
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error('[i18n] Failed to load', relPath, e.message);
    return {};
  }
}

// ── 6) i18n helpers
const FALLBACK_LANG = 'en';

function getLangFromCtx(ctx) {
  // use DB value when present; otherwise Telegram hint → fallback en
  const tglang = (ctx?.from?.language_code || 'en').slice(0, 2).toLowerCase();
  return ['en', 'it', 'de'].includes(tglang) ? tglang : 'en';
}

function deepGet(obj, pathStr) {
  return pathStr.split('.').reduce((a, k) => (a && a[k] != null ? a[k] : undefined), obj);
}

function t(lang, key, vars = {}) {
  let text = deepGet(locales[lang], key);
  if (text == null) text = deepGet(locales[FALLBACK_LANG], key) || key;
  return text.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : `{${k}}`));
}

// ── 7) Per-chat memory for current capture mode (journal|coach|sos)
// (Stateless: if the process restarts, default back to 'journal')
const session = new Map();
function setMode(chatId, mode) { session.set(chatId, mode); }
function getMode(chatId) { return session.get(chatId) || 'journal'; }

// ── 8) Telegram keyboard (localized)
function labelsFor(lang) {
  const c = locales[lang]?.common || {};
  // provide a safe fallback for k_menu if your JSON doesn’t have it
  const k_menu = c.k_menu || 'Menu';
  return {
    journal: c.k_journal || 'Journal',
    progress: c.k_progress || 'Progress',
    coach: c.k_coach || 'Coach',
    sos: c.k_sos || 'SOS',
    invite: c.k_invite || 'Invite',
    settings: c.k_settings || 'Settings',
    menu: k_menu,
  };
}

function homeKeyboard(lang) {
  const L = labelsFor(lang);
  return Markup.keyboard([
    [`📒 ${L.journal}`, `📊 ${L.progress}`],
    [`📌 ${L.coach}`, `⚡ ${L.sos}`],
    [`🔗 ${L.invite}`, `🎯 ${L.menu}`],
  ]).resize();
}

// to match button presses in all languages
function labelSet(field) {
  const set = new Set();
  for (const lng of ['en', 'it', 'de']) {
    const v = (locales[lng]?.common || {})[`k_${field}`];
    if (v) set.add(v);
  }
  // add bare English fallbacks
  const fallback = {
    journal: 'Journal', progress: 'Progress', coach: 'Coach',
    sos: 'SOS', invite: 'Invite', settings: 'Settings', menu: 'Menu',
  }[field];
  set.add(fallback);
  return Array.from(set);
}

const MATCH = {
  journal: new RegExp(`^.*(${labelSet('journal').join('|')}).*$`, 'i'),
  progress: new RegExp(`^.*(${labelSet('progress').join('|')}).*$`, 'i'),
  coach: new RegExp(`^.*(${labelSet('coach').join('|')}).*$`, 'i'),
  sos: new RegExp(`^.*(${labelSet('sos').join('|')}).*$`, 'i'),
  invite: new RegExp(`^.*(${labelSet('invite').join('|')}).*$`, 'i'),
  settings: new RegExp(`^.*(${labelSet('settings').join('|')}).*$`, 'i'),
  menu: new RegExp(`^.*(${labelSet('menu').join('|')}).*$`, 'i'),
};

// ── 9) Utilities
const INVISIBLE = '\u2060'; // Word Joiner: safe non-empty char for Telegram

async function safeReply(ctx, text, extra) {
  try { await ctx.reply(text && text.trim() ? text : INVISIBLE, extra); }
  catch (e) { console.error('[sendMessage]', e?.response?.description || e.message); }
}

function modeIcon(mode) {
  return { journal: '📒', coach: '📌', sos: '⚡', goal: '🎯' }[mode] || '📝';
}

// ── 10) DB helpers (schema: users.id, users.language, notes.user_id)
async function upsertUser(ctx, forceLanguage) {
  const id = ctx.from.id;
  const name = ctx.from.first_name || 'Friend';
  const language = forceLanguage || getLangFromCtx(ctx);

  const { error } = await supabase
    .from('users')
    .upsert(
      { id, name, language, updated_at: new Date().toISOString() },
      { onConflict: 'id' }
    );
  if (error) console.error('[db upsert user]', error);
  return language;
}

async function fetchUserLanguage(id) {
  const { data, error } = await supabase.from('users').select('language').eq('id', id).maybeSingle();
  if (error) { console.error('[db get lang]', error); return null; }
  return data?.language || null;
}

async function saveNote(ctx, mode, text) {
  const user_id = ctx.from.id;
  const { error } = await supabase.from('notes').insert({ user_id, mode, text });
  if (error) {
    console.error('[db insert note]', error);
    const lang = (await fetchUserLanguage(user_id)) || getLangFromCtx(ctx);
    return await safeReply(ctx, t(lang, 'common.save_error')), false;
  }
  return true;
}

async function fetchLatestNotes(ctx, limit = 5) {
  const user_id = ctx.from.id;
  const { data, error } = await supabase
    .from('notes')
    .select('text, mode, created_at')
    .eq('user_id', user_id)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) { console.error('[db latest]', error); return []; }
  return data || [];
}

// ── 11) Language & settings flows
bot.command('lang', async (ctx) => {
  const current = (await fetchUserLanguage(ctx.from.id)) || getLangFromCtx(ctx);
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('English', 'lang_en'), Markup.button.callback('Italiano', 'lang_it')],
    [Markup.button.callback('Deutsch', 'lang_de')],
  ]);
  await safeReply(ctx, `Language: ${current.toUpperCase()}\nChoose:`, kb);
});

bot.action(/lang_(en|it|de)/, async (ctx) => {
  const lang = ctx.match[1];
  await upsertUser(ctx, lang);
  await ctx.answerCbQuery('OK');
  await safeReply(ctx, t(lang, 'settings.lang_ok'));
  await safeReply(ctx, INVISIBLE, { ...homeKeyboard(lang) });
});

// ── 12) Start
bot.start(async (ctx) => {
  const lang = await upsertUser(ctx);
  const name = ctx.from.first_name || 'friend';
  await safeReply(ctx, t(lang, 'welcome.hello', { name }));
  await safeReply(ctx, t(lang, 'welcome.subtitle'));
  setMode(ctx.chat.id, 'journal'); // default
  await safeReply(ctx, INVISIBLE, { ...homeKeyboard(lang) });
  await safeReply(ctx, t(lang, 'journal.prompt'));
});

// ── 13) Menu (show keyboard silently)
bot.hears(MATCH.menu, async (ctx) => {
  const lang = (await fetchUserLanguage(ctx.from.id)) || getLangFromCtx(ctx);
  await safeReply(ctx, INVISIBLE, { ...homeKeyboard(lang) });
});

// ── 14) Journal
bot.hears(MATCH.journal, async (ctx) => {
  const lang = (await fetchUserLanguage(ctx.from.id)) || getLangFromCtx(ctx);
  setMode(ctx.chat.id, 'journal');
  await safeReply(ctx, t(lang, 'journal.prompt'));
});

// ── 15) Coach (light conversational prompt; still stored under mode "coach")
bot.hears(MATCH.coach, async (ctx) => {
  const chatId = ctx.chat.id;
  const lang = (await fetchUserLanguage(ctx.from.id)) || getLangFromCtx(ctx);
  setMode(chatId, 'coach');
  // gentle opening
  const coachIntro =
    deepGet(locales[lang], 'coach.coach_intro') ||
    deepGet(locales[FALLBACK_LANG], 'coach.coach_intro') ||
    "Let's talk. I'm here with you.";
  await safeReply(ctx, coachIntro);
});

// ── 16) SOS
bot.hears(MATCH.sos, async (ctx) => {
  const chatId = ctx.chat.id;
  const lang = (await fetchUserLanguage(ctx.from.id)) || getLangFromCtx(ctx);
  setMode(chatId, 'sos');
  await safeReply(ctx, t(lang, 'sos.open'));
  const tools = t(lang, 'sos.tools');
  if (tools && tools !== 'sos.tools') await safeReply(ctx, tools);
});

// ── 17) Progress (latest notes)
bot.hears(MATCH.progress, async (ctx) => {
  const lang = (await fetchUserLanguage(ctx.from.id)) || getLangFromCtx(ctx);
  const notes = await fetchLatestNotes(ctx, 5);
  if (!notes.length) return await safeReply(ctx, t(lang, 'progress.empty'));

  let msg = (t(lang, 'progress.latest') || 'Your recent notes:') + '\n';
  for (const n of notes) {
    const when = new Date(n.created_at).toLocaleString('en-GB', { hour12: false });
    msg += `• ${when} — ${modeIcon(n.mode)} ${n.text}\n`;
  }
  await safeReply(ctx, msg);
});

// ── 18) Invite
bot.hears(MATCH.invite, async (ctx) => {
  const lang = (await fetchUserLanguage(ctx.from.id)) || getLangFromCtx(ctx);
  const link = `https://t.me/${ctx.botInfo.username}`;
  const txt = t(lang, 'invite.text', { link });
  await safeReply(ctx, txt);
});

// ── 19) Settings (open /lang for now)
bot.hears(MATCH.settings, async (ctx) => {
  ctx.state = ctx.state || {};
  await bot.handleUpdate({ ...ctx.update, message: { ...ctx.message, text: '/lang' } });
});

// ── 20) Free-text capture (Journal/Coach/SOS)
bot.on('text', async (ctx) => {
  // Ignore command-like messages
  const text = (ctx.message.text || '').trim();
  if (!text || text.startsWith('/')) return;

  const chatId = ctx.chat.id;
  const mode = getMode(chatId);      // 'journal' (default) | 'coach' | 'sos'
  const lang = (await fetchUserLanguage(ctx.from.id)) || getLangFromCtx(ctx);

  // Save to DB
  const ok = await saveNote(ctx, mode, text);
  if (!ok) return; // error already shown

  // Gentle follow-up
  if (mode === 'journal') {
    await safeReply(ctx, t(lang, 'journal.saved') || 'Saved. Want to add more?');
  } else if (mode === 'coach') {
    // light coaching nudge
    const hint =
      deepGet(locales[lang], 'coach.coach_reply_hint') ||
      deepGet(locales[FALLBACK_LANG], 'coach.coach_reply_hint');
    if (hint) await safeReply(ctx, hint);
  } else if (mode === 'sos') {
    // acknowledge & keep space open
    await safeReply(ctx, t(lang, 'coach.escalate') || "I'm with you. Tell me more when ready.");
  }
});

// ── 21) Healthcheck server (Render)
const PORT = process.env.PORT || 10000;
http
  .createServer((_, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
  })
  .listen(PORT, () => console.log(`[hc] listening on ${PORT}`));

// ── 22) Launch
bot.launch().then(() => console.log('EverGrace bot running')).catch(console.error);

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

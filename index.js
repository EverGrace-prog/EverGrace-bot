// index.js — EverGrace bot (CommonJS)

/* ---------------- 1) ENV load (local only) ---------------- */
require('dotenv').config();

/* ---------------- 2) ENV sanity check -------------------- */
const REQUIRED = ['BOT_TOKEN', 'SUPABASE_URL', 'SUPABASE_KEY'];
const missing = REQUIRED.filter(k => !process.env[k] || String(process.env[k]).trim() === '');
if (missing.length) {
  console.error('[env] Missing:', missing.join(', '));
  console.error('[env] Hint: link your Environment Group and redeploy.');
  process.exit(1);
}
console.log('[env] Present:', REQUIRED.join(', '));

/* ---------------- 3) Imports ------------------------------ */
const http = require('http');
const path = require('path');
const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const PDFDocument = require('pdfkit'); // if you export PDFs later
const fs = require('fs');

/* ---------------- 4) Clients ------------------------------ */
const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

/* ---------------- 5) Healthcheck (Render) ----------------- */
const PORT = process.env.PORT || 10000;
http.createServer((_, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}).listen(PORT, () => console.log(`[hc] listening on ${PORT}`));

/* ---------------- 6) i18n setup --------------------------- */
const locales = {
  en: require('./locales/en.json'),
  it: require('./locales/it.json'),
  de: require('./locales/de.json'),
};
const SUPPORTED = ['en', 'it', 'de'];
const BLANK = '\u2063'; // zero-width “invisible” char (Telegram accepts)

/** safely get nested key like "common.welcome" */
function get(dict, dotted) {
  return dotted.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), dict);
}

/** resolve translation with fallbacks; never returns empty string */
function t(langCode, key, vars = {}) {
  const lang = SUPPORTED.includes(langCode) ? langCode : 'en';
  let str = get(locales[lang], key);
  if (str === undefined) str = get(locales['en'], key);
  if (str === undefined || String(str).trim() === '') str = `[${key}]`; // visible fallback
  // simple template replacement
  return String(str).replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? `{${k}}`));
}

/** decide user language */
function userLang(ctx) {
  const code = ctx?.from?.language_code?.slice(0,2)?.toLowerCase() || 'en';
  return SUPPORTED.includes(code) ? code : 'en';
}

/* ---------------- 7) Keyboards ---------------------------- */
function homeKeyboard(lang='en') {
  return Markup.keyboard([
    ['📒 ' + t(lang,'common.k_journal'), '📊 ' + t(lang,'common.k_progress')],
    ['📌 ' + t(lang,'common.k_coach'),   '⚡ ' + t(lang,'common.k_sos')],
    ['🔗 ' + t(lang,'common.k_invite'),  '🎯 ' + t(lang,'common.k_menu')],
  ]).resize();
}

function langKeyboard() {
  return Markup.keyboard([
    ['🇮🇹 Italiano', '🇬🇧 English'],
    ['🇩🇪 Deutsch', '🎯 Menu'],
  ]).resize();
}

/* ---------------- 8) Helpers ------------------------------ */
async function ensureUser(ctx) {
  const chat_id = ctx.chat.id;
  const name = ctx.from.first_name || 'Friend';
  // upsert user
  await supabase.from('users').upsert({ chat_id, name }).eq('chat_id', chat_id);
}

async function saveJournal(ctx, text) {
  const chat_id = ctx.chat.id;
  const { error } = await supabase.from('journal').insert({ chat_id, text });
  return !error;
}

function nonEmpty(s) {
  return (s && String(s).trim().length) ? String(s) : BLANK;
}

/* ---------------- 9) Commands/Handlers -------------------- */
// /start — greet + menu
bot.start(async (ctx) => {
  const lang = userLang(ctx);
  await ensureUser(ctx);
  await ctx.reply(
    t(lang,'common.hello',{ name: ctx.from.first_name || '' }),
    homeKeyboard(lang)
  );
  await ctx.reply(t(lang,'common.welcome'), homeKeyboard(lang));
});

// /refresh — redraw the menu only
bot.command('refresh', async (ctx) => {
  const lang = userLang(ctx);
  await ctx.reply(BLANK, homeKeyboard(lang));
});

// Language picker
bot.hears(/^(🇮🇹 Italiano|🇬🇧 English|🇩🇪 Deutsch)$/i, async (ctx) => {
  let lang = 'en';
  if (/Italiano/i.test(ctx.message.text)) lang = 'it';
  else if (/Deutsch/i.test(ctx.message.text)) lang = 'de';
  // store preference (optional)
  await supabase.from('users').update({ lang }).eq('chat_id', ctx.chat.id);
  await ctx.reply(t(lang,'common.lang_set'), homeKeyboard(lang));
});

// Open picker
bot.hears(/^(language|lingua|sprache)$/i, async (ctx) => {
  await ctx.reply(nonEmpty(t(userLang(ctx),'common.pick_lang')), langKeyboard());
});

// Menu button (just show keys, no extra text)
bot.hears(/🎯|^menu$/i, async (ctx) => {
  const lang = userLang(ctx);
  await ctx.reply(BLANK, homeKeyboard(lang));
});

/* ----- Journal ----- */
bot.hears(/^📒/i, async (ctx) => {
  const lang = userLang(ctx);
  await ctx.reply(t(lang,'common.journal_prompt'));
});

// treat any normal message as potential journal text when last action was journal
// (simple heuristic: if it doesn't match any known button/command, save it)
const BUTTON_REGEX = /^(📒|📊|📌|⚡|🔗|🎯|\/start|\/refresh|🇮🇹|🇬🇧|🇩🇪)/i;
bot.on('text', async (ctx, next) => {
  const txt = (ctx.message.text || '').trim();
  if (!txt || BUTTON_REGEX.test(txt)) return next();

  // save as journal note
  await ensureUser(ctx);
  const ok = await saveJournal(ctx, txt);
  const lang = userLang(ctx);
  await ctx.reply(ok ? t(lang,'common.journal_saved') : t(lang,'common.save_error'));
});

/* ----- Coach ----- */
bot.hears(/^📌/i, async (ctx) => {
  const lang = userLang(ctx);
  await ctx.reply(t(lang,'modes.goal.coach_intro'));
});

/* ----- SOS ----- */
bot.hears(/^⚡/i, async (ctx) => {
  const lang = userLang(ctx);
  await ctx.reply(t(lang,'common.sos_open'));
  await ctx.reply(t(lang,'common.sos_tools_intro'));
});

/* ----- Progress (last entries preview) ----- */
bot.hears(/^📊/i, async (ctx) => {
  const lang = userLang(ctx);
  const { data, error } = await supabase
    .from('journal')
    .select('text, ts')
    .eq('chat_id', ctx.chat.id)
    .order('id', { ascending: false })
    .limit(5);
  if (error) return ctx.reply(t(lang,'common.progress_error'));
  if (!data || !data.length) return ctx.reply(t(lang,'common.progress_empty'));
  const list = data.map(r => `• ${new Date(r.ts).toLocaleString()} — ${r.text}`).join('\n');
  await ctx.reply(t(lang,'common.progress_wrap', { list }));
});

/* ----- Invite ----- */
bot.hears(/^🔗/i, async (ctx) => {
  const lang = userLang(ctx);
  const link = 'https://t.me/' + (process.env.BOT_USERNAME || 'EverGraceBot'); // set BOT_USERNAME in env if you want
  await ctx.reply(t(lang,'common.invite_msg', { link }));
});

/* ---------------- 10) Error logging ----------------------- */
bot.catch((err, ctx) => {
  console.error('Bot error for update', ctx.update?.update_id, err);
});

/* ---------------- 11) Launch ------------------------------ */
bot.launch();
console.log('EverGrace bot running');

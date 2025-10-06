// index.js — EverGrace bot (CommonJS)

// ── env & deps ────────────────────────────────────────────────────────────────
require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const http = require('http');

// ── config ───────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_KEY;

if (!BOT_TOKEN)  throw new Error('[env] BOT_TOKEN is missing');
if (!SUPABASE_URL)  throw new Error('[env] SUPABASE_URL is missing');
if (!SUPABASE_KEY)  throw new Error('[env] SUPABASE_KEY/SUPABASE_SERVICE_ROLE is missing');

const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 30_000 });
const sb  = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── i18n ─────────────────────────────────────────────────────────────────────
const locales = {
  en: {
    menu_btn: '🎯 Menu',
    journal_btn: '📒 Journal',
    progress_btn: '📊 Progress',
    coach_btn: '📌 Coach',
    sos_btn: '⚡️ SOS',
    invite_btn: '🔗 Invite',
    back_btn: '🔙 Back',
    menu_title: ' ',
    hello: 'Hi! How can I help you today?',
    ask_journal: 'Tell me: what’s on your mind today? ✍️',
    saved: 'Saved. Add another?',
    pdf: '📄 Export PDF',
    pdf_empty: 'Nothing to export.',
    coach_set: name => `Done. New style: ${name}`,
    progress_logged: 'Logged. Next micro-step?',
    sos_text: 'Breathing in… out… You’re not alone. Want a 60-sec grounding tip?',
    invite_text: (u) => `Share EverGrace: https://t.me/${u}?start=hi`,
    settings: 'Settings',
    pick_lang: '🌐 Choose language',
    lang_set: 'Language updated ✅',
    unknown: 'Oops—something went wrong. Try again.'
  },
  it: {
    menu_btn: '🎯 Menu',
    journal_btn: '📒 Journal',
    progress_btn: '📊 Progress',
    coach_btn: '📌 Coach',
    sos_btn: '⚡️ SOS',
    invite_btn: '🔗 Invita',
    back_btn: '🔙 Indietro',
    menu_title: ' ',
    hello: 'Ciao! Come posso aiutarti oggi?',
    ask_journal: 'Raccontami: cosa hai in mente oggi? ✍️',
    saved: 'Annotato. Vuoi aggiungere altro?',
    pdf: '📄 Esporta PDF',
    pdf_empty: 'Nulla da esportare.',
    coach_set: name => `Fatto. Nuovo stile: ${name}`,
    progress_logged: 'Registrato. Prossimo micro-passo?',
    sos_text: 'Inspira… espira… Non sei sola/o. Vuoi un consiglio di 60 secondi?',
    invite_text: (u) => `Invita con EverGrace: https://t.me/${u}?start=ciao`,
    settings: 'Impostazioni',
    pick_lang: '🌐 Scegli la lingua',
    lang_set: 'Lingua aggiornata ✅',
    unknown: 'Ops — qualcosa non va. Riprova.'
  },
  de: {
    menu_btn: '🎯 Menü',
    journal_btn: '📒 Journal',
    progress_btn: '📊 Fortschritt',
    coach_btn: '📌 Coach',
    sos_btn: '⚡️ SOS',
    invite_btn: '🔗 Einladen',
    back_btn: '🔙 Zurück',
    menu_title: ' ',
    hello: 'Hi! Wobei kann ich dir heute helfen?',
    ask_journal: 'Erzähl: Was beschäftigt dich heute? ✍️',
    saved: 'Gespeichert. Noch etwas hinzufügen?',
    pdf: '📄 Als PDF exportieren',
    pdf_empty: 'Nichts zu exportieren.',
    coach_set: name => `Fertig. Neuer Stil: ${name}`,
    progress_logged: 'Erfasst. Nächster Mikro-Schritt?',
    sos_text: 'Einatmen… ausatmen… Du bist nicht allein. 60-Sekunden-Tipp?',
    invite_text: (u) => `Teile EverGrace: https://t.me/${u}?start=hallo`,
    settings: 'Einstellungen',
    pick_lang: '🌐 Sprache wählen',
    lang_set: 'Sprache aktualisiert ✅',
    unknown: 'Ups — etwas ist schiefgelaufen. Bitte erneut versuchen.'
  }
};

// tiny in-memory state (safe enough for 1 worker)
const state = new Map(); // chat_id -> { mode?: 'journal' }

// i18n helpers
async function getUserLang(chat_id, fallback='en') {
  const { data, error } = await sb.from('user_settings')
    .select('language').eq('chat_id', chat_id).maybeSingle();
  if (error) console.error('[lang:get]', error);
  const lang = (data?.language || fallback);
  return ['it','en','de'].includes(lang) ? lang : 'en';
}
async function setUserLang(chat_id, lang) {
  const L = ['it','en','de'].includes(lang) ? lang : 'en';
  const { error } = await sb.from('user_settings')
    .upsert({ chat_id, language: L });
  if (error) console.error('[lang:set]', error);
  return L;
}
async function ensureUserLang(chat_id, guess) {
  const { data, error } = await sb.from('user_settings')
    .select('language').eq('chat_id', chat_id).maybeSingle();
  if (error) console.error('[lang:read]', error);
  if (data?.language) return data.language;
  const lang = ['it','en','de'].includes((guess||'en').slice(0,2)) ? guess.slice(0,2) : 'en';
  const { error: upErr } = await sb.from('user_settings').upsert({ chat_id, language: lang });
  if (upErr) console.error('[lang:upsert]', upErr);
  return lang;
}
async function langOf(ctx) {
  const guess = (ctx.from?.language_code || 'en').slice(0,2);
  const base = ['it','en','de'].includes(guess) ? guess : 'en';
  return await getUserLang(ctx.chat.id, base);
}
function t(lang, key, ...args) {
  const pack = locales[lang] || locales.en;
  const v = pack[key];
  return typeof v === 'function' ? v(...args) : (v ?? key);
}

// ── keyboards ────────────────────────────────────────────────────────────────
function mainKeyboard(lang) {
  return Markup.keyboard([
    [t(lang,'journal_btn'), t(lang,'progress_btn')],
    [t(lang,'coach_btn'),   t(lang,'sos_btn')],
    [t(lang,'invite_btn'),  t(lang,'menu_btn')],
  ]).resize();
}
function langPicker(lang) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('🇮🇹 Italiano', 'set_lang_it'),
      Markup.button.callback('🇬🇧 English',  'set_lang_en'),
      Markup.button.callback('🇩🇪 Deutsch',  'set_lang_de'),
    ]
  ]);
}
function journalActions(lang) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(t(lang,'pdf'), 'journal_export_pdf')]
  ]);
}

// ── middleware: auto-persist language on every contact ───────────────────────
bot.use(async (ctx, next) => {
  if (ctx.chat?.id) {
    const tgLang = (ctx.from?.language_code || 'en').slice(0,2);
    await ensureUserLang(ctx.chat.id, tgLang);
  }
  return next();
});

// ── commands & entry points ──────────────────────────────────────────────────
bot.start(async (ctx) => {
  const lang = await langOf(ctx);
  // zero-width text shows keyboard without noisy message
  await ctx.reply(t(lang,'menu_title'), { reply_markup: mainKeyboard(lang).reply_markup });
  await ctx.reply(t(lang,'hello'), Markup.inlineKeyboard([
    [Markup.button.callback(t(lang,'pick_lang'), 'open_lang_picker')]
  ]));
});

bot.command('settings', async (ctx) => {
  const lang = await langOf(ctx);
  await ctx.reply(t(lang,'pick_lang'), langPicker(lang));
});

bot.hears([locales.en.menu_btn, locales.it.menu_btn, locales.de.menu_btn], async (ctx) => {
  const lang = await langOf(ctx);
  await ctx.reply(t(lang,'menu_title'), { reply_markup: mainKeyboard(lang).reply_markup });
});

bot.action('open_lang_picker', async (ctx) => {
  const lang = await langOf(ctx);
  await ctx.editMessageText(t(lang,'pick_lang'), langPicker(lang));
});
bot.action(/set_lang_(it|en|de)/, async (ctx) => {
  const to = ctx.match[1];
  await setUserLang(ctx.chat.id, to);
  await ctx.answerCbQuery('OK');
  const lang = await langOf(ctx);
  await ctx.editMessageText(t(lang,'lang_set'), Markup.removeKeyboard());
  await ctx.reply(t(lang,'menu_title'), { reply_markup: mainKeyboard(lang).reply_markup });
});

// ── journal flow ─────────────────────────────────────────────────────────────
bot.hears([locales.en.journal_btn, locales.it.journal_btn, locales.de.journal_btn], async (ctx) => {
  const lang = await langOf(ctx);
  state.set(ctx.chat.id, { mode: 'journal' });
  await ctx.reply(t(lang,'ask_journal'), journalActions(lang));
});

bot.action('journal_export_pdf', async (ctx) => {
  const lang = await langOf(ctx);
  // fetch entries (latest 200 for this chat)
  const { data, error } = await sb.from('journal')
    .select('id, text, ts').eq('chat_id', ctx.chat.id).order('id', { ascending:false }).limit(200);
  if (error) { console.error('[journal:read]', error); return ctx.answerCbQuery('Error'); }
  if (!data || !data.length) return ctx.reply(t(lang,'pdf_empty'));

  // lazy import pdfkit
  let PDFDocument;
  try { PDFDocument = (await import('pdfkit')).default; }
  catch { return ctx.reply(t(lang,'pdf_empty')); }

  const exportsDir = path.join(__dirname, 'exports');
  if (!fs.existsSync(exportsDir)) fs.mkdirSync(exportsDir, { recursive: true });
  const file = path.join(exportsDir, `journal_${ctx.chat.id}_${Date.now()}.pdf`);

  const doc = new PDFDocument({ margin: 40 });
  const stream = fs.createWriteStream(file);
  doc.pipe(stream);

  doc.fontSize(18).text('Journal — EverGrace', { underline: true });
  doc.moveDown(1);
  for (const e of data.slice().reverse()) {
    const when = new Date(e.ts).toLocaleString();
    doc.fontSize(12).text(`#${e.id} — ${when}`);
    doc.moveDown(0.25);
    doc.fontSize(12).text(e.text, { align: 'left' });
    doc.moveDown(0.75);
  }
  doc.end();
  await new Promise(r => stream.on('finish', r));
  await ctx.replyWithDocument({ source: file, filename: path.basename(file) });
});

bot.on('text', async (ctx, next) => {
  const s = state.get(ctx.chat.id);
  if (s?.mode === 'journal') {
    const lang = await langOf(ctx);
    const text = (ctx.message.text || '').trim();
    if (!text) return ctx.reply(t(lang,'unknown'));

    const { error } = await sb.from('journal').insert({
      chat_id: ctx.chat.id,
      text
    });
    if (error) { console.error('[journal:insert]', error); return ctx.reply(t(lang,'unknown')); }

    await ctx.reply(t(lang,'saved'), journalActions(lang));
    return; // handled
  }
  return next();
});

// ── progress / coach / sos / invite (localized, simple stubs) ───────────────
bot.hears([locales.en.progress_btn, locales.it.progress_btn, locales.de.progress_btn], async (ctx) => {
  const lang = await langOf(ctx);
  // Tiny demo: log a row to keep a heartbeat of user activity
  await sb.from('journal').insert({ chat_id: ctx.chat.id, text: '[progress-tap]' });
  await ctx.reply(t(lang, 'progress_logged'));
});

bot.hears([locales.en.coach_btn, locales.it.coach_btn, locales.de.coach_btn], async (ctx) => {
  const lang = await langOf(ctx);
  // Cycle a small set of demo modes
  const modes = ['goal', 'gentle', 'tough'];
  const idx = Math.floor(Math.random()*modes.length);
  await ctx.reply(t(lang, 'coach_set')(modes[idx]));
});

bot.hears([locales.en.sos_btn, locales.it.sos_btn, locales.de.sos_btn], async (ctx) => {
  const lang = await langOf(ctx);
  await ctx.reply(t(lang, 'sos_text'));
});

bot.hears([locales.en.invite_btn, locales.it.invite_btn, locales.de.invite_btn], async (ctx) => {
  const lang = await langOf(ctx);
  // Try to read current bot username from getMe()
  const me = await bot.telegram.getMe();
  await ctx.reply(t(lang, 'invite_text')(me.username || 'EverGraceBot'));
});

// ── healthcheck (Render keeps it alive) ──────────────────────────────────────
const PORT = process.env.PORT || 10000;
http.createServer((_, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ok');
}).listen(PORT, () => console.log('[hc] listening on', PORT));

// ── launch ───────────────────────────────────────────────────────────────────
bot.launch().then(async () => {
  const me = await bot.telegram.getMe();
  console.log('Boot OK.', '@' + me.username);
});

// graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

// index.js — EverGrace bot (CommonJS)

// 1) ENV load (local only; on Render variables come from Settings/Env)
require('dotenv').config();

// 2) ENV sanity check (NO SECRETS IN LOGS)
const requiredEnv = ['BOT_TOKEN', 'SUPABASE_URL', 'SUPABASE_KEY'];
const missing = requiredEnv.filter(k => !process.env[k] || String(process.env[k]).trim() === '');
if (missing.length) {
  console.error('[env] Missing:', missing.join(', '));
  console.error('[env] Tip: Service ▸ Settings ▸ Environment: link your Env Group (EverGrace Keys) and Clear build cache & Deploy.');
  process.exit(1); // stop here so logs are clear
}
console.log('[env] Present:', requiredEnv.map(k => `${k} (ok)`).join(', '));

// 3) Imports
const http = require('http');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

// 4) Clients
const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 5) Healthcheck server (Render)
const PORT = process.env.PORT || 10000;
http.createServer((_, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}).listen(PORT, () => console.log(`[hc] listening on ${PORT}`));

// 6) Locales (EN / IT / DE)
function loadJSON(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); }
  catch { return {}; }
}
const LOCALES_DIR = path.join(__dirname, 'locales');
const L = {
  en: loadJSON(path.join(LOCALES_DIR, 'en.json')),
  it: loadJSON(path.join(LOCALES_DIR, 'it.json')),
  de: loadJSON(path.join(LOCALES_DIR, 'de.json')),
};

// util: deep get "a.b.c"
const get = (obj, key, dflt='') => key.split('.').reduce((o,k)=> (o && o[k] != null ? o[k] : undefined), obj) ?? dflt;

// choose locale code from Telegram + fallback
function pickLang(ctx) {
  const code = (ctx.from?.language_code || '').slice(0,2);
  if (code === 'it') return 'it';
  if (code === 'de') return 'de';
  return 'en';
}
function t(lang, key, vars={}) {
  const s = get(L[lang] || L.en, key, get(L.en, key, key));
  return s.replace(/\{(\w+)\}/g, (_,k) => vars[k] ?? `{${k}}`);
}

// 7) In-memory per-chat state (simple)
const state = new Map(); // chatId -> { mode, lang, inJournal }

function ensureChat(ctx) {
  const id = ctx.chat.id;
  if (!state.has(id)) {
    state.set(id, { mode: 'goal', lang: pickLang(ctx), inJournal: false });
  }
  return state.get(id);
}

// 8) Keyboard (compact)
function homeKeyboard(ctx) {
  const s = ensureChat(ctx);
  const K = (k) => ({
    Menu: '🎯 Menu', Journal: '📒 Journal', Coach: '📌 Coach',
    Progress: '📊 Progress', SOS: '⚡️ SOS', Invite: '🔗 Invita'
  }[k]);
  return Markup.keyboard([
    [K('Journal'), K('Progress')],
    [K('Coach'),   K('SOS')],
    [K('Invite'),  K('Menu')],
  ]).resize();
}

// 9) Language picker
const LANG_LABELS = { en: 'English', it: 'Italiano', de: 'Deutsch' };
function langKeyboard(current) {
  return Markup.inlineKeyboard([
    [{ text: (current==='en'?'✅ ':'')+LANG_LABELS.en, callback_data: 'lang:en' }],
    [{ text: (current==='it'?'✅ ':'')+LANG_LABELS.it, callback_data: 'lang:it' }],
    [{ text: (current==='de'?'✅ ':'')+LANG_LABELS.de, callback_data: 'lang:de' }],
  ]);
}

// 10) Helpers: Journal save + PDF export
async function saveJournal(chat_id, text) {
  const { error } = await supabase.from('journal').insert({ chat_id, text });
  if (error) throw error;
}

async function exportJournalPdf(chat_id, lang='en') {
  const { data, error } = await supabase
    .from('journal')
    .select('id, ts, text')
    .eq('chat_id', chat_id)
    .order('ts', { ascending: true });

  if (error) throw error;

  const fname = `journal_${chat_id}_${Date.now()}.pdf`;
  const fpath = path.join(process.cwd(), fname);
  const doc = new PDFDocument({ margin: 36 });
  const out = fs.createWriteStream(fpath);
  doc.pipe(out);

  doc.fontSize(16).text('EverGrace — Journal', { align: 'center' });
  doc.moveDown();

  if (!data || data.length === 0) {
    doc.fontSize(12).text(t(lang,'common.no_entries') || 'No entries yet.');
  } else {
    data.forEach(row => {
      const when = new Date(row.ts || Date.now()).toLocaleString();
      doc.fontSize(10).fillColor('#555').text(when);
      doc.fontSize(12).fillColor('#000').text(row.text);
      doc.moveDown(0.8);
    });
  }
  doc.end();
  await new Promise(r => out.on('finish', r));
  return fpath;
}

// 11) Command & button handlers
bot.start(async (ctx) => {
  const s = ensureChat(ctx);
  const name = (ctx.from?.first_name || '').trim();
  const hi = name ? (s.lang==='it' ? `Ciao ${name} 🌿` : s.lang==='de' ? `Hallo ${name} 🌿` : `Hi ${name} 🌿`) :
                    (s.lang==='it' ? 'Ciao 🌿' : s.lang==='de' ? 'Hallo 🌿' : 'Hi 🌿');
  await ctx.reply(hi);
  await ctx.reply(
    t(s.lang,'common.welcome') || 'Welcome to EverGrace — your gentle space for journaling, coaching and small steps.',
    homeKeyboard(ctx)
  );
});

// language
bot.command('lang', async (ctx) => {
  const s = ensureChat(ctx);
  await ctx.reply(t(s.lang,'common.pick_language') || 'Choose your language:', langKeyboard(s.lang));
});
bot.action(/^lang:(en|it|de)$/, async (ctx) => {
  const s = ensureChat(ctx);
  s.lang = ctx.match[1];
  await ctx.answerCbQuery('OK');
  await ctx.editMessageText(t(s.lang,'common.language_set') || 'Language updated.');
});

// menu (show keyboard silently)
bot.hears(/^(🎯 Menu|Menu)$/i, async (ctx) => {
  await ctx.reply(' ', homeKeyboard(ctx)); // blank keeps chat clean while opening keyboard
});

// journal
bot.hears(/^(📒 Journal|Journal)$/i, async (ctx) => {
  const s = ensureChat(ctx);
  s.inJournal = true;
  const key = `modes.${s.mode}.journal_prompt`;
  await ctx.reply(t(s.lang,key) || t(s.lang,'common.journal_prompt') || 'Tell me what you want to note today.');
  await ctx.reply(t(s.lang,'common.export_pdf_button') || 'Export PDF', Markup.keyboard([[ '📄 Export PDF', '🎯 Menu' ]]).resize());
});

// export PDF
bot.hears(/^📄 Export PDF$/i, async (ctx) => {
  const s = ensureChat(ctx);
  try {
    const fpath = await exportJournalPdf(ctx.chat.id, s.lang);
    await ctx.replyWithDocument({ source: fpath });
    fs.unlink(fpath, ()=>{});
  } catch (e) {
    console.error('[pdf]', e);
    await ctx.reply(t(s.lang,'common.pdf_error') || 'Sorry, I could not create the PDF right now.');
  }
});

// coach
bot.hears(/^(📌 Coach|Coach)$/i, async (ctx) => {
  const s = ensureChat(ctx);
  s.inJournal = false;
  s.mode = s.mode || 'goal';
  const key = `modes.${s.mode}.sos_talk_start`;
  await ctx.reply(t(s.lang, key) || 'Alright, let’s talk. What do you notice first?');
});

// progress
bot.hears(/^(📊 Progress|Progress)$/i, async (ctx) => {
  const s = ensureChat(ctx);
  const { data, error } = await supabase
    .from('journal')
    .select('ts, text')
    .eq('chat_id', ctx.chat.id)
    .order('ts', { ascending: false })
    .limit(5);
  if (error) {
    console.error('[progress]', error);
    return ctx.reply(t(s.lang,'common.progress_error') || 'Could not fetch progress right now.');
  }
  if (!data || data.length === 0) {
    return ctx.reply(t(s.lang,'common.no_entries') || 'No entries yet.');
  }
  const lines = data.map(r => `• ${new Date(r.ts).toLocaleString()} — ${r.text.slice(0,80)}`);
  await ctx.reply((t(s.lang,'common.recent_notes') || 'Your recent notes:') + '\n' + lines.join('\n'));
});

// SOS
bot.hears(/^(⚡️ SOS|SOS)$/i, async (ctx) => {
  const s = ensureChat(ctx);
  const key = `modes.${s.mode}.sos_tools_intro`;
  await ctx.reply(t(s.lang,key) || 'Two quick tools: 4-7-8 breathing and the 5-4-3-2-1 senses game.');
});

// invite
bot.hears(/^(🔗 Invita|Invite|Invita)$/i, async (ctx) => {
  const s = ensureChat(ctx);
  const txt =
    s.lang==='it' ? 'Invita un’amica: https://t.me/EverGraceRabeBot'
    : s.lang==='de' ? 'Lade eine Freundin ein: https://t.me/EverGraceRabeBot'
    : 'Invite a friend: https://t.me/EverGraceRabeBot';
  await ctx.reply(txt);
});

// 12) Text handler: journal capture + “question → coach” switch
bot.on('text', async (ctx) => {
  const s = ensureChat(ctx);
  const text = (ctx.message.text || '').trim();

  // ignore command words we already handle
  if (/^(\/start|\/lang|📄 Export PDF|🎯 Menu|📒 Journal|📌 Coach|📊 Progress|⚡️ SOS|🔗 Invita)$/i.test(text)) return;

  // If we're in a journal capture…
  if (s.inJournal) {
    // If the line looks like a question, route to Coach flow automatically.
    if (/[?？]$/.test(text) || /^(come|how|why|perché|warum)\b/i.test(text)) {
      s.inJournal = false;
      await ctx.reply(
        t(s.lang,'common.question_to_coach') || 'Good question. Let’s explore it together.',
        homeKeyboard(ctx)
      );
      const key = `modes.${s.mode}.sos_talk_start`;
      return ctx.reply(t(s.lang,key) || 'I’m listening. Close your eyes—what do you notice first?');
    }

    // Save journal line
    try {
      await saveJournal(ctx.chat.id, text);
      await ctx.reply(
        t(s.lang, `modes.${s.mode}.journal_saved`) ||
        t(s.lang,'common.journal_saved') ||
        'Saved. Anything else?'
      );
    } catch (e) {
      console.error('[sb] insert error', e);
      await ctx.reply(t(s.lang,'common.save_error') || 'Oops, I could not save. Please try later.');
    }
    return;
  }

  // Fallback small-talk nudge
  await ctx.reply(' ', homeKeyboard(ctx));
});

// 13) Launch
bot.launch().then(() => console.log('EverGrace bot running'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

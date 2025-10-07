// ----- Env & deps -----------------------------------------------------------
require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const bodyParser = require('body-parser');
const http = require('http');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

// ----- Config ---------------------------------------------------------------
const {
  BOT_TOKEN,
  SUPABASE_URL,
  SUPABASE_KEY,
  OPENAI_API_KEY, // reserved for future AI messaging
  RENDER_EXTERNAL_URL, // Render auto-provides this
  PORT
} = process.env;

if (!BOT_TOKEN) {
  console.error('[env] Missing BOT_TOKEN');
  process.exit(1);
}
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('[env] Missing SUPABASE_URL or SUPABASE_KEY');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const sb = createClient(SUPABASE_URL, SUPABASE_KEY);

// app/server always created (webhook mode on Render; healthcheck locally too)
const app = express();
app.use(bodyParser.json());

// ----- i18n (very light) ----------------------------------------------------
const LOCALES = {
  en: {
    menuTitle: 'Menu',
    journal: 'Journal',
    progress: 'Progress',
    coach: 'Coach',
    sos: 'SOS',
    invite: 'Invite',
    setLang: 'Language',
    askJournal: 'Tell me: what’s on your mind today? ✍️',
    saved: 'Noted. Add anything else?',
    exportPdf: 'Export PDF',
    styleSet: (s) => `Done. New style: ${s}. What’s the next micro-step?`,
    recentNotes: 'Your recent notes:',
    langPick: 'Choose your language:',
    inviteText: (u) => `Here’s your invite link:\nhttps://t.me/${u}?start=friend`
  },
  it: {
    menuTitle: 'Menu',
    journal: 'Journal',
    progress: 'Progress',
    coach: 'Coach',
    sos: 'SOS',
    invite: 'Invita',
    setLang: 'Lingua',
    askJournal: 'Raccontami: cosa hai in mente oggi? ✍️',
    saved: 'Annotato. Vuoi aggiungere altro?',
    exportPdf: 'Esporta PDF',
    styleSet: (s) => `Fatto. Nuovo stile: ${s}. Qual è il prossimo micro-passo?`,
    recentNotes: 'Le tue note recenti:',
    langPick: 'Scegli la lingua:',
    inviteText: (u) => `Ecco il tuo link di invito:\nhttps://t.me/${u}?start=friend`
  },
  de: {
    menuTitle: 'Menü',
    journal: 'Journal',
    progress: 'Fortschritt',
    coach: 'Coach',
    sos: 'SOS',
    invite: 'Einladen',
    setLang: 'Sprache',
    askJournal: 'Erzähl mir: Was beschäftigt dich heute? ✍️',
    saved: 'Notiert. Möchtest du noch etwas hinzufügen?',
    exportPdf: 'PDF exportieren',
    styleSet: (s) => `Erledigt. Neuer Stil: ${s}. Nächster Mikro-Schritt?`,
    recentNotes: 'Deine letzten Notizen:',
    langPick: 'Wähle deine Sprache:',
    inviteText: (u) => `Dein Einladungslink:\nhttps://t.me/${u}?start=friend`
  }
};

function t(lang) {
  return LOCALES[lang] || LOCALES.it;
}

// ----- Utilities ------------------------------------------------------------
let BOT_USERNAME = null;
async function ensureBotUsername() {
  if (!BOT_USERNAME) {
    const me = await bot.telegram.getMe();
    BOT_USERNAME = me.username;
  }
  return BOT_USERNAME;
}

function mainMenu(lang) {
  const L = t(lang);
  return Markup.keyboard([
    [ `📒 ${L.journal}`, `📊 ${L.progress}` ],
    [ `📌 ${L.coach}`, `⚡ ${L.sos}` ],
    [ `🔗 ${L.invite}`, `🎯 ${L.menuTitle}` ],
    [ `🌐 ${L.setLang}` ]
  ]).resize();
}

// save journal entry
async function saveJournal(chat_id, text) {
  const { error } = await sb.from('journal').insert({ chat_id, text });
  if (error) {
    console.error('[sb] insert error', error);
    throw error;
  }
}

// fetch last N journal entries
async function fetchLatest(chat_id, n = 5) {
  const { data, error } = await sb
    .from('journal')
    .select('*')
    .eq('chat_id', chat_id)
    .order('id', { ascending: false })
    .limit(n);
  if (error) throw error;
  return data || [];
}

async function exportJournalPdf(ctx, lang) {
  const L = t(lang);
  const rows = await fetchLatest(ctx.chat.id, 50);
  if (!rows.length) {
    return ctx.reply('—');
  }

  const fileName = `journal_${ctx.chat.id}_${Date.now()}.pdf`;
  const outPath = path.join('/tmp', fileName);
  const doc = new PDFDocument({ margin: 36 });
  const stream = fs.createWriteStream(outPath);
  doc.pipe(stream);

  doc.fontSize(18).text('EverGrace — Journal', { align: 'center' });
  doc.moveDown();

  rows.reverse().forEach((r) => {
    doc.fontSize(11).text(
      `${new Date(r.ts || Date.now()).toLocaleString()} — ${r.text}`
    );
    doc.moveDown(0.5);
  });

  doc.end();

  await new Promise((res) => stream.on('finish', res));
  await ctx.replyWithDocument({ source: outPath, filename: fileName }, {
    caption: L.exportPdf
  });

  try { fs.unlinkSync(outPath); } catch (_) {}
}

// ----- Conversation flags ---------------------------------------------------
const state = new Map(); // chat_id -> { mode: 'journal'|'coach'|null, lang }

// ----- Commands & Handlers --------------------------------------------------
bot.start(async (ctx) => {
  const chat_id = ctx.chat.id;
  // upsert user language (default it)
  if (!state.has(chat_id)) state.set(chat_id, { mode: null, lang: 'it' });

  const { lang } = state.get(chat_id);
  const L = t(lang);
  await ctx.reply(`Ciao! 👋`, mainMenu(lang));
  await ctx.reply(L.askJournal);
});

bot.command('version', (ctx) =>
  ctx.reply(`EverGrace v-${new Date().toISOString().slice(0,10)}-Webhook`));

// language picker
bot.hears(/^🌐 /, async (ctx) => {
  const L = t(state.get(ctx.chat.id)?.lang || 'it');
  await ctx.reply(
    L.langPick,
    Markup.inlineKeyboard([
      [ Markup.button.callback('Italiano 🇮🇹', 'lang_it') ],
      [ Markup.button.callback('English 🇬🇧', 'lang_en') ],
      [ Markup.button.callback('Deutsch 🇩🇪', 'lang_de') ],
    ])
  );
});
bot.action(/lang_(it|en|de)/, async (ctx) => {
  const lang = ctx.match[1];
  const s = state.get(ctx.chat.id) || { mode: null, lang };
  s.lang = lang;
  state.set(ctx.chat.id, s);
  await ctx.answerCbQuery('✅');
  await ctx.editMessageText(t(lang).langPick + ' ✅');
  await ctx.reply('OK!', mainMenu(lang));
});

// Menu button (don’t print “here’s your menu”, just show it)
bot.hears(/^🎯 /, async (ctx) => {
  const lang = state.get(ctx.chat.id)?.lang || 'it';
  await ctx.reply(' ', mainMenu(lang));
});

// Journal button
bot.hears(/^📒 /, async (ctx) => {
  const s = state.get(ctx.chat.id) || { mode: null, lang: 'it' };
  s.mode = 'journal';
  state.set(ctx.chat.id, s);
  await ctx.reply(t(s.lang).askJournal, Markup.inlineKeyboard([
    [Markup.button.callback(t(s.lang).exportPdf, 'export_pdf')]
  ]));
});
bot.action('export_pdf', async (ctx) => {
  const s = state.get(ctx.chat.id) || { lang: 'it' };
  await exportJournalPdf(ctx, s.lang);
  await ctx.answerCbQuery('📄');
});

// Progress button (show recent notes)
bot.hears(/^📊 /, async (ctx) => {
  const s = state.get(ctx.chat.id) || { lang: 'it' };
  const L = t(s.lang);
  const rows = await fetchLatest(ctx.chat.id, 5);
  if (!rows.length) return ctx.reply('—');
  const bullets = rows.map(r => `• ${new Date(r.ts || Date.now()).toLocaleString()} — ⚡ SOS`)
                      .join('\n'); // quick placeholder tag
  await ctx.reply(`${L.recentNotes}\n${bullets}`);
});

// Coach button (simple style toggle demo)
bot.hears(/^📌 /, async (ctx) => {
  const s = state.get(ctx.chat.id) || { mode: null, lang: 'it', coachStyle: 'goal' };
  s.mode = 'coach';
  s.coachStyle = (s.coachStyle === 'goal') ? 'reflect' : 'goal';
  state.set(ctx.chat.id, s);
  await ctx.reply(t(s.lang).styleSet(s.coachStyle));
});

// SOS button
bot.hears(/^⚡ /, async (ctx) => {
  const s = state.get(ctx.chat.id) || { lang: 'it' };
  await saveJournal(ctx.chat.id, '⚡ SOS');
  await ctx.reply(t(s.lang).saved);
});

// Invite button
bot.hears(/^🔗 /, async (ctx) => {
  const s = state.get(ctx.chat.id) || { lang: 'it' };
  const uname = await ensureBotUsername();
  await ctx.reply(t(s.lang).inviteText(uname));
});

// Fallback text handler (journal or coach or default)
bot.on('text', async (ctx) => {
  const s = state.get(ctx.chat.id) || { mode: null, lang: 'it' };
  const L = t(s.lang);
  const txt = (ctx.message.text || '').trim();

  if (s.mode === 'journal') {
    try {
      await saveJournal(ctx.chat.id, txt);
      await ctx.reply(L.saved, Markup.inlineKeyboard([
        [Markup.button.callback(L.exportPdf, 'export_pdf')]
      ]));
    } catch (e) {
      console.error('[journal] save failed', e);
      await ctx.reply('Ops, non sono riuscita a salvare. Riprova più tardi.');
    }
    return;
  }

  if (s.mode === 'coach') {
    // minimal demo flows
    if (s.coachStyle === 'goal') {
      await saveJournal(ctx.chat.id, `🎯 Goal: ${txt}`);
      await ctx.reply(L.styleSet('goal'));
    } else {
      await saveJournal(ctx.chat.id, `🪞 Reflect: ${txt}`);
      await ctx.reply(L.styleSet('reflect'));
    }
    return;
  }

  // default: nudge to journal
  await ctx.reply(L.askJournal);
});

// ----- Webhook vs Polling (Render-safe) -------------------------------------
async function boot() {
  // Healthcheck endpoint (Render needs something listening)
  app.get('/healthz', (_req, res) => res.status(200).send('ok'));

  if (RENDER_EXTERNAL_URL) {
    // WEBHOOK MODE on Render
    const baseUrl = RENDER_EXTERNAL_URL.replace(/\/+$/, '');
    const hookPath = `/tg/${BOT_TOKEN}`; // unique path
    const fullUrl = `${baseUrl}${hookPath}`;

    // Set webhook (idempotent)
    const info = await bot.telegram.getWebhookInfo();
    if (info.url !== fullUrl) {
      await bot.telegram.deleteWebhook().catch(() => {});
      await bot.telegram.setWebhook(fullUrl);
      console.log('[tg] webhook set to', fullUrl);
    }

    app.use(bot.webhookCallback(hookPath));

    const port = Number(PORT) || 10000;
    app.listen(port, () => {
      console.log(`[hc] listening on ${port}`);
      console.log('Your service is live 🌸 (webhook mode)');
    });
  } else {
    // LOCAL DEV: polling (make sure Render is paused!)
    const port = 10000;
    http.createServer(app).listen(port, () => {
      console.log(`[hc] listening on ${port} (local)`);
    });
    await bot.launch();
    console.log('Bot launched in polling mode (local).');
  }

  // Graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

boot().catch((e) => {
  console.error('Boot error', e);
  process.exit(1);
});

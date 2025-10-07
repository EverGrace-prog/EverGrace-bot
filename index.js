// index.js  — EverGrace bot (CommonJS)

require('dotenv').config();

const http = require('http');
const { Telegraf, Markup, session } = require('telegraf');
const PDFDocument = require('pdfkit');
const { createClient } = require('@supabase/supabase-js');

// --- env checks -------------------------------------------------
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!BOT_TOKEN) throw new Error('[env] Missing BOT_TOKEN');
if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('[env] Missing SUPABASE_URL or SUPABASE_KEY');

// --- supabase ---------------------------------------------------
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
  global: { headers: { 'x-application-name': 'EverGrace-bot' } }
});

// --- bot bootstrap ----------------------------------------------
const bot = new Telegraf(BOT_TOKEN);
bot.use(session());

// bot username (for invite link); filled on launch if not given
let BOT_USERNAME = process.env.BOT_USERNAME || '';

// --- i18n (minimal, extend as needed) ---------------------------
const locales = {
  en: {
    menu_prompt: 'Choose an action:',
    journal_start: 'Tell me: what’s on your mind today? ✍️',
    journal_saved: 'Noted. ✅ Want to add more?',
    save_failed: 'Oops, I couldn’t save. Please try again later.',
    coach_prompt: 'Done. New style: goal. What’s the next micro-step?',
    sos_prompt: 'I’m here. What’s happening right now?',
    progress_title: 'Your recent entries',
    invite_text: 'Invite a friend with this link:',
    export_pdf: 'Export PDF',
    lang_pick: 'Pick your language:',
    lang_done: 'Language updated.',
  },
  it: {
    menu_prompt: 'Scegli un’azione:',
    journal_start: 'Raccontami: cosa hai in mente oggi? ✍️',
    journal_saved: 'Annotato. ✅ Vuoi aggiungere altro?',
    save_failed: 'Ops, non sono riuscita a salvare. Riprova più tardi.',
    coach_prompt: 'Fatto. Nuovo stile: goal. Qual è il prossimo micro-passo?',
    sos_prompt: 'Sono qui. Cosa sta succedendo adesso?',
    progress_title: 'Le tue note recenti',
    invite_text: 'Invita un’amica/o con questo link:',
    export_pdf: 'Esporta PDF',
    lang_pick: 'Scegli la lingua:',
    lang_done: 'Lingua aggiornata.',
  },
  de: {
    menu_prompt: 'Wähle eine Aktion:',
    journal_start: 'Erzähl mir: Was beschäftigt dich heute? ✍️',
    journal_saved: 'Notiert. ✅ Möchtest du noch etwas hinzufügen?',
    save_failed: 'Ups, das Speichern ist fehlgeschlagen. Bitte später erneut versuchen.',
    coach_prompt: 'Erledigt. Neuer Stil: Ziel. Was ist der nächste Mini-Schritt?',
    sos_prompt: 'Ich bin da. Was passiert gerade?',
    progress_title: 'Deine letzten Einträge',
    invite_text: 'Lade jemanden mit diesem Link ein:',
    export_pdf: 'PDF exportieren',
    lang_pick: 'Sprache auswählen:',
    lang_done: 'Sprache aktualisiert.',
  }
};

function t(ctx, key) {
  const lang = ctx.session?.lang || 'it';
  return (locales[lang] && locales[lang][key]) || (locales['en'][key]) || key;
}

// --- helpers ----------------------------------------------------
const BTN = {
  menu:     ['🎯 Menu', 'Menu', '🏠 Menu', '🏠 Home', 'Home', '/menu'],
  journal:  ['📒 Journal', 'Journal', '/journal'],
  coach:    ['📌 Coach', 'Coach', '/coach'],
  sos:      ['⚡ SOS', 'SOS', '/sos'],
  progress: ['📊 Progress', 'Progress', '/progress'],
  invite:   ['🔗 Invita', 'Invita', 'Invite', '/invite'],
};

function normalize(s='') {
  return s.toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\p{L}\p{N}\s/]/gu, '')
    .trim();
}
function matches(text, options) {
  const n = normalize(text);
  return options.some(o => normalize(o) === n);
}

function kbMain() {
  return Markup.keyboard([
    [{ text: '📒 Journal' }, { text: '📊 Progress' }],
    [{ text: '📌 Coach' },   { text: '⚡ SOS' }],
    [{ text: '🔗 Invita' },  { text: '🎯 Menu' }]
  ]).resize();
}

async function showMenu(ctx) {
  await ctx.reply(t(ctx, 'menu_prompt'), { reply_markup: kbMain() });
}

async function sendProgress(ctx) {
  const chatId = String(ctx.chat.id);
  const { data, error } = await sb.from('journal')
    .select('id,text,ts')
    .eq('chat_id', chatId)
    .order('id', { ascending: false })
    .limit(5);
  if (error) {
    console.error('[progress] get error', error);
    return ctx.reply(t(ctx, 'save_failed'));
  }
  if (!data || data.length === 0) {
    return ctx.reply(t(ctx, 'progress_title') + ' — (vuoto)');
  }
  const lines = data.map(r =>
    `• ${new Date(r.ts).toLocaleString()} — ${r.text}`
  ).join('\n');
  await ctx.reply(`${t(ctx, 'progress_title')}:\n${lines}`);
}

async function exportJournalPDF(ctx) {
  const chatId = String(ctx.chat.id);
  const { data, error } = await sb.from('journal')
    .select('text,ts')
    .eq('chat_id', chatId)
    .order('id', { ascending: true })
    .limit(1000);
  if (error) {
    console.error('[pdf] fetch error', error);
    return ctx.reply(t(ctx, 'save_failed'));
  }
  const doc = new PDFDocument({ margin: 48 });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  doc.on('end', async () => {
    const file = Buffer.concat(chunks);
    await ctx.replyWithDocument(
      { source: file, filename: `journal_${chatId}_${Date.now()}.pdf` },
      { caption: t(ctx, 'export_pdf') }
    );
  });
  doc.fontSize(18).text('EverGrace — Journal', { align: 'center' });
  doc.moveDown();
  (data || []).forEach((row, i) => {
    doc.fontSize(11).fillColor('#666')
      .text(new Date(row.ts).toLocaleString());
    doc.moveDown(0.2);
    doc.fontSize(13).fillColor('#000').text(row.text);
    if (i < data.length - 1) { doc.moveDown(); doc.moveTo(48, doc.y).lineTo(550, doc.y).strokeColor('#eee').stroke(); doc.moveDown(); }
  });
  doc.end();
}

// --- middleware: ensure session + interrupts -------------------
bot.use((ctx, next) => { ctx.session ??= { lang: 'it' }; return next(); });

bot.use(async (ctx, next) => {
  const text = ctx.message?.text;
  if (!text) return next();
  // Any known button or slash command interrupts flows
  if (matches(text, [].concat(...Object.values(BTN))) || text.startsWith('/')) {
    ctx.session.awaitingJournal = false;
    ctx.session.compose = null;
    ctx.session.mode = null;
  }
  return next();
});

// --- language picker -------------------------------------------
bot.command('lang', async (ctx) => {
  await ctx.reply(t(ctx, 'lang_pick'), {
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback('🇮🇹 Italiano', 'lang_it')],
      [Markup.button.callback('🇬🇧 English', 'lang_en')],
      [Markup.button.callback('🇩🇪 Deutsch', 'lang_de')]
    ])
  });
});
bot.action(/^lang_(en|it|de)$/, async (ctx) => {
  const lang = ctx.match[1];
  ctx.session.lang = lang;
  await ctx.answerCbQuery('OK');
  await ctx.editMessageText(t(ctx, 'lang_done'));
  await showMenu(ctx);
});

// --- start & version -------------------------------------------
bot.start(async (ctx) => {
  // payload like: /start lang_it
  const payload = (ctx.startPayload || '').trim();
  if (/^lang_(en|it|de)$/.test(payload)) {
    ctx.session.lang = payload.split('_')[1];
  }
  await showMenu(ctx);
});
bot.command('menu', showMenu);

// --- journal ----------------------------------------------------
bot.hears((t_) => matches(t_, BTN.journal), async (ctx) => {
  ctx.session.awaitingJournal = true;
  await ctx.reply(t(ctx, 'journal_start'), {
    reply_markup: Markup.inlineKeyboard([
      [Markup.button.callback(t(ctx, 'export_pdf'), 'export_pdf')]
    ])
  });
});
bot.command('journal', async (ctx) => {
  ctx.session.awaitingJournal = true;
  await ctx.reply(t(ctx, 'journal_start'));
});

bot.action('export_pdf', async (ctx) => {
  await ctx.answerCbQuery('PDF…');
  await exportJournalPDF(ctx);
});

// free text to journal only when awaiting
bot.on('text', async (ctx, next) => {
  const text = (ctx.message?.text || '').trim();
  if (!text) return next();

  // skip if it is a known button/command (already intercepted)
  if (matches(text, [].concat(...Object.values(BTN))) || text.startsWith('/')) return next();

  if (ctx.session.awaitingJournal) {
    try {
      const chatId = String(ctx.chat.id);
      const { error } = await sb.from('journal').insert({ chat_id: chatId, text });
      if (error) throw error;
      ctx.session.awaitingJournal = false; // <<< important reset
      await ctx.reply(t(ctx, 'journal_saved'), { reply_markup: kbMain() });
    } catch (e) {
      console.error('[journal] insert error', e);
      await ctx.reply(t(ctx, 'save_failed'));
    }
    return; // handled
  }

  // not in a flow → fall through to next (coach/sos/smalltalk)
  return next();
});

// --- coach ------------------------------------------------------
bot.hears((t_) => matches(t_, BTN.coach), async (ctx) => {
  ctx.session.mode = 'coach';
  await ctx.reply(t(ctx, 'coach_prompt'));
});
bot.command('coach', async (ctx) => {
  ctx.session.mode = 'coach';
  await ctx.reply(t(ctx, 'coach_prompt'));
});

// --- SOS --------------------------------------------------------
bot.hears((t_) => matches(t_, BTN.sos), async (ctx) => {
  ctx.session.mode = 'sos';
  await ctx.reply(t(ctx, 'sos_prompt'));
});
bot.command('sos', async (ctx) => {
  ctx.session.mode = 'sos';
  await ctx.reply(t(ctx, 'sos_prompt'));
});

// --- progress ---------------------------------------------------
bot.hears((t_) => matches(t_, BTN.progress), sendProgress);
bot.command('progress', sendProgress);

// --- invite -----------------------------------------------------
async function inviteBlock(ctx) {
  const link = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}` : 'https://t.me';
  await ctx.reply(t(ctx, 'invite_text'), {
    reply_markup: Markup.inlineKeyboard([[Markup.button.url('🔗 EverGrace', link)]])
  });
}
bot.hears((t_) => matches(t_, BTN.invite), inviteBlock);
bot.command('invite', inviteBlock);

// --- small talk fallback ---------------------------------------
bot.on('text', async (ctx) => {
  // simple friendly fallback; plug LLM if you wish
  const lang = ctx.session.lang || 'it';
  const reply =
    lang === 'en' ? 'Noted. What’s the next micro-step?'
    : lang === 'de' ? 'Notiert. Nächster Mini-Schritt?'
    : 'Registrato. Prossimo micro-passo?';
  await ctx.reply(reply);
});

// --- launch -----------------------------------------------------
(async () => {
  // discover username if not provided
  try {
    const me = await bot.telegram.getMe();
    BOT_USERNAME = BOT_USERNAME || me.username || '';
    console.log(`[tg] bot @${me.username} ready`);
  } catch (e) {
    console.warn('[tg] getMe failed', e.message);
  }

  await bot.launch();
  console.log('EverGrace bot launched');

  // Render healthcheck server (port 10000)
  const port = process.env.PORT || 10000;
  http
    .createServer((_, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    })
    .listen(port, () => console.log(`[hc] listening on ${port}`));

  // graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));

  // show which envs are present (safe)
  console.log('[env] Present:',
    'BOT_TOKEN(ok),',
    SUPABASE_URL ? 'SUPABASE_URL(ok),' : 'SUPABASE_URL(missing),',
    SUPABASE_KEY ? 'SUPABASE_KEY(ok)' : 'SUPABASE_KEY(missing)'
  );
})();

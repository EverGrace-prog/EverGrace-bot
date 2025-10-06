// EverGrace — CommonJS build (IT/EN/DE)
// ─────────────────────────────────────────────────────────────────────────────
require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

// ── ENV ──────────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_KEY;

if (!BOT_TOKEN)      console.error('[env] Missing BOT_TOKEN');
if (!SUPABASE_URL)   console.error('[env] Missing SUPABASE_URL');
if (!SUPABASE_KEY)   console.error('[env] Missing SUPABASE_SERVICE_ROLE or SUPABASE_KEY');

const bot = new Telegraf(BOT_TOKEN);
const sb  = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Healthcheck (Render) ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
http.createServer((_, res) => { res.writeHead(200); res.end('ok'); })
    .listen(PORT, () => console.log(`[hc] listening on :${PORT}`));

// ── Locales & Tone Engine (IT/EN/DE) ─────────────────────────────────────────
function loadLocales() {
  if (!global.__EG_LOCALE) {
    try {
      global.__EG_LOCALE = {
        it: require('./locales/it.json'),
        en: require('./locales/en.json'),
        de: require('./locales/de.json'),
      };
    } catch (e) {
      console.error('[i18n] error loading locales', e);
      global.__EG_LOCALE = { it:{}, en:{}, de:{} };
    }
  }
  return global.__EG_LOCALE;
}
const LOCALE = (lang, key, vars = {}) => {
  const dicts = loadLocales();
  const dict  = dicts[lang] || dicts.it || {};
  let out = key.split('.').reduce((o,k)=> (o && o[k]) || null, dict) || key;
  for (const [k,v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v));
  return out;
};

// lingua/coach fallback in memoria se DB assente
const memCoach = new Map(); // chatId -> 'friend'|'spiritual'|'goal'
const memLang  = new Map(); // chatId -> 'it'|'en'|'de'

// preferenza lingua
async function getUserLanguage(ctx) {
  const chatId = ctx.chat.id;
  // 1) DB -> users.language
  try {
    const { data, error } = await sb.from('users')
      .select('language')
      .eq('telegram_id', chatId)
      .maybeSingle();
    if (error) throw error;
    if (data?.language) {
      memLang.set(chatId, data.language);
      return data.language;
    }
  } catch(_) { /* fallback below */ }

  // 2) in memoria?
  if (memLang.has(chatId)) return memLang.get(chatId);

  // 3) dal profilo Telegram
  const code = (ctx.from?.language_code || '').slice(0,2).toLowerCase();
  const mapped = ['it','en','de'].includes(code) ? code : 'it';
  memLang.set(chatId, mapped);
  return mapped;
}
async function setUserLanguage(chatId, lang) {
  memLang.set(chatId, lang);
  try {
    await sb.from('users')
      .upsert({ telegram_id: chatId, language: lang }, { onConflict: 'telegram_id' });
  } catch(_) { /* ok fallback */ }
}

async function getCoachMode(chatId) {
  try {
    const { data, error } = await sb.from('users')
      .select('coach_mode')
      .eq('telegram_id', chatId)
      .maybeSingle();
    if (error) throw error;
    const m = data?.coach_mode || memCoach.get(chatId) || 'friend';
    return m;
  } catch(_) {
    return memCoach.get(chatId) || 'friend';
  }
}
async function setCoachMode(chatId, mode) {
  memCoach.set(chatId, mode);
  try {
    await sb.from('users')
      .upsert({ telegram_id: chatId, coach_mode: mode }, { onConflict: 'telegram_id' });
  } catch(_) { /* ok fallback */ }
}

async function speak(ctx, key, vars = {}) {
  const chatId = ctx.chat.id;
  const lang = await getUserLanguage(ctx);
  const mode = await getCoachMode(chatId);
  const styled = LOCALE(lang, `modes.${mode}.${key}`, vars);
  if (styled && styled !== `modes.${mode}.${key}`) return styled;
  return LOCALE(lang, `common.${key}`, vars);
}

// ── Menu “colorato” per coach mode ───────────────────────────────────────────
function menuLabels(mode='friend', lang='it') {
  // testi base
  const base = {
    it: { menu:'Menu', journal:'Journal', coach:'Coach', progress:'Progress', sos:'SOS', invite:'Invita' },
    en: { menu:'Menu', journal:'Journal', coach:'Coach', progress:'Progress', sos:'SOS', invite:'Invite' },
    de: { menu:'Menü', journal:'Journal', coach:'Coach', progress:'Fortschritt', sos:'SOS', invite:'Einladen' },
  }[lang] || { menu:'Menu', journal:'Journal', coach:'Coach', progress:'Progress', sos:'SOS', invite:'Invite' };

  const toneMap = {
    friend:    { menu:'🧭', journal:'📓', coach:'🧑‍🏫', progress:'📈', sos:'🆘', invite:'🔗' },
    spiritual: { menu:'🕊️', journal:'🕯️', coach:'🙏',   progress:'🌿', sos:'🫶', invite:'🔗' },
    goal:      { menu:'🎯', journal:'📒', coach:'📌',   progress:'📊', sos:'⚡', invite:'🔗' },
  }[mode] || { menu:'🧭', journal:'📓', coach:'🧑‍🏫', progress:'📈', sos:'🆘', invite:'🔗' };

  return {
    home:     `${toneMap.menu} ${base.menu}`,
    journal:  `${toneMap.journal} ${base.journal}`,
    coach:    `${toneMap.coach} ${base.coach}`,
    progress: `${toneMap.progress} ${base.progress}`,
    sos:      `${toneMap.sos} ${base.sos}`,
    invite:   `${toneMap.invite} ${base.invite}`,
  };
}
async function showMenu(ctx) {
  const lang = await getUserLanguage(ctx);
  const mode = await getCoachMode(ctx.chat.id);
  const L = menuLabels(mode, lang);
  const kb = Markup.keyboard([
    [L.journal, L.progress],
    [L.coach,   L.sos     ],
    [L.invite,  L.home    ],
  ]).resize();
  await ctx.reply('\u2063', kb); // messaggio invisibile
}

// ── Journal & Streaks ────────────────────────────────────────────────────────
const expectingJournal = new Set();

async function saveJournal(chatId, text) {
  const { error } = await sb.from('journal').insert({ chat_id: chatId, text });
  if (error) throw error;
}
async function hasCheckInToday(chatId) {
  const start = new Date(); start.setHours(0,0,0,0);
  const end   = new Date(); end.setHours(23,59,59,999);
  const { data, error } = await sb.from('journal')
    .select('id')
    .eq('chat_id', chatId)
    .gte('ts', start.toISOString())
    .lte('ts', end.toISOString());
  if (error) return false;
  return (data || []).length > 0;
}
async function computeStreak(chatId) {
  const { data, error } = await sb.from('journal')
    .select('ts')
    .eq('chat_id', chatId)
    .order('ts', { ascending:false });
  if (error || !data) return 0;
  const days = new Set(data.map(r => new Date(r.ts).toISOString().slice(0,10)));
  let streak = 0;
  for (let d = new Date(); ; d.setDate(d.getDate()-1)) {
    const key = d.toISOString().slice(0,10);
    if (days.has(key)) streak++;
    else break;
  }
  return streak;
}
async function doCheckIn(chatId) {
  if (await hasCheckInToday(chatId)) {
    const st = await computeStreak(chatId);
    return { msg: `Hai già fatto check-in oggi. Streak attuale: ${st} 🔥` };
  }
  await saveJournal(chatId, '#checkin');
  const st = await computeStreak(chatId);
  return { msg: `Check-in registrato. Streak: ${st} 🔥` };
}

// ── PDF Export ───────────────────────────────────────────────────────────────
async function exportPDF(ctx) {
  let PDFDocument;
  try { PDFDocument = require('pdfkit'); }
  catch {
    await ctx.reply('Per esportare in PDF installa prima: `npm i pdfkit`', { parse_mode:'Markdown' });
    return;
  }

  const { data, error } = await sb.from('journal')
    .select('id,text,ts')
    .eq('chat_id', ctx.chat.id)
    .order('id', { ascending:true });

  if (error) { console.error('[pdf] select', error); return ctx.reply('Errore durante l’esportazione.'); }
  if (!data || !data.length) return ctx.reply('Nulla da esportare.');

  const tmpDir = process.env.RENDER ? '/tmp' : path.join(__dirname, 'exports');
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive:true });
  const file = path.join(tmpDir, `journal_${ctx.chat.id}_${Date.now()}.pdf`);

  const doc = new PDFDocument({ margin: 40 });
  const stream = fs.createWriteStream(file);
  doc.pipe(stream);

  doc.fontSize(18).text('Journal — EverGrace', { underline:true });
  doc.moveDown(1);

  for (const e of data) {
    const when = new Date(e.ts).toLocaleString('it-IT');
    doc.fontSize(12).text(`#${e.id} — ${when}`);
    doc.moveDown(0.25);
    doc.fontSize(12).text(e.text || '', { align:'left' });
    doc.moveDown(0.75);
  }

  doc.end();
  await new Promise(r => stream.on('finish', r));
  await ctx.replyWithDocument({ source:file, filename:path.basename(file) });
}

// ── Handlers ────────────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  await showMenu(ctx);
  const hello = await speak(ctx, 'sos_open'); // benvenuto morbido
  await ctx.reply(hello);
});

// Menu
bot.command('menu', showMenu);
bot.hears(/Menu|Menü/i, showMenu);

// Lingua rapida (facoltativo): /lang it|en|de
bot.command('lang', async (ctx) => {
  const parts = (ctx.message.text || '').trim().split(/\s+/);
  const pick = (parts[1] || '').toLowerCase();
  if (!['it','en','de'].includes(pick)) {
    return ctx.reply('Usa: /lang it | en | de');
  }
  await setUserLanguage(ctx.chat.id, pick);
  await ctx.reply(`Lingua impostata: ${pick.toUpperCase()}`);
  await showMenu(ctx);
});

// Coach picker
bot.hears(/Coach|Guida|🙏|📌/i, async (ctx) => {
  const curr = await getCoachMode(ctx.chat.id);
  await ctx.reply(
    `Stile attuale: *${curr}* — quale preferisci?`,
    {
      parse_mode:'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🧑‍🤝‍🧑 Amico', 'mode_friend')],
        [Markup.button.callback('🕯️ Spirituale', 'mode_spiritual')],
        [Markup.button.callback('🎯 Goal', 'mode_goal')],
      ])
    }
  );
});
bot.action(/mode_(friend|spiritual|goal)/, async (ctx) => {
  const m = ctx.match[1];
  await setCoachMode(ctx.chat.id, m);
  await ctx.answerCbQuery('Aggiornato');
  await ctx.editMessageText(`Fatto. Nuovo stile: *${m}*`, { parse_mode:'Markdown' });
  await showMenu(ctx);
});

// Journal
bot.hears(/📓|📒|Journal/i, async (ctx) => {
  expectingJournal.add(ctx.chat.id);
  const msg = await speak(ctx, 'journal_prompt');
  await ctx.reply(
    msg,
    Markup.inlineKeyboard([[ Markup.button.callback('📄 Esporta PDF', 'journal_pdf') ]])
  );
});
bot.action('journal_pdf', async (ctx) => {
  await ctx.answerCbQuery('Esporto PDF…');
  await exportPDF(ctx);
});
bot.on('text', async (ctx, next) => {
  if (!expectingJournal.has(ctx.chat.id)) return next();
  const txt = (ctx.message.text || '').trim();
  if (!txt) return;
  try {
    await saveJournal(ctx.chat.id, txt);
    const saved = await speak(ctx, 'journal_saved');
    await ctx.reply(saved);
  } catch (e) {
    console.error('[journal] save error', e);
    await ctx.reply('Ops, non sono riuscita a salvare. Riprova più tardi.');
  }
});

// Progress / Streak
bot.hears(/📈|📊|Progress|Fortschritt|Cammino/i, async (ctx) => {
  const st = await computeStreak(ctx.chat.id);
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback('✅ Check-in', 'streak_checkin')],
    [Markup.button.callback('ℹ️ Dettagli', 'streak_info')],
  ]);
  await ctx.reply(`Streak attuale: ${st} 🔥`, kb);
});
bot.action('streak_checkin', async (ctx) => {
  const out = await doCheckIn(ctx.chat.id);
  const msg = await speak(ctx, 'streak_after_checkin', { text: out.msg });
  await ctx.answerCbQuery('Fatto!');
  await ctx.editMessageText(msg);
});
bot.action('streak_info', async (ctx) => {
  const st = await computeStreak(ctx.chat.id);
  const info = `Giorni consecutivi con attività nel diario: ${st}.`;
  const msg = await speak(ctx, 'streak_info_wrap', { text: info });
  await ctx.answerCbQuery();
  await ctx.editMessageText(msg);
});

// SOS
bot.hears(/🆘|SOS|⚡/i, async (ctx) => {
  const msg = await speak(ctx, 'sos_open');
  await ctx.reply(
    msg,
    Markup.inlineKeyboard([
      [Markup.button.callback('Parlane con me', 'sos_talk')],
      [Markup.button.callback('Tecniche rapide', 'sos_tools')],
    ])
  );
});
bot.action('sos_talk', async (ctx) => {
  await ctx.answerCbQuery();
  const msg = await speak(ctx, 'sos_talk_start');
  await ctx.editMessageText(msg);
});
bot.action('sos_tools', async (ctx) => {
  await ctx.answerCbQuery();
  const msg = await speak(ctx, 'sos_tools_intro');
  await ctx.editMessageText(msg);
});

// Invite
bot.hears(/Invite|Invita|Einladen|🔗/i, async (ctx) => {
  const me = await bot.telegram.getMe();
  const link = `https://t.me/${me.username}?start=${ctx.chat.id}`;
  await ctx.reply(`Condividi EverGrace: ${link}`);
});

// Fallback error
bot.catch((err, ctx) => {
  console.error('[bot] error', err);
  try { ctx.reply('Oops—qualcosa è andato storto. Riprova.'); } catch {}
});

// Launch
bot.launch().then(() => console.log('Boot OK · EverGrace live (IT/EN/DE)'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

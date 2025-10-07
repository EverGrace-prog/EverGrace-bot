// index.js  — EverGrace (inline menu + safe journal)
// CommonJS (require), Node >=18

require('dotenv').config();
const http = require('http');
const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

// --- env -------------------------------------------------
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!BOT_TOKEN) throw new Error('[env] BOT_TOKEN missing');
if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('[env] Supabase vars missing');

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const bot = new Telegraf(BOT_TOKEN);

// Per deep link / invite
let BOT_USERNAME = '';

// --- mini session in RAM (per stato "sta scrivendo il diario") -------
const state = new Map(); // key: chatId, value: {mode?: 'journal'}

// --- helpers ----------------------------------------------------------
const zws = '\u2060'; // zero width space: messaggio "vuoto"

function menuInline() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📒 Journal', 'menu:journal'), Markup.button.callback('📊 Progress', 'menu:progress')],
    [Markup.button.callback('📌 Coach', 'menu:coach'), Markup.button.callback('⚡ SOS', 'menu:sos')],
    [Markup.button.callback('🔗 Invite', 'menu:invite'), Markup.button.callback('🎯 Menu', 'menu:home')]
  ]);
}

async function showMenu(ctx, edit = false) {
  try {
    if (edit && ctx.update?.callback_query?.message) {
      await ctx.editMessageText(zws, menuInline());
    } else {
      // invia un messaggio con solo carattere invisibile e i bottoni inline
      await ctx.reply(zws, menuInline());
    }
  } catch (e) {
    console.error('[menu] error', e);
  }
}

async function upsertUserByChat(ctx) {
  const chat_id = ctx.chat.id;
  // Assicura che la tabella users abbia almeno user_id/telegram_id oppure chat_id
  // Qui usiamo/creiamo una riga chiave su chat_id
  await sb.from('users').upsert({ chat_id }, { onConflict: 'chat_id' });
}

async function addJournal(chat_id, text) {
  return sb.from('journal').insert({ chat_id, text }).select('*').single();
}

// --- avvio -----------------------------------------------------------
bot.launch().then(() => console.log('EverGrace bot started.'));
bot.telegram.getMe().then(info => { BOT_USERNAME = info.username || ''; });

// --- /start, /menu, /help -------------------------------------------
bot.start(async (ctx) => {
  await upsertUserByChat(ctx);
  await ctx.reply('Ciao! 🌱 Benvenuta/o in EverGrace.');
  await showMenu(ctx);
});

bot.command('menu', async (ctx) => showMenu(ctx));
bot.command('help', async (ctx) => {
  await ctx.reply('Comandi: /menu, /help, /lang, /version. Usa i bottoni qui sotto per tutto il resto.');
  await showMenu(ctx);
});
bot.command('version', (ctx) => ctx.reply('EverGrace v-2025-10-07-inlineMenu'));

// --- CALLBACK MENU (inline) ------------------------------------------
bot.action('menu:home', async (ctx) => {
  await ctx.answerCbQuery();
  await showMenu(ctx, true);
});

bot.action('menu:journal', async (ctx) => {
  await ctx.answerCbQuery();
  state.set(ctx.chat.id, { mode: 'journal' });
  await ctx.reply('Raccontami: cosa hai in mente oggi? ✍️');
});

bot.action('menu:progress', async (ctx) => {
  await ctx.answerCbQuery();
  // placeholder progress (puoi sostituire con query reali Supabase)
  await ctx.reply('📊 Progress in arrivo: streaks, win e riepiloghi.');
});

bot.action('menu:coach', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('👌 Coach attivo. Dimmi il tuo micro-passo di oggi.');
});

bot.action('menu:sos', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('🫶 Respiro profondo. Scrivi una frase su cosa senti e un’azione gentile che puoi fare adesso.');
});

bot.action('menu:invite', async (ctx) => {
  await ctx.answerCbQuery();
  const link = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=invite_${ctx.chat.id}` : 'Apri Telegram e cerca “EverGrace”';
  await ctx.reply(`🔗 Condividi EverGrace:\n${link}`);
});

// --- JOURNAL: cattura SOLO testo libero quando la modalità è attiva ---
bot.on('text', async (ctx, next) => {
  const chatId = ctx.chat.id;
  const st = state.get(chatId);

  // Se è in modalità diario → salva
  if (st?.mode === 'journal') {
    const txt = (ctx.message.text || '').trim();
    if (!txt) return;

    // Evita di salvare stringhe “di servizio” tipo "Menu", "Coach", etc se arrivassero comunque
    const blacklist = ['menu', 'journal', 'progress', 'coach', 'sos', 'invite', 'invita'];
    if (blacklist.includes(txt.toLowerCase())) return;

    const { error } = await addJournal(chatId, txt);
    if (error) {
      console.error('[journal insert] error', error);
      await ctx.reply('Ops, non sono riuscita a salvare. Riprova più tardi.');
      return;
    }
    await ctx.reply('Annotato. Vuoi aggiungere altro?');
    return;
  }

  // Fuori dalla modalità diario:
  // se l’utente scrive “menu” mostriamo i bottoni senza testo extra
  const t = (ctx.message.text || '').toLowerCase();
  if (t === 'menu' || t === '🏠 menu' || t === '/menu') {
    await showMenu(ctx);
    return;
  }

  // Altrimenti lascio proseguire altri handler (se ne aggiungeremo)
  return next();
});

// --- /lang (picker semplice inline) -----------------------------------
bot.command('lang', async (ctx) => {
  await ctx.reply('Scegli la lingua:', Markup.inlineKeyboard([
    [Markup.button.callback('🇬🇧 English', 'lang:en'), Markup.button.callback('🇮🇹 Italiano', 'lang:it')],
    [Markup.button.callback('🇩🇪 Deutsch', 'lang:de')]
  ]));
});
bot.action(/lang:(en|it|de)/, async (ctx) => {
  const code = ctx.match[1];
  await ctx.answerCbQuery(`Lingua: ${code}`);
  // Se hai colonna language in users, salvala qui:
  await sb.from('users').upsert({ chat_id: ctx.chat.id, language: code }, { onConflict: 'chat_id' });
  await showMenu(ctx, true);
});

// --- healthcheck per Render ------------------------------------------
const PORT = process.env.PORT || 10000;
http
  .createServer((_, res) => res.end('OK'))
  .listen(PORT, () => console.log(`[hc] listening on ${PORT}`));

// shutdown pulito
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

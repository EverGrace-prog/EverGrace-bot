// index.js  (CommonJS)

require('dotenv').config();
const http = require('http');
const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

// ==== ENV ====
const BOT_TOKEN = process.env.BOT_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_KEY;

if (!BOT_TOKEN)  console.error('[env] Missing BOT_TOKEN');
if (!SUPABASE_URL) console.error('[env] Missing SUPABASE_URL');
if (!SUPABASE_KEY) console.error('[env] Missing SUPABASE_SERVICE_ROLE or SUPABASE_KEY');

// ==== Clients ====
const bot = new Telegraf(BOT_TOKEN);
const sb  = createClient(SUPABASE_URL, SUPABASE_KEY);

// ==== Healthcheck (Render) ====
const PORT = process.env.PORT || 10000;
http.createServer((_, res) => { res.writeHead(200); res.end('ok'); }).listen(PORT, () => {
  console.log(`[hc] listening on :${PORT}`);
});

// ==== UI ====
const mainKeyboard = () => Markup.keyboard([
  [ '🧭 Menu', '📓 Journal' ],
  [ '👩‍🏫 Coach', '📈 Progress' ],
  [ '🆘 SOS', '🔗 Invite' ]
]).resize();

const sendMenu = (ctx) => {
  return ctx.reply(' ', mainKeyboard()); // niente testo “Here’s your menu”
};

// ==== Supabase helpers ====
async function saveJournal(chatId, text) {
  const payload = { chat_id: chatId, text };
  const { data, error } = await sb.from('journal').insert([payload]).select();
  if (error) {
    console.error('[journal.insert] error:', error);
    return { ok: false, error };
  }
  return { ok: true, data };
}

async function latestJournal(chatId, limit = 5) {
  const { data, error } = await sb
    .from('journal')
    .select('*')
    .eq('chat_id', chatId)
    .order('ts', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('[journal.select] error:', error);
    return { ok: false, error };
  }
  return { ok: true, data };
}

// ==== Commands / Buttons ====
bot.start(async (ctx) => {
  await ctx.reply('Ooolà! Come va? Sono qui per te. Tocca un pulsante o scrivimi liberamente.', mainKeyboard());
});

bot.command('menu', sendMenu);
bot.hears('🧭 Menu', sendMenu);

bot.hears('📓 Journal', async (ctx) => {
  await ctx.reply('Scrivi quello che vuoi annotare. Te lo salvo nel diario.');
});

bot.hears('👩‍🏫 Coach', async (ctx) => {
  await ctx.reply('Che tipo di supporto vuoi oggi?\n• Amico\n• Guida spirituale\n• Coach & Goal');
});

bot.hears('📈 Progress', async (ctx) => {
  const res = await latestJournal(ctx.chat.id, 3);
  if (!res.ok) return ctx.reply('Non riesco a leggere ora i progressi. Riprova più tardi.');
  if (!res.data?.length) return ctx.reply('Ancora nessuna nota. Inizia dal Journal 💬');
  const lines = res.data.map(r => `• ${new Date(r.ts).toLocaleString()} — ${r.text.slice(0,80)}`);
  await ctx.reply(`Ultime note:\n${lines.join('\n')}`);
});

bot.hears('🆘 SOS', async (ctx) => {
  await ctx.reply('Dimmi cosa succede. Ti ascolto. Se vuoi posso suggerirti un piccolo esercizio di calma. 🙏');
});

bot.hears('🔗 Invite', async (ctx) => {
  const username = (await bot.telegram.getMe()).username;
  await ctx.reply(`Invita chi vuoi: https://t.me/${username}?start=hi`);
});

// ==== Free text → save to journal ====
bot.on('text', async (ctx) => {
  const msg = (ctx.message?.text || '').trim();

  // Evita di rispondere al puro “Menu” ecc. (sono già gestiti sopra)
  const reserved = ['🧭 Menu','📓 Journal','👩‍🏫 Coach','📈 Progress','🆘 SOS','🔗 Invite'];
  if (reserved.includes(msg)) return;

  const res = await saveJournal(ctx.chat.id, msg);
  if (!res.ok) {
    await ctx.reply('Ops, non sono riuscita a salvare. Riprova più tardi.');
    return;
  }
  await ctx.reply('Annotato. Vuoi aggiungere altro?');
});

// ==== Errors & Launch ====
bot.catch((err, ctx) => {
  console.error('[bot.catch]', err);
  try { ctx.reply('Oops—qualcosa è andato storto. Riprova più tardi.'); } catch {}
});

bot.launch().then(() => {
  console.log('Boot OK · EverGrace is live.');
});
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

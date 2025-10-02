// index.js — EverGrace (CommonJS)

// 1) ENV load (local only; on Render variables come from Settings/Env)
require('dotenv').config();

// 2) ----- ENV SANITY CHECK (NO SECRETS IN LOGS) -----
const requiredEnv = ['BOT_TOKEN', 'SUPABASE_URL', 'SUPABASE_KEY'];
const missing = requiredEnv.filter(k => !process.env[k] || String(process.env[k]).trim() === '');
if (missing.length) {
  console.error('[env] Missing:', missing.join(', '));
  console.error('[env] Tip: Service → Settings → Environment: link your Env Group (EverGrace Keys) and Clear build cache & Deploy.');
  process.exit(1); // stop here so logs are clear
}
console.log('[env] Present:', requiredEnv.map(k => `${k}(ok)`).join(', '));

// 3) ----- Imports -----
const http = require('http');
const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

// 4) ----- Clients -----
const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 5) ----- Healthcheck server (Render) -----
const PORT = process.env.PORT || 10000;
http
  .createServer((_, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
  })
  .listen(PORT, () => console.log(`[hc] listening on :${PORT}`));

// 6) ----- Menu (compact)
function homeKeyboard() {
  return Markup.keyboard([
    ['🧭 Menu', '📓 Journal'],
    ['🧑‍🏫 Coach', '📈 Progress'],
    ['🆘 SOS', '🔗 Invite'],
  ]).resize();
}

// 7) ----- Basic handlers
bot.start(async (ctx) => {
  await ctx.reply('Ciao! Sono EverGrace. Tocca un pulsante per iniziare.', homeKeyboard());
});

bot.hears(/^(menu|🧭 Menu)$/i, async (ctx) => {
  // Mostra solo la tastiera, senza messaggi extra
  await ctx.reply(' ', homeKeyboard()); // space avoids “empty message” but keeps chat clean
});

bot.hears(/^(📓 Journal)$/i, async (ctx) => {
  await ctx.reply('Scrivi il tuo pensiero: inizierò a salvare le note.');
});

bot.hears(/^(🧑‍🏫 Coach)$/i, async (ctx) => {
  await ctx.reply('Scegli il tipo di coach:\n• Amico\n• Guida spirituale\n• Coach & Goal\n(Presto aggiungeremo profili e streaks!)');
});

bot.hears(/^(📈 Progress)$/i, async (ctx) => {
  await ctx.reply('Stiamo preparando streaks, streak freeze e tracciamento progressi. Coming soon!');
});

bot.hears(/^(🆘 SOS)$/i, async (ctx) => {
  await ctx.reply('Dimmi cosa sta succedendo. Ti ascolto. (Premi “Back” per tornare al menu)');
});

bot.hears(/^(🔗 Invite)$/i, async (ctx) => {
  const username = ctx.botInfo?.username || 'EverGraceRabeBot';
  const link = `https://t.me/${username}`;
  await ctx.reply(`Invita un amico: ${link}`);
});

// 8) ----- Example: store a quick journal entry (very basic)
bot.on('text', async (ctx, next) => {
  const text = (ctx.message?.text || '').trim();
  // ignore commands/buttons we already handle
  const known = ['🧭 Menu','📓 Journal','🧑‍🏫 Coach','📈 Progress','🆘 SOS','🔗 Invite'];
  if (!text || known.includes(text) || text.startsWith('/')) return next();

  // Save a tiny journal row (demo) keyed by chat id
  try {
    const { error } = await supabase
      .from('journal')
      .insert([{ chat_id: ctx.chat.id, text, ts: new Date().toISOString() }]);
    if (error) {
      console.error('[sb] insert error', error);
      await ctx.reply('Ops, non sono riuscita a salvare. Riprova più tardi.');
      return;
    }
    await ctx.reply('Annotato. Vuoi aggiungere altro?', homeKeyboard());
  } catch (e) {
    console.error('[journal] unhandled', e);
    await ctx.reply('Errore inatteso. Riprova più tardi.');
  }
});

// 9) ----- Launch
bot.launch()
  .then(() => console.log('EverGrace bot started'))
  .catch(err => {
    console.error('Bot launch failed:', err);
    process.exit(1);
  });

// 10) ----- Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

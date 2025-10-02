/* index.js - EverGrace bot (CommonJS) */
const http = require('http');
const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const { env, botToken, supabaseUrl, supabaseKey, port, appName, versionTag } = require('./config');

// --- Guard-rails ------------------------------------------------------------
if (!botToken) {
  console.error('[env] Missing BOT_TOKEN');
  process.exit(1);
}
if (!supabaseUrl || !supabaseKey) {
  console.error('[env] Missing SUPABASE_URL or SUPABASE_KEY');
  process.exit(1);
}

// --- Supabase ---------------------------------------------------------------
const sb = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false }
});

// helper: get/create user by telegram_id
async function upsertUser(teleId, language, name) {
  // assicurati di avere la colonna telegram_id in users (bigint)
  // e RLS con policy che consente al service di leggere/scrivere.
  const { data, error } = await sb
    .from('users')
    .upsert(
      { telegram_id: String(teleId), language, name },
      { onConflict: 'telegram_id' }
    )
    .select()
    .single();

  if (error) throw error;
  return data;
}

// --- Healthcheck HTTP (Render happy) ---------------------------------------
http
  .createServer((_, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`${appName} OK\n`);
  })
  .listen(port, () => console.log(`[srv] Healthcheck on :${port}`));

// --- Bot --------------------------------------------------------------------
const bot = new Telegraf(botToken);

// --- Utilities --------------------------------------------------------------
const HOME_KB = () =>
  Markup.keyboard([
    ['🏠 Menu', '🆘 SOS'],
    ['📓 Journal', '📈 Progress'],
    ['🧭 Coach', '🤝 Invite']
  ])
    .oneTime(false)
    .resize();

function mainMenuText() {
  return `Here's your menu:`;
}

function coachMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('👫 Amico', 'coach_friend')],
    [Markup.button.callback('✨ Guida spirituale', 'coach_spiritual')],
    [Markup.button.callback('🎯 Coach & Goal', 'coach_goal')]
  ]);
}

// --- State in-memory (lightweight) -----------------------------------------
const mem = new Map(); // chatId -> { mode: 'journal_write' | 'sos_open' | ... , coach:'friend'|'spiritual'|'goal' }

// --- Commands ---------------------------------------------------------------
bot.start(async (ctx) => {
  try {
    const u = await upsertUser(
      ctx.from.id,
      ctx.from.language_code || 'en',
      [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ')
    );
    mem.set(ctx.chat.id, { coach: u.coach || null });
    await ctx.reply(`Ciao ${ctx.from.first_name ?? ''}! Sono ${appName}. Come posso aiutarti oggi?`, HOME_KB());
  } catch (e) {
    console.error('[start]', e);
    await ctx.reply('Oops—something went wrong. Try again.');
  }
});

bot.command('version', (ctx) => ctx.reply(`${appName} ${versionTag}`));

// --- Menu & buttons ---------------------------------------------------------
bot.hears(['🏠 Menu', 'Menu', '/menu'], async (ctx) => {
  mem.delete(ctx.chat.id); // reset any flow
  await ctx.reply(mainMenuText(), HOME_KB());
});

// Invite link (deep link universale del bot)
bot.hears(['🤝 Invite', 'Invite'], (ctx) => {
  const username = ctx.botInfo?.username
    ? `https://t.me/${ctx.botInfo.username}`
    : 'https://t.me';
  ctx.reply(
    `Invite a friend to try ${appName}:\n${username}\n\n(They can start a chat and I’ll guide them.)`
  );
});

// --- SOS flow ---------------------------------------------------------------
bot.hears(['🆘 SOS', 'SOS'], async (ctx) => {
  mem.set(ctx.chat.id, { ...(mem.get(ctx.chat.id) || {}), mode: 'sos_open' });
  await ctx.reply('SOS: how can I help right now?');
  await ctx.reply(
    `If you are in immediate danger, call your local emergency number.\n🇪🇺 112 • 🇺🇸 911\n🇮🇹 Samaritans: 06 77208977\n🌐 findahelpline.com`
  );
});

bot.action(/sos_.+/, (ctx) => ctx.answerCbQuery()); // placeholder

// --- Coach picker -----------------------------------------------------------
bot.hears(['🧭 Coach', 'Coach'], async (ctx) => {
  await ctx.reply('Scegli lo stile di supporto che preferisci:', coachMenu());
});

bot.action('coach_friend', async (ctx) => {
  await sb.from('users').update({ coach: 'friend' }).eq('telegram_id', String(ctx.from.id));
  mem.set(ctx.chat.id, { ...(mem.get(ctx.chat.id) || {}), coach: 'friend' });
  await ctx.editMessageText('Modalità impostata: 👫 Amico.\nParlami liberamente, sono qui per ascoltarti.');
});
bot.action('coach_spiritual', async (ctx) => {
  await sb.from('users').update({ coach: 'spiritual' }).eq('telegram_id', String(ctx.from.id));
  mem.set(ctx.chat.id, { ...(mem.get(ctx.chat.id) || {}), coach: 'spiritual' });
  await ctx.editMessageText('Modalità impostata: ✨ Guida spirituale.\nPossiamo includere riflessioni e pratiche interiori.');
});
bot.action('coach_goal', async (ctx) => {
  await sb.from('users').update({ coach: 'goal' }).eq('telegram_id', String(ctx.from.id));
  mem.set(ctx.chat.id, { ...(mem.get(ctx.chat.id) || {}), coach: 'goal' });
  await ctx.editMessageText('Modalità impostata: 🎯 Coach & Goal.\nLavoriamo su obiettivi, piani e piccoli passi.');
});

// --- Journal ---------------------------------------------------------------
bot.hears(['📓 Journal', 'Journal'], async (ctx) => {
  mem.set(ctx.chat.id, { ...(mem.get(ctx.chat.id) || {}), mode: 'journal_menu' });
  await ctx.reply(
    'Journal — vuoi scrivere o leggere?',
    Markup.inlineKeyboard([
      [Markup.button.callback('✍️ Scrivi', 'j_write')],
      [Markup.button.callback('📖 Leggi ultimi 10', 'j_read10')]
    ])
  );
});

bot.action('j_write', async (ctx) => {
  mem.set(ctx.chat.id, { ...(mem.get(ctx.chat.id) || {}), mode: 'journal_write' });
  await ctx.answerCbQuery();
  await ctx.reply('Scrivi la tua nota. Quando hai finito, invia il messaggio.');
});

bot.action('j_read10', async (ctx) => {
  await ctx.answerCbQuery();
  const { data, error } = await sb
    .from('journal')
    .select('id, text, created_at')
    .eq('telegram_id', String(ctx.from.id))
    .order('created_at', { ascending: false })
    .limit(10);
  if (error) {
    console.error('[journal read]', error);
    return ctx.reply('Non sono riuscita a leggere il diario.');
  }
  if (!data || !data.length) return ctx.reply('Il diario è vuoto.');
  const lines = data
    .map((e) => `#${e.id} — ${new Date(e.created_at).toLocaleString()}\n${e.text}`)
    .join('\n\n');
  await ctx.reply(lines.substring(0, 4000)); // Telegram message limit
});

// Handle free text for SOS and Journal write
bot.on('text', async (ctx, next) => {
  const state = mem.get(ctx.chat.id) || {};
  const text = (ctx.message?.text || '').trim();

  // Journal writing
  if (state.mode === 'journal_write' && text) {
    const { error } = await sb
      .from('journal')
      .insert({ telegram_id: String(ctx.from.id), text });
    if (error) {
      console.error('[journal insert]', error);
      await ctx.reply('Non sono riuscita a salvare. Riprova.');
    } else {
      await ctx.reply('Aggiunto al diario. ✅', HOME_KB());
      mem.set(ctx.chat.id, { ...state, mode: null });
    }
    return;
  }

  // SOS open question
  if (state.mode === 'sos_open' && text) {
    await ctx.reply("Grazie per avermelo detto. Vuoi che insieme troviamo un piccolo passo da fare adesso?");
    // rimaniamo in modalità conversazionale, non azzero per permettere follow-up
    return;
  }

  return next();
});

// --- Progress --------------------------------------------------------------
bot.hears(['📈 Progress', 'Progress'], async (ctx) => {
  try {
    const id = String(ctx.from.id);
    const { data, error } = await sb
      .from('users')
      .select('streak, wins')
      .eq('telegram_id', id)
      .single();
    if (error) throw error;
    await ctx.reply(`Streak: ${data?.streak ?? 0}\nWins: ${data?.wins ?? 0}`, Markup.inlineKeyboard([
      [Markup.button.callback('➕ Win', 'p_win'), Markup.button.callback('🔥 +Streak', 'p_streak')],
      [Markup.button.callback('🔁 Reset streak', 'p_reset')]
    ]));
  } catch (e) {
    console.error('[progress]', e);
    await ctx.reply('Non sono riuscita a leggere i progressi.');
  }
});

bot.action('p_win', async (ctx) => {
  await ctx.answerCbQuery('Win +1');
  await sb.rpc('increment_win', { p_tele_id: String(ctx.from.id) }).catch(() => {});
});
bot.action('p_streak', async (ctx) => {
  await ctx.answerCbQuery('Streak +1');
  await sb.rpc('increment_streak', { p_tele_id: String(ctx.from.id) }).catch(() => {});
});
bot.action('p_reset', async (ctx) => {
  await ctx.answerCbQuery('Streak reset');
  await sb.from('users').update({ streak: 0 }).eq('telegram_id', String(ctx.from.id));
});

// --- Fallback & errors ------------------------------------------------------
bot.catch((err, ctx) => {
  console.error('Bot error', err);
  if (ctx && ctx.reply) ctx.reply('Oops—something went wrong. Try again.');
});

// --- Launch (long polling) --------------------------------------------------
bot.launch().then(() => {
  console.log(`Boot OK. @${appName} (${versionTag})`);
});

// Graceful stop in Render
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

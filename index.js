// index.js  — EverGrace bot (CommonJS)

// 0) ENV & deps ---------------------------------------------------------------
require('dotenv').config();                       // locale; su Render usa panel
const http = require('http');                     // healthcheck
const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');

// Carica config prima da ./config.js se esiste, altrimenti da env
let CFG = {};
try { CFG = require('./config'); } catch (_) {
  CFG = {
    BOT_TOKEN: process.env.BOT_TOKEN,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_KEY: process.env.SUPABASE_KEY,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY
  };
}

if (!CFG.BOT_TOKEN) {
  console.error('[env] Missing BOT_TOKEN');
  process.exit(1);
}
if (!CFG.SUPABASE_URL || !CFG.SUPABASE_KEY) {
  console.error('[env] Missing SUPABASE_URL or SUPABASE_KEY');
  process.exit(1);
}

const bot = new Telegraf(CFG.BOT_TOKEN);
const supabase = createClient(CFG.SUPABASE_URL, CFG.SUPABASE_KEY);

let BOT_USERNAME = 'EverGraceBot'; // verrà aggiornato a runtime

// 1) Utils --------------------------------------------------------------------
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function zws() { return '\u200B'; } // zero-width space

function toYMD(date, tz = 'UTC') {
  const d = new Date(date);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(d).reduce((a, p) => (a[p.type] = p.value, a), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function daysBetween(a, b, tz = 'UTC') {
  const d1 = toYMD(a, tz);
  const d2 = toYMD(b, tz);
  const t1 = new Date(`${d1}T00:00:00Z`).getTime();
  const t2 = new Date(`${d2}T00:00:00Z`).getTime();
  return Math.round((t2 - t1) / 86400000);
}

// Legge/crea utente per telegram_id
async function getOrCreateUser(ctx) {
  const chatId = ctx.chat.id;
  const lang = ctx.from?.language_code || 'en';
  const name = [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || null;

  let { data: u, error } = await supabase
    .from('users')
    .select('id, language, name, chat_enabled, streak, streak_freezes, last_checkin, telegram_id')
    .eq('telegram_id', chatId)
    .maybeSingle();

  if (error) {
    console.error('[sb] get user error', error);
  }
  if (!u) {
    const { data: ins, error: insErr } = await supabase
      .from('users')
      .insert({
        telegram_id: chatId,
        language: lang,
        name,
        chat_enabled: true,
        streak: 0,
        streak_freezes: 0
      })
      .select()
      .single();

    if (insErr) console.error('[sb] insert user error', insErr);
    u = ins || null;
  }
  return u;
}

// 2) Static content -----------------------------------------------------------
const SPIRITUAL = {
  affirmations: [
    'I am held, guided, and safe in this moment.',
    'I choose gentleness with myself today.',
    'Clarity grows as I take the next small step.',
    'I release what I cannot carry and welcome peace.',
    'My worth is not measured by productivity.'
  ],
  breath: [
    'Inhale 4 • Hold 4 • Exhale 6 — repeat for 2 minutes.',
    'Box breathing: Inhale 4 • Hold 4 • Exhale 4 • Hold 4 — 10 rounds.',
    'Coherent breathing: Inhale 5 • Exhale 5 — 3 minutes.'
  ],
  prompts: [
    'What do I most need to hear from a wiser, kinder me?',
    'What am I ready to forgive (myself or others) today?',
    'What would lighten my load by 10% right now?',
    'If I listened to my quiet inner voice, what would it say?',
    'What small act of care would honor my values today?'
  ]
};

// 3) Menu “silenzioso” --------------------------------------------------------
function menuKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: '🏠 Menu' }, { text: '📓 Journal' }],
        [{ text: '🧭 Coach' }, { text: '🕊️ Spiritual' }],
        [{ text: '🔥 Streaks' }, { text: '📈 Progress' }],
        [{ text: '🆘 SOS' }, { text: '🔗 Invite' }]
      ],
      resize_keyboard: true,
      one_time_keyboard: false
    }
  };
}
async function showMenu(ctx) {
  // invia uno zero-width + tastiera e cancella il messaggio
  const m = await ctx.reply(zws(), menuKeyboard());
  setTimeout(() => ctx.deleteMessage(m.message_id).catch(() => {}), 150);
}

bot.hears(['🏠 Menu', 'Menu'], async (ctx) => showMenu(ctx));

// 4) Start / help / version ---------------------------------------------------
bot.start(async (ctx) => {
  await getOrCreateUser(ctx);
  await ctx.reply(
    `Hi ${ctx.from.first_name || ''}! I’m EverGrace.\n` +
    `I’m here for coaching, journaling, spiritual nudges, and SOS.\n\n` +
    `Use the keyboard below to begin.`
  );
  await showMenu(ctx);
});

bot.help(async (ctx) => {
  await ctx.reply(
    'Commands:\n' +
    '/start – welcome\n' +
    '/help – this help\n' +
    '/version – bot build\n' +
    'Or just use the keyboard.',
  );
});

bot.command('version', async (ctx) => {
  await ctx.reply(`EverGrace v-${new Date().toISOString().slice(0,10)}-MenuStreaks`);
});

// 5) SOS ----------------------------------------------------------------------
bot.hears(['🆘 SOS', 'SOS'], async (ctx) => {
  await ctx.reply(
    'SOS: how can I help right now?',
    {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('🧷 Crisis help', 'sos_crisis')],
        [Markup.button.callback('💬 Talk to me', 'sos_talk')],
        [Markup.button.callback('⬅️ Back', 'back_to_menu')]
      ])
    }
  );
  await ctx.reply(
    'If you are in immediate danger, call your local emergency number.\n' +
    '🇪🇺 EU: 112   🇺🇸/🇨🇦: 911\n' +
    '🇮🇹 Samaritans: 06 77208977\n' +
    '🌐 findahelpline.com'
  );
});

bot.action('sos_crisis', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    'If you are in immediate danger, call your local emergency number.\n' +
    '🇪🇺 112 • 🇺🇸/🇨🇦 911 • 🇮🇹 Samaritans 06 77208977\n' +
    '🌐 findahelpline.com'
  );
});
bot.action('sos_talk', async (ctx) => {
  await ctx.answerCbQuery('I’m listening…');
  await ctx.reply('Tell me—what’s happening? I’m here with you.');
});

// 6) Spiritual (ricco) --------------------------------------------------------
bot.hears(['🕊️ Spiritual', 'Spiritual'], async (ctx) => {
  await ctx.reply(
    'Choose the kind of spiritual nudge you want:',
    {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('🙏 Affirmation/Prayer', 'spirit_prayer')],
        [Markup.button.callback('🧘 Breath (2–3 min)', 'spirit_breath')],
        [Markup.button.callback('📖 Reflective prompt', 'spirit_prompt')],
        [Markup.button.callback('⬅️ Back', 'back_to_menu')]
      ])
    }
  );
});
bot.action('spirit_prayer', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(`🙏 ${pick(SPIRITUAL.affirmations)}`);
});
bot.action('spirit_breath', async (ctx) => {
  await ctx.answerCbQuery('Starting…');
  await ctx.reply(`🧘 ${pick(SPIRITUAL.breath)}\n\nSet a timer, then come tell me how you feel. 💛`);
});
bot.action('spirit_prompt', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(`📖 Reflect:\n“${pick(SPIRITUAL.prompts)}”\n\nOpen *Journal* when you’re ready.`, {
    parse_mode: 'Markdown'
  });
});

// 7) Streaks + Freeze ---------------------------------------------------------
bot.hears(['🔥 Streaks', 'Streaks'], async (ctx) => {
  const u = await getOrCreateUser(ctx);
  const s = u?.streak || 0;
  const f = u?.streak_freezes || 0;

  await ctx.reply(
    `🔥 Current streak: *${s} day${s === 1 ? '' : 's'}*\n❄️ Freeze tokens: *${f}*`,
    {
      parse_mode: 'Markdown',
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback('✅ Check-in today', 'streak_checkin')],
        [Markup.button.callback('❄️ What is a Freeze?', 'streak_freeze_info')],
        [Markup.button.callback('⬅️ Back', 'back_to_menu')]
      ])
    }
  );
});

bot.action('streak_freeze_info', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    'A ❄️ Freeze protects your streak if you miss a day.\n\n' +
    'If there’s a gap of >1 day since your last check-in and you have at least 1 Freeze, ' +
    'I’ll automatically consume one to keep your streak untouched.'
  );
});

bot.action('streak_checkin', async (ctx) => {
  await ctx.answerCbQuery('Checking in…');
  const chatId = ctx.chat.id;

  const { data: row, error: getErr } = await supabase
    .from('users')
    .select('streak, last_checkin, streak_freezes')
    .eq('telegram_id', chatId)
    .maybeSingle();

  if (getErr) {
    console.error('[streak] get error', getErr);
    return ctx.reply('Oops—could not read your streak. Try again.');
  }

  const now = new Date();
  const tz = 'UTC';
  let streak = row?.streak || 0;
  let freezes = row?.streak_freezes || 0;
  const last = row?.last_checkin ? new Date(row.last_checkin) : null;

  if (last && daysBetween(last, now, tz) === 0) {
    return ctx.reply('You already checked in today. See you tomorrow! ✨');
  }

  if (!last) {
    streak = 1;
  } else {
    const gap = daysBetween(last, now, tz);
    if (gap === 1) {
      streak += 1;
    } else if (gap > 1) {
      if (freezes > 0) {
        freezes -= 1;
        await ctx.reply('❄️ Missed days detected, used 1 Freeze to protect your streak.');
      } else {
        streak = 1;
      }
    }
  }

  const { error: upErr } = await supabase
    .from('users')
    .update({ streak, last_checkin: now.toISOString(), streak_freezes: freezes })
    .eq('telegram_id', chatId);

  if (upErr) {
    console.error('[streak] update error', upErr);
    return ctx.reply('Could not save your check-in, please try again.');
  }

  await ctx.reply(
    `Nice! 🔥 Streak is now *${streak}*` +
    (freezes >= 0 ? `\n❄️ Freezes left: *${freezes}*` : ''),
    { parse_mode: 'Markdown' }
  );
});

// 8) Journal / Progress / Coach (placeholder brevi) ---------------------------
bot.hears(['📓 Journal', 'Journal'], async (ctx) => {
  await ctx.reply(
    'Write here. I’ll save it. (Export coming soon)\n' +
    'Tip: start with “Today I feel…”',
    Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'back_to_menu')]])
  );
});

bot.hears(['📈 Progress', 'Progress'], async (ctx) => {
  await ctx.reply(
    'Progress overview coming soon: wins, streaks, trend lines.',
    Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'back_to_menu')]])
  );
});

bot.hears(['🧭 Coach', 'Coach'], async (ctx) => {
  await ctx.reply(
    'Choose your coach style:',
    Markup.inlineKeyboard([
      [Markup.button.callback('🤝 Friend vibe', 'coach_friend')],
      [Markup.button.callback('🎯 Goals coach', 'coach_goal')],
      [Markup.button.callback('🕊️ Spiritual guide', 'coach_spirit')],
      [Markup.button.callback('⬅️ Back', 'back_to_menu')]
    ])
  );
});
bot.action('coach_friend',  async (ctx) => { await ctx.answerCbQuery(); await ctx.reply('Friend vibe on. I’ll keep it warm and casual.'); });
bot.action('coach_goal',    async (ctx) => { await ctx.answerCbQuery(); await ctx.reply('Goals mode on. Short, focused steps.'); });
bot.action('coach_spirit',  async (ctx) => { await ctx.answerCbQuery(); await ctx.reply('Spiritual guidance on. Gentle nudges + reflection.'); });

// 9) Invite / Share -----------------------------------------------------------
bot.hears(['🔗 Invite', 'Invite'], async (ctx) => {
  const me = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}` : 'https://t.me';
  await ctx.reply(
    `Invite a friend to EverGrace:\n${me}`,
    Markup.inlineKeyboard([[Markup.button.url('Open EverGrace', me)]])
  );
});

// 10) Back to menu ------------------------------------------------------------
bot.action('back_to_menu', async (ctx) => {
  await ctx.answerCbQuery();
  await showMenu(ctx);
});

// 11) Launch & healthcheck ----------------------------------------------------
async function main() {
  try {
    const me = await bot.telegram.getMe();
    BOT_USERNAME = me.username || BOT_USERNAME;
    await bot.launch();
    console.log('Boot OK. @' + BOT_USERNAME);
  } catch (e) {
    console.error('Bot launch error:', e);
    process.exit(1);
  }
}

// tiny HTTP server for Render (keeps it happy)
http.createServer((_, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ok');
}).listen(process.env.PORT || 3000, () =>
  console.log('Healthcheck on :' + (process.env.PORT || 3000))
);

main();

// Graceful stop on Render
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

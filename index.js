// index.js — EverGrace bot (Render-ready)
// - Uses config.js for env
// - Healthcheck server (keeps Render happy)
// - Clean menu (with invite/share deep link)
// - Friendly SOS (“How can I help right now?” + helplines)
// - Coach modes (Goals / Life / Spiritual)
// - Journal write + list
// - Progress (streak/wins) basics
// - Conversation continuity via short rolling context
// - Defensive callback ACKs + error handler

const http = require('http');
const config = require('./config');
const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const OpenAI = require('openai');

const bot = new Telegraf(config.BOT_TOKEN);
const sb  = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE);
const ai  = new OpenAI({ apiKey: config.OPENAI_API_KEY });

// --- globals ---
let BOT_USERNAME = 'EverGraceBot';
const VERSION = 'v-2025-10-01-Menu+Coach+SOS';

// Small rolling context (in-memory) per chat to keep replies “warm”
const lastTurns = new Map(); // chatId -> [{role,text,ts}, ...]
const MAX_TURNS = 6;

// --- helpers ---
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function mainMenu() {
  return Markup.keyboard([
    ['🏠 Menu', '🧘 Coach', '📔 Journal'],
    ['📈 Progress', '🆘 SOS', '💬 Support'],
    ['🔗 Invite / Share']
  ]).resize();
}

function coachMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🎯 Goals Coach', 'coach_goals')],
    [Markup.button.callback('🧭 Life Coach', 'coach_life')],
    [Markup.button.callback('🕊️ Spiritual Guide', 'coach_spiritual')],
    [Markup.button.callback('⬅️ Back', 'back_home')]
  ]);
}

function sosFooterText(lang = 'it') {
  // Static footer with key numbers
  return (
    `\n\nIf you are in immediate danger, call your local emergency number.\n` +
    `🇮🇹 Samaritans: 06 77208977\n` +
    `🌐 findahelpline.com\n` +
    `🚨 Universal: 112 (EU) · 911 (US/CA)`
  );
}

function clampHistory(arr) {
  if (arr.length > MAX_TURNS) arr.splice(0, arr.length - MAX_TURNS);
  return arr;
}

// --- Supabase: users table helpers ---
async function sbGetOrCreateUser(telegramId, name, languageCode) {
  // upsert on telegram_id (bigint unique)
  const payload = {
    telegram_id: telegramId,
    name: name || null,
    language: (languageCode || 'en').slice(0,2),
  };

  const { data, error } = await sb
    .from('users')
    .upsert(payload, { onConflict: 'telegram_id' })
    .select('*')
    .single();

  if (error) {
    console.error('[sb] upsert error', error);
    throw error;
  }
  return data;
}

async function sbAppendDiary(telegramId, entry) {
  // read existing diary (jsonb array), append, write back
  const { data: user, error: e1 } = await sb
    .from('users')
    .select('diary')
    .eq('telegram_id', telegramId)
    .single();
  if (e1) throw e1;

  const list = Array.isArray(user?.diary) ? user.diary : [];
  list.push(entry);

  const { error: e2 } = await sb
    .from('users')
    .update({ diary: list, updated_at: new Date().toISOString() })
    .eq('telegram_id', telegramId);
  if (e2) throw e2;

  return list.length;
}

async function sbFetchDiary(telegramId, limit = 10) {
  const { data: user, error } = await sb
    .from('users')
    .select('diary')
    .eq('telegram_id', telegramId)
    .single();
  if (error) throw error;

  const list = Array.isArray(user?.diary) ? user.diary : [];
  return list.slice(-limit);
}

async function sbBumpStreak(telegramId, incWin = false) {
  const { data: user, error: rerr } = await sb
    .from('users')
    .select('streak,wins')
    .eq('telegram_id', telegramId)
    .single();
  if (rerr) throw rerr;

  const streak = (user?.streak ?? 0) + 1;
  const wins   = (user?.wins ?? 0) + (incWin ? 1 : 0);

  const { error: uerr } = await sb
    .from('users')
    .update({ streak, wins, updated_at: new Date().toISOString() })
    .eq('telegram_id', telegramId);

  if (uerr) throw uerr;
  return { streak, wins };
}

// --- onboarding / identity ---
bot.use(async (ctx, next) => {
  try {
    if (ctx.from && ctx.chat?.type === 'private') {
      await sbGetOrCreateUser(ctx.from.id, ctx.from.first_name, ctx.from.language_code);
    }
  } catch (e) {
    console.error('[init] user ensure failed', e);
  }
  return next();
});

// Discover bot username once
(async () => {
  try {
    const me = await bot.telegram.getMe();
    BOT_USERNAME = me.username || BOT_USERNAME;
    console.log('[boot] bot username @' + BOT_USERNAME);
  } catch (e) {
    console.error('[boot] getMe failed', e);
  }
})();

// --- /start & basic commands ---
bot.start(async (ctx) => {
  const name = ctx.from?.first_name || 'there';
  await ctx.reply(
    `Hi ${name}! I’m EverGrace — your personal companion.\n` +
    `Choose from the menu below to journal, track progress, pick a coach style, or ask for help anytime.`,
    mainMenu()
  );
});

bot.command('help', async (ctx) => {
  await ctx.reply(
    `What I can do:\n` +
    `• 🧘 Coach: pick Goals / Life / Spiritual\n` +
    `• 📔 Journal: write or review entries\n` +
    `• 📈 Progress: see streaks & wins\n` +
    `• 🆘 SOS: quick support when you need it\n` +
    `• 🔗 Invite / Share: share me with someone`,
    mainMenu()
  );
});

bot.command('version', (ctx) => ctx.reply(`EverGrace ${VERSION}`));

// --- menus (reply keyboard) ---
bot.hears(['🏠 Menu','Menu','menu','HOME','home'], (ctx) =>
  ctx.reply(`Here’s your menu:`, mainMenu())
);

bot.hears(['🧘 Coach', 'Coach'], async (ctx) => {
  await ctx.reply('Which style suits you best right now?', coachMenu());
});

bot.hears(['📔 Journal','Journal'], async (ctx) => {
  await ctx.reply(
    `Journal options:`,
    Markup.inlineKeyboard([
      [Markup.button.callback('✍️ Write a new entry', 'j_write')],
      [Markup.button.callback('📜 Show last 10 entries', 'j_list')],
      [Markup.button.callback('⬅️ Back', 'back_home')]
    ])
  );
});

bot.hears(['📈 Progress','Progress'], async (ctx) => {
  try {
    const { data: u, error } = await sb.from('users')
      .select('streak,wins')
      .eq('telegram_id', ctx.from.id)
      .single();
    if (error) throw error;

    await ctx.reply(`📈 Progress\nStreak: ${u?.streak ?? 0}\nWins: ${u?.wins ?? 0}`);
  } catch (e) {
    console.error('[progress]', e);
    await ctx.reply('Could not fetch your progress right now.');
  }
});

bot.hears(['🆘 SOS','SOS'], async (ctx) => {
  await ctx.reply(
    `SOS — how can I help right now?\n` +
    `Write a few words about what you need, and I’ll respond.`,
    mainMenu()
  );
  // mark chat so the very next user message is treated as SOS text
  ctx.session = ctx.session || {};
  ctx.session.waitingSOS = true;
});

bot.hears(['💬 Support','Support'], async (ctx) => {
  await ctx.reply(
    `You can type anything — I’ll do my best to help.\n` +
    `For urgent situations, use 🆘 SOS.`,
    mainMenu()
  );
});

bot.hears(['🔗 Invite / Share','Invite / Share'], async (ctx) => {
  const deep = `https://t.me/${BOT_USERNAME}?start=hi`;
  const shareText =
    `I’m using EverGrace — a gentle personal coach on Telegram. ` +
    `Try it: ${deep}`;
  await ctx.reply(shareText, mainMenu());
});

// --- coach mode callbacks ---
bot.action('coach_goals', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    `🎯 Goals Coach:\nTell me your goal in one sentence. Why does it matter to you?`
  );
});
bot.action('coach_life', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    `🧭 Life Coach:\nWhat’s on your mind right now? What would you like to feel or change?`
  );
});
bot.action('coach_spiritual', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    `🕊️ Spiritual Guide:\nWould you like a short reflection, a grounding practice, or a blessing?`
  );
});
bot.action('back_home', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Back to menu:', mainMenu());
});

// --- journal callbacks ---
bot.action('j_write', async (ctx) => {
  await ctx.answerCbQuery();
  ctx.session = ctx.session || {};
  ctx.session.waitingJournal = true;
  await ctx.reply('Okay — send me your entry (text). I’ll save it to your journal.');
});

bot.action('j_list', async (ctx) => {
  await ctx.answerCbQuery('Fetching your last entries…');
  try {
    const items = await sbFetchDiary(ctx.from.id, 10);
    if (!items.length) {
      await ctx.reply('Your journal is empty for now.');
      return;
    }
    const lines = items.map((e, i) => {
      const when = new Date(e.ts || Date.now()).toLocaleString();
      return `#${i + 1} — ${when}\n${e.text}`;
    }).join(`\n\n`);
    await ctx.reply(`📜 Last entries:\n\n${lines}`);
  } catch (e) {
    console.error('[journal list]', e);
    await ctx.reply('Sorry, I could not read your journal.');
  }
});

// --- text handler: SOS / Journal capture + general chat ---
bot.on('text', async (ctx) => {
  const text = (ctx.message?.text || '').trim();
  const chatId = ctx.chat.id;

  ctx.session = ctx.session || {};

  // SOS capture (one-shot)
  if (ctx.session.waitingSOS) {
    ctx.session.waitingSOS = false;

    // keep a short memory
    const turns = clampHistory(lastTurns.get(chatId) || []);
    turns.push({ role: 'user', text, ts: Date.now() });
    lastTurns.set(chatId, turns);

    await ctx.reply(
      `Thanks for telling me. I’m here with you.\n` +
      `Here are a couple of immediate ideas you might try:\n` +
      `• Breathe slowly — in for 4, out for 6 — for 60 seconds.\n` +
      `• Send a short “thinking of you” text to someone safe.\n` +
      `• Drink a glass of water.\n` +
      sosFooterText()
    );
    return;
  }

  // Journal capture
  if (ctx.session.waitingJournal) {
    ctx.session.waitingJournal = false;
    try {
      const count = await sbAppendDiary(ctx.from.id, { text, ts: new Date().toISOString() });
      await sbBumpStreak(ctx.from.id, true);
      await ctx.reply(`Saved to your journal. (Total entries: ${count})`);
    } catch (e) {
      console.error('[journal write]', e);
      await ctx.reply('Sorry, I could not save your entry.');
    }
    return;
  }

  // General conversation (short continuity)
  const turns = clampHistory(lastTurns.get(chatId) || []);
  turns.push({ role: 'user', text, ts: Date.now() });
  lastTurns.set(chatId, turns);

  // Keep the tone empathetic but light
  let prompt =
    `You are EverGrace, a kind, concise personal coach. ` +
    `Keep replies short and warm. Use natural language (no over-formality). ` +
    `User’s recent context:\n` +
    turns.map(t => `- ${t.role}: ${t.text}`).join('\n') +
    `\nReply to the latest user message.`;

  try {
    const completion = await ai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 250
    });
    const reply = completion.choices?.[0]?.message?.content?.trim() || 'Okay.';
    turns.push({ role: 'assistant', text: reply, ts: Date.now() });
    clampHistory(turns);
    lastTurns.set(chatId, turns);

    await ctx.reply(reply);
  } catch (e) {
    console.error('[openai]', e);
    await ctx.reply("Oops—something went wrong. Try again.");
  }
});

// --- errors & callback ACK guard ---
bot.on('callback_query', async (ctx) => {
  // If any callback sneaks through unhandled
  try { await ctx.answerCbQuery(); } catch {}
});

bot.catch((err, ctx) => {
  console.error('[telegraf error]', err, 'at', ctx.updateType);
});

// --- keep Render happy ---
http.createServer((_, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ok');
}).listen(config.PORT, () => {
  console.log(`[health] listening on :${config.PORT}`);
});

// --- start bot ---
(async () => {
  await bot.launch();
  console.log(`Boot OK. @${BOT_USERNAME}`);
})();

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

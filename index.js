// index.js — EverGrace (menu refresh + safe callbacks + invite/share)
// ---------------------------------------------------------------

import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import { createClient } from '@supabase/supabase-js';

// ---- env checks ------------------------------------------------
const {
  BOT_TOKEN,
  OPENAI_API_KEY,       // kept for future AI features
  SUPABASE_URL,
  SUPABASE_KEY
} = process.env;

function must(v, name) {
  if (!v || !v.trim()) {
    console.error(`[env] Missing ${name} in .env`);
    process.exit(1);
  }
}
must(BOT_TOKEN, 'BOT_TOKEN');
must(SUPABASE_URL, 'SUPABASE_URL');
must(SUPABASE_KEY, 'SUPABASE_KEY');

// ---- clients ---------------------------------------------------
const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 9_000 }); // < 10s
const sb  = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false }
});

console.log(`[sb] ready → ${SUPABASE_URL}`);
console.log('Boot OK.  @EverGraceRabeBot');

// ---- tiny healthcheck for Render ------------------------------
bot.command('healthz', async (ctx) => ctx.reply('ok'));

// ---- common helpers -------------------------------------------
function mainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [ Markup.button.callback('🏠 Home', 'go_home') ],
    [
      Markup.button.callback('🆘 SOS', 'go_sos'),
      Markup.button.callback('📓 Diary', 'go_diary')
    ],
    [
      Markup.button.callback('🎯 Goals', 'go_goals'),
      Markup.button.callback('📈 Progress', 'go_progress')
    ],
    [
      Markup.button.callback('👥 Invite', 'go_invite'),
      Markup.button.callback('⚙️ Help', 'go_help')
    ]
  ]);
}

async function showMenu(ctx, title = "Here’s your menu:") {
  return ctx.reply(title, mainMenuKeyboard());
}

// safely acknowledge any callback to avoid “Oops—something went wrong”
async function safeAck(ctx, text = null, alert = false) {
  try { await ctx.answerCbQuery(text || '', { show_alert: alert }); } catch {}
}

// global safety net: always ack callbacks even if a handler throws
bot.on('callback_query', async (ctx, next) => {
  try { await next(); }
  finally { await safeAck(ctx); }
});

// ---- Supabase: users (by telegram_id) --------------------------
async function getOrCreateUser(ctx) {
  const telegram_id = ctx.from?.id;
  if (!telegram_id) return null;

  // try get
  let { data: found, error: getErr } = await sb
    .from('users')
    .select('*')
    .eq('telegram_id', telegram_id)
    .maybeSingle();

  if (getErr && getErr.code !== 'PGRST116') {
    console.log('[sb] get error:', getErr);
  }
  if (found) return found;

  // create
  const insert = {
    telegram_id,
    language: ctx.from?.language_code || 'en',
    name: [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || null
  };

  const { data: created, error: insErr } = await sb
    .from('users')
    .insert(insert)
    .select('*')
    .single();

  if (insErr) {
    console.log('[sb] insert error:', insErr);
    return null;
  }
  return created;
}

// ---- Commands --------------------------------------------------
bot.start(async (ctx) => {
  await getOrCreateUser(ctx);
  await ctx.reply(
    `Hi ${ctx.from?.first_name || 'there'}! I’m EverGrace.\n` +
    `How can I help you today?`,
  );
  return showMenu(ctx);
});

bot.help(async (ctx) => {
  await ctx.reply(
    `Commands:\n` +
    `/menu – show main menu\n` +
    `/invite – share EverGrace with a friend\n` +
    `/version – current build\n` +
    `/healthz – service health check`
  );
});

bot.command('menu', async (ctx) => showMenu(ctx));
bot.command('version', async (ctx) =>
  ctx.reply(`EverGrace v-2025-09-30-DeepLinksMenu`)
);

// ✅ Invite without self deep-link button (prevents grey banner)
bot.command('invite', async (ctx) => {
  const openLink  = 'https://t.me/EverGraceRabeBot';
  const shareLink = 'https://t.me/share/url?url=' +
    encodeURIComponent(openLink) +
    '&text=' +
    encodeURIComponent("I’m using EverGrace. Try it!");
  const rows = [];

  // Only present the open-link button if not in a private chat
  if (ctx.chat?.type !== 'private') {
    rows.push([ Markup.button.url('Open EverGrace', openLink) ]);
  }
  rows.push([ Markup.button.url('Share EverGrace', shareLink) ]);

  await ctx.reply('Invite a friend:', Markup.inlineKeyboard(rows));
});

// ---- Menu actions ---------------------------------------------
bot.action('go_home', async (ctx) => {
  await safeAck(ctx);
  await ctx.reply('Welcome back. What do you need right now?');
  return showMenu(ctx, 'Here’s your menu:');
});

bot.action('go_help', async (ctx) => {
  await safeAck(ctx);
  return bot.telegram.sendMessage(ctx.chat.id,
    'Try these:\n' +
    '• 🆘 SOS for quick help.\n' +
    '• 📓 Diary to jot thoughts.\n' +
    '• 🎯 Goals to set or refine a goal.\n' +
    '• 👥 Invite to share EverGrace.',
  );
});

bot.action('go_invite', async (ctx) => {
  await safeAck(ctx);
  const openLink  = 'https://t.me/EverGraceRabeBot';
  const shareLink = 'https://t.me/share/url?url=' +
    encodeURIComponent(openLink) +
    '&text=' +
    encodeURIComponent("I’m using EverGrace. Try it!");
  const rows = [];
  if (ctx.chat?.type !== 'private') {
    rows.push([ Markup.button.url('Open EverGrace', openLink) ]);
  }
  rows.push([ Markup.button.url('Share EverGrace', shareLink) ]);
  return ctx.telegram.sendMessage(ctx.chat.id, 'One tap to invite:', Markup.inlineKeyboard(rows));
});

// SOS → open question first + resources under it
bot.action('go_sos', async (ctx) => {
  await safeAck(ctx);
  await ctx.reply(
    'SOS: how can I help right now?\n' +
    'Tell me in a sentence and I’ll tailor support.'
  );
  return ctx.reply(
    'If you are in immediate danger, call your local emergency number.\n' +
    '🇪🇺 112 • 🇺🇸 911\n' +
    '🇮🇹 Samaritans: 06 77208977\n' +
    '🌐 findahelpline.com'
  );
});

// Diary (placeholder – keeps current behaviour)
bot.action('go_diary', async (ctx) => {
  await safeAck(ctx);
  await getOrCreateUser(ctx);
  return ctx.reply('Diary is ready. Send a line to save it, or type /menu to go back.');
});

// Goals (placeholder)
bot.action('go_goals', async (ctx) => {
  await safeAck(ctx);
  await ctx.reply('Tell me your goal in one sentence. Why does it matter to you?');
});

// Progress (placeholder)
bot.action('go_progress', async (ctx) => {
  await safeAck(ctx);
  return ctx.reply('Progress coming up soon: streaks, wins, and trends.');
});

// ---- fallbacks -------------------------------------------------
bot.hears(/^menu$/i, async (ctx) => showMenu(ctx));
bot.on('message', async (ctx) => {
  // keep it friendly & lightweight for now
  await getOrCreateUser(ctx);
  // simple echo style fallback
  return ctx.reply('Got it. If you need the options again, type /menu.');
});

// ---- start with retry -----------------------------------------
async function startBotWithRetry(tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      await bot.launch();
      console.log('Grace bot started in long polling mode');
      return;
    } catch (err) {
      console.error(`[boot] error (attempt ${i}/${tries})`, err?.message || err);
      if (i === tries) process.exit(1);
      await new Promise(r => setTimeout(r, 2_000 * i));
    }
  }
}
startBotWithRetry().catch(() => {});

// graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

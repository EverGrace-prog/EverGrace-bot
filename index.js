// index.js — EverGrace (RABE) — deep-links + richer menu + all features

import 'dotenv/config';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { Telegraf, Markup } from 'telegraf';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';

const {
  BOT_TOKEN,
  OPENAI_API_KEY,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE,
  PORT = 10000,
} = process.env;

if (!BOT_TOKEN) throw new Error('Missing BOT_TOKEN');
if (!OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY');
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) throw new Error('Missing SUPABASE config');

const APP_VERSION = 'v-2025-09-30-DeepLinksMenu';

const bot = new Telegraf(BOT_TOKEN);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

const log  = (...a) => console.log('[bot]', ...a);
const warn = (...a) => console.warn('[warn]', ...a);
const err  = (...a) => console.error('[err ]', ...a);

// ── Healthcheck so Render stays happy
http.createServer((_, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK\n');
}).listen(PORT, () => log(`Healthcheck :${PORT}`));

// ── Bottom bar (now includes Diary/Progress row + Chat toggle)
const mainBar = (chatEnabled = true) => {
  const toggle = chatEnabled ? '🤫 Chat OFF' : '💬 Chat ON';
  return Markup.keyboard([
    ['🏠 Menu', '🆘 SOS', '🔷 Support'],
    ['📓 Diary', '📈 Progress', toggle],
  ]).resize().persistent();
};

// Inline menus
const menuInline = Markup.inlineKeyboard([
  [Markup.button.callback('🧭 Coach Mode', 'menu_coach'),
   Markup.button.callback('🌍 Language', 'menu_lang')],
  [Markup.button.callback('📓 Diary: New', 'diary_new'),
   Markup.button.callback('📚 Diary: Browse', 'diary_browse')],
  [Markup.button.callback('📜 Rabe Page: New', 'rabe_new'),
   Markup.button.callback('📖 Rabe Page: Browse', 'rabe_browse')],
  [Markup.button.callback('✅ Check-in', 'checkin'),
   Markup.button.callback('📈 Progress', 'progress')],
  [Markup.button.callback('⬆️ Upgrade (Plus soon)', 'upgrade')],
]);

const langInline = Markup.inlineKeyboard([
  [Markup.button.callback('English', 'lang_en'), Markup.button.callback('Italiano', 'lang_it')],
  [Markup.button.callback('Deutsch', 'lang_de')],
  [Markup.button.callback('⬅️ Back', 'back_menu')],
]);

const coachInline = Markup.inlineKeyboard([
  [Markup.button.callback('🤝 Friend', 'coach_friend')],
  [Markup.button.callback('✨ Spiritual Guide', 'coach_spiritual')],
  [Markup.button.callback('🎯 Goals Coach', 'coach_goals')],
  [Markup.button.callback('⬅️ Back', 'back_menu')],
]);

const supportInline = Markup.inlineKeyboard([
  [Markup.button.url('💎 Diamond — €9', 'https://buy.stripe.com/test_7SyCN52SX1S029906kbwk04')],
  [Markup.button.url('🥇 Gold — €5',    'https://buy.stripe.com/test_00waEX1OT8go0117yMbwk05')],
  [Markup.button.url('🥈 Silver — €2',  'https://buy.stripe.com/test_cNiflZh3X154c1551aobwk06')],
  [Markup.button.callback('⬅️ Back', 'back_menu')],
]);

// Brand card
const BRAND_CARD = path.join(process.cwd(), 'rabe_bg.jpg');
async function sendBrandCard(ctx) {
  try { if (fs.existsSync(BRAND_CARD)) await ctx.replyWithPhoto({ source: BRAND_CARD }); } catch {}
}

// ── Supabase helpers
async function getOrCreateUser(ctx) {
  const tgId = Number(ctx.chat.id);
  const name = (ctx.from?.first_name || 'Friend') + (ctx.from?.last_name ? ` ${ctx.from.last_name}` : '');
  const preferLang =
    ctx.from?.language_code?.startsWith('it') ? 'it' :
    ctx.from?.language_code?.startsWith('de') ? 'de' : 'en';

  let { data, error } = await sb.from('users').select('*').eq('telegram_id', tgId).maybeSingle();
  if (error && error.code !== 'PGRST116') warn('[sb] get error', error);

  if (!data) {
    const payload = {
      telegram_id: tgId,
      name,
      language: preferLang,
      coach_mode: 'friend',
      chat_enabled: true,
      goal: null,
      goal_why: null,
      history: [],
      summary: '',
      diary: [],
      rabe_entries: [],
      wins: 0,
      streak: 0,
      last_win_date: null,
      plan: 'basic',
    };
    const ins = await sb.from('users').insert(payload).select().single();
    if (ins.error) { err('[sb] insert error', ins.error); throw new Error('storage insert'); }
    data = ins.data;
  }
  await sb.from('users').update({ last_seen_at: new Date().toISOString() }).eq('id', data.id);
  return data;
}
async function updateUser(id, patch) {
  patch.updated_at = new Date().toISOString();
  const res = await sb.from('users').update(patch).eq('id', id).select().single();
  if (res.error) err('[sb] update error', res.error);
  return res.data || null;
}
const clampHistory = (arr = []) => (arr || []).slice(-24);
async function addToHistory(u, role, text) {
  const history = clampHistory([...(u.history || []), { role, text, ts: Date.now() }]);
  await updateUser(u.id, { history });
}
const isoDate = (d = new Date()) => d.toISOString().slice(0,10);

// ── AI helpers
function coachSystem(coach, goal, why, summary) {
  const intro =
    coach === 'spiritual'
      ? 'You are a gentle spiritual guide. Reflective, kind, brief.'
      : coach === 'goals'
      ? 'You are a pragmatic goals coach. Clear, actionable, brief.'
      : 'You are a warm friend. Empathetic, human, brief.';
  const g = goal ? `Current goal: ${goal}.` : '';
  const w = why ? `Why it matters: ${why}.` : '';
  const mem = summary ? `Known context: ${summary}` : 'Known context: (none yet)';
  return `${intro} ${g} ${w} Keep messages concise and natural.\n${mem}`;
}
async function askModel(messages) {
  const ask = async (model) => openai.chat.completions.create({ model, messages, temperature: 0.6 });
  try { const r = await ask('gpt-4o-mini'); return r.choices?.[0]?.message?.content?.trim() || '…'; }
  catch { const r2 = await ask('gpt-4o'); return r2.choices?.[0]?.message?.content?.trim() || '…'; }
}
async function chatReply(u, userText) {
  const sys = coachSystem(u.coach_mode, u.goal, u.goal_why, u.summary);
  const recent = (u.history || []).slice(-8).map(t => ({ role: t.role === 'assistant' ? 'assistant' : 'user', content: t.text }));
  const messages = [{ role: 'system', content: sys }, ...recent, { role: 'user', content: userText }];
  return await askModel(messages);
}
async function shortSOS(userText) {
  const messages = [
    { role: 'system', content: 'You are EverGrace in SOS mode. Give 3 short, practical steps. Be calm and kind.' },
    { role: 'user', content: userText },
  ];
  return await askModel(messages);
}

// ── Deep-link router
async function handleStartPayload(ctx, u, payload) {
  // payload examples: lang_en, diary, sos, coach_friend, coach_spiritual, coach_goals
  if (!payload) return;

  switch (payload) {
    case 'lang_en': await updateUser(u.id, { language: 'en' }); await ctx.reply('Language set to English.'); break;
    case 'lang_it': await updateUser(u.id, { language: 'it' }); await ctx.reply('Lingua impostata su Italiano.'); break;
    case 'lang_de': await updateUser(u.id, { language: 'de' }); await ctx.reply('Sprache auf Deutsch eingestellt.'); break;

    case 'coach_friend':    await updateUser(u.id, { coach_mode: 'friend' });    await ctx.reply('Coach mode: 🤝 Friend.'); break;
    case 'coach_spiritual': await updateUser(u.id, { coach_mode: 'spiritual' }); await ctx.reply('Coach mode: ✨ Spiritual Guide.'); break;
    case 'coach_goals':     await updateUser(u.id, { coach_mode: 'goals' });     await ctx.reply('Coach mode: 🎯 Goals Coach.'); break;

    case 'diary': await ctx.reply('Send your diary note and I’ll save it.'); await updateUser(u.id, { diary_waiting: true, rabe_waiting: false }); await sendBrandCard(ctx); break;
    case 'sos':   await handleSOSStart(ctx, u); break;

    default: /* ignore unknown */ break;
  }
}

// ── Onboarding & commands
bot.start(async (ctx) => {
  const u = await getOrCreateUser(ctx);
  const hi = u.language === 'it'
    ? `Ciao ${u.name}! Sono EverGrace. Come posso aiutarti oggi?`
    : u.language === 'de'
    ? `Hallo ${u.name}! Ich bin EverGrace. Wie kann ich dir heute helfen?`
    : `Hi ${u.name}! I’m EverGrace. How can I help you today?`;

  await ctx.reply(hi, mainBar(u.chat_enabled));
  await ctx.reply('Open Menu for coach, diary, progress and more.', menuInline);

  // deep-link payload
  const payload = ctx.startPayload; // e.g. "lang_en"
  if (payload) await handleStartPayload(ctx, u, payload);
});

bot.command('help', async (ctx) => {
  await ctx.reply(
    'I can chat, coach and keep a diary.\n\n' +
    '• 🆘 SOS – “How can I help right now?”\n' +
    '• ✅ Check-in – tiny steps toward your goal\n' +
    '• 📓 Diary – write/browse your entries\n' +
    '• 📈 Progress – streaks & wins\n' +
    '• 🧭 Coach Mode – Friend / Spiritual / Goals',
    mainBar(true)
  );
});
bot.command('version', (ctx) => ctx.reply(`EverGrace ${APP_VERSION}`));
bot.command('menu', (ctx) => ctx.reply('Menu', menuInline));
bot.command('chaton',  async (ctx) => { const u = await getOrCreateUser(ctx); if (!u.chat_enabled) await updateUser(u.id,{chat_enabled:true});  await ctx.reply('Chat ON ✅',  mainBar(true)); });
bot.command('chatoff', async (ctx) => { const u = await getOrCreateUser(ctx); if ( u.chat_enabled) await updateUser(u.id,{chat_enabled:false}); await ctx.reply('Chat OFF 🤫', mainBar(false)); });

// Bottom bar quick handlers
bot.hears('🏠 Menu',   async (ctx) => { await getOrCreateUser(ctx); await ctx.reply('Here’s your menu:', menuInline); });
bot.hears('🆘 SOS',    async (ctx) => { const u = await getOrCreateUser(ctx); await handleSOSStart(ctx, u); });
bot.hears('🔷 Support',async (ctx) => { await ctx.reply('Thank you for supporting EverGrace 💛', supportInline); });
bot.hears('📓 Diary',  async (ctx) => {
  await ctx.reply('Diary', Markup.inlineKeyboard([
    [Markup.button.callback('📓 New', 'diary_new'), Markup.button.callback('📚 Browse', 'diary_browse')],
  ]));
});
bot.hears('📈 Progress', async (ctx) => {
  await ctx.reply('Progress', Markup.inlineKeyboard([
    [Markup.button.callback('✅ Check-in', 'checkin'), Markup.button.callback('📈 View', 'progress')],
  ]));
});
bot.hears('💬 Chat ON', async (ctx) => { const u = await getOrCreateUser(ctx); await updateUser(u.id,{chat_enabled:true});  await ctx.reply('Chat ON ✅',  mainBar(true));  });
bot.hears('🤫 Chat OFF',async (ctx) => { const u = await getOrCreateUser(ctx); await updateUser(u.id,{chat_enabled:false}); await ctx.reply('Chat OFF 🤫', mainBar(false)); });

// Inline menus
bot.action('back_menu',  (ctx) => ctx.editMessageText('Menu', menuInline));
bot.action('menu_lang',  (ctx) => ctx.editMessageText('Choose your language:', langInline));
bot.action('menu_coach', (ctx) => ctx.editMessageText('Choose your coach style:', coachInline));

bot.action('lang_en', async (ctx) => { const u = await getOrCreateUser(ctx); await updateUser(u.id,{language:'en'}); await ctx.answerCbQuery('Language: English'); await ctx.editMessageText('Language set to English.'); });
bot.action('lang_it', async (ctx) => { const u = await getOrCreateUser(ctx); await updateUser(u.id,{language:'it'}); await ctx.answerCbQuery('Lingua: Italiano'); await ctx.editMessageText('Lingua impostata su Italiano.'); });
bot.action('lang_de', async (ctx) => { const u = await getOrCreateUser(ctx); await updateUser(u.id,{language:'de'}); await ctx.answerCbQuery('Sprache: Deutsch'); await ctx.editMessageText('Sprache auf Deutsch eingestellt.'); });

bot.action('coach_friend',    async (ctx) => { const u = await getOrCreateUser(ctx); await updateUser(u.id,{coach_mode:'friend'});    await ctx.answerCbQuery('Coach: Friend');    await ctx.editMessageText('Coach mode: 🤝 Friend.'); });
bot.action('coach_spiritual', async (ctx) => { const u = await getOrCreateUser(ctx); await updateUser(u.id,{coach_mode:'spiritual'}); await ctx.answerCbQuery('Coach: Spiritual'); await ctx.editMessageText('Coach mode: ✨ Spiritual Guide.'); });
bot.action('coach_goals',     async (ctx) => { const u = await getOrCreateUser(ctx); await updateUser(u.id,{coach_mode:'goals'});     await ctx.answerCbQuery('Coach: Goals');     await ctx.editMessageText('Coach mode: 🎯 Goals Coach.'); });

// Diary & Rabe Page
bot.action('diary_new', async (ctx) => {
  const u = await getOrCreateUser(ctx);
  await ctx.answerCbQuery();
  await ctx.reply('Send your diary note. I’ll save it with today’s date.');
  await updateUser(u.id, { diary_waiting: true, rabe_waiting: false });
  await sendBrandCard(ctx);
});
bot.action('diary_browse', async (ctx) => {
  const u = await getOrCreateUser(ctx);
  await ctx.answerCbQuery();
  const list = (u.diary || []).slice(-20);
  if (!list.length) return ctx.reply('Diary is empty.');
  const out = list.map(e => `• ${new Date(e.ts).toISOString().slice(0,10)} — ${e.text}`).join('\n');
  await ctx.reply(out);
});

bot.action('rabe_new', async (ctx) => {
  const u = await getOrCreateUser(ctx);
  await ctx.answerCbQuery();
  await ctx.reply('Write on the Rabe page. I’ll save it separately.');
  await updateUser(u.id, { rabe_waiting: true, diary_waiting: false });
  await sendBrandCard(ctx);
});
bot.action('rabe_browse', async (ctx) => {
  const u = await getOrCreateUser(ctx);
  await ctx.answerCbQuery();
  const list = (u.rabe_entries || []).slice(-20);
  if (!list.length) return ctx.reply('No Rabe entries yet.');
  const out = list.map(e => `• ${new Date(e.ts).toISOString().slice(0,10)} — ${e.text}`).join('\n');
  await ctx.reply(out);
});

// Check-in / Progress
const SAMPLE_STEPS = [
  'Breathe slowly for 60 seconds.',
  'Write one sentence about how you feel.',
  'Drink a glass of water.',
  'Take a 3-minute stretch.',
  'Send a kind message to yourself.',
  'Tidy a small space for 2 minutes.',
  'Step outside for a minute of fresh air.',
];
function threeSteps() {
  const pool = [...SAMPLE_STEPS];
  const pick = () => pool.splice(Math.floor(Math.random()*pool.length),1)[0];
  return [pick(), pick(), pick()];
}
bot.action('checkin', async (ctx) => {
  const u = await getOrCreateUser(ctx);
  const steps = threeSteps();
  await updateUser(u.id, { todays_steps: steps });
  await ctx.answerCbQuery();
  await ctx.reply(
    `Tiny steps for today:\n1) ${steps[0]}\n2) ${steps[1]}\n3) ${steps[2]}\n\nTap ✅ Done when you complete one.`,
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ Done', 'done_one'),
       Markup.button.callback('🔁 New ideas', 'checkin')],
      [Markup.button.callback('✏️ Change goal', 'menu_goal')],
    ])
  );
});
function nextStreak(prevDateISO) {
  const today = isoDate(new Date());
  if (!prevDateISO) return { newStreak: 1, newLast: today };
  const prev = isoDate(new Date(prevDateISO));
  const dToday = new Date(today), dPrev = new Date(prev);
  const diffDays = Math.round((dToday - dPrev) / (24*3600*1000));
  if (diffDays === 0) return { sameDay: true, newLast: prev };
  if (diffDays === 1) return { inc: true, newLast: today };
  return { reset: true, newStreak: 1, newLast: today };
}
bot.action('done_one', async (ctx) => {
  const u = await getOrCreateUser(ctx);
  const info = nextStreak(u.last_win_date);
  let wins = (u.wins || 0) + 1;
  let streak = u.streak || 0;
  if (info.sameDay) { /* keep streak */ }
  else if (info.inc) streak += 1;
  else if (info.reset) streak = 1;
  else if (info.newStreak) streak = info.newStreak;
  await updateUser(u.id, { wins, streak, last_win_date: info.newLast });
  await ctx.answerCbQuery('Logged ✅');
  await ctx.reply(`Nice! Wins: ${wins} • Streak: ${streak} 🔥`);
});
bot.action('progress', async (ctx) => {
  const u = await getOrCreateUser(ctx);
  await ctx.answerCbQuery();
  const msg =
    `📈 Progress\nWins: ${u.wins || 0}\nStreak: ${u.streak || 0}\n` +
    (u.goal ? `Goal: ${u.goal}\n` : '') +
    (u.goal_why ? `Why: ${u.goal_why}\n` : '');
  await ctx.reply(msg);
});
bot.action('menu_goal', async (ctx) => {
  const u = await getOrCreateUser(ctx);
  await ctx.answerCbQuery();
  await ctx.reply(u.goal ? `Current goal: “${u.goal}”. Send a new one to change it.\nWhy does it matter?`
                         : 'Tell me your goal in one sentence.\nWhy does it matter to you?');
});

// SOS
const SOS_STATE = new Map();
function crisisFooter() {
  return `\n\nIf you’re in immediate danger, call your local emergency number.\n` +
         `🇪🇺 112 • 🇺🇸 911\n` +
         `🇮🇹 Samaritans: 06 77208977\n` +
         `🌐 findahelpline.com`;
}
async function handleSOSStart(ctx/*, u*/) {
  SOS_STATE.set(ctx.chat.id, true);
  await ctx.reply('🆘 How can I help right now?' + crisisFooter());
}

// Main text
bot.on('text', async (ctx) => {
  try {
    const u = await getOrCreateUser(ctx);
    const text = ctx.message.text?.trim() || '';

    if (u.diary_waiting) {
      const entry = { ts: Date.now(), text };
      await updateUser(u.id, { diary: [...(u.diary||[]), entry], diary_waiting: false });
      await ctx.reply('Saved in your diary 📓', mainBar(u.chat_enabled));
      return;
    }
    if (u.rabe_waiting) {
      const entry = { ts: Date.now(), text };
      await updateUser(u.id, { rabe_entries: [...(u.rabe_entries||[]), entry], rabe_waiting: false });
      await ctx.reply('Saved on the Rabe page 📜', mainBar(u.chat_enabled));
      return;
    }
    if (SOS_STATE.get(ctx.chat.id)) {
      SOS_STATE.delete(ctx.chat.id);
      const reply = await shortSOS(text);
      await ctx.reply(reply);
      await addToHistory(u, 'user', `[SOS] ${text}`);
      await addToHistory(u, 'assistant', reply);
      return;
    }

    if (/^goal[:\- ]/i.test(text)) {
      const newGoal = text.replace(/^goal[:\- ]/i, '').trim();
      if (newGoal) { await updateUser(u.id, { goal: newGoal }); await ctx.reply(`Goal updated: “${newGoal}”. Why is this important to you?`); return; }
    } else if (/^why[:\- ]/i.test(text)) {
      const why = text.replace(/^why[:\- ]/i, '').trim();
      if (why) { await updateUser(u.id, { goal_why: why }); await ctx.reply('Got it — that matters. Want a ✅ Check-in? Tap Menu → Check-in.'); return; }
    }

    if (!u.chat_enabled) {
      await ctx.reply('Chat is OFF 🤫 — toggle it from the bottom bar.');
      return;
    }

    await addToHistory(u, 'user', text);
    const answer = await chatReply(u, text);
    await ctx.reply(answer, mainBar(true));
    await addToHistory(u, 'assistant', answer);
  } catch (e) {
    err('text handler', e);
    await ctx.reply('Oops—something went wrong. Try again.');
  }
});

// Upgrade placeholder
bot.action('upgrade', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    'Plus is coming soon. You’ll get longer memory, richer media, and priority replies. 💫',
    Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'back_menu')]])
  );
});

// Boot
async function start() {
  await bot.launch();
  const me = await bot.telegram.getMe();
  log(`Boot OK. @${me.username} live. ${APP_VERSION}`);
}
start().catch((e) => { err('fatal boot', e); process.exit(1); });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

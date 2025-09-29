// index.js — EverGrace (conflict-free)

// ─── Imports & setup ───────────────────────────────────────────────────────────
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Telegraf, Markup } from 'telegraf';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ENV checks
const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

if (!BOT_TOKEN) throw new Error('Missing BOT_TOKEN in .env');
if (!OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY in .env');
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE in .env');
}

// Clients
const bot = new Telegraf(BOT_TOKEN);
const ai  = new OpenAI({ apiKey: OPENAI_API_KEY });
const sb  = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

// ─── Constants ─────────────────────────────────────────────────────────────────
const BRAND_CARD = path.join(__dirname, 'rabe_bg.jpg');   // optional; ignore if missing

const SUPPORT_LINKS = {
  diamond: { price: '€9', url: 'https://buy.stripe.com/test_7sYcN52SX1S029906kbwk04' },
  gold:    { price: '€5', url: 'https://buy.stripe.com/test_00waEX1OT8go0117yMbwk05' },
  silver:  { price: '€2', url: 'https://buy.stripe.com/test_cNIfZh3X154c1551aobwk06' },
};

const LANGUAGES = {
  en: 'English',
  it: 'Italiano',
  de: 'Deutsch',
};

// ─── UI helpers ────────────────────────────────────────────────────────────────
const bottomBar = () =>
  Markup.keyboard([
    [Markup.button.text('🏠 Menu'), Markup.button.text('🆘 SOS'), Markup.button.text('💎 Support')]
  ]).resize().persistent();

const menuKeyboard = () =>
  Markup.keyboard([
    [Markup.button.text('🌐 Language'), Markup.button.text('🎯 Goal')],
    [Markup.button.text('💬 Chat ON'), Markup.button.text('🤫 Chat OFF')],
    [Markup.button.text('📓 Diary'), Markup.button.text('📈 Progress')],
    [Markup.button.text('🏠 Menu'), Markup.button.text('🆘 SOS'), Markup.button.text('💎 Support')]
  ]).resize().persistent();

const langKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback(LANGUAGES.en, 'lang_en')],
    [Markup.button.callback(LANGUAGES.it, 'lang_it')],
    [Markup.button.callback(LANGUAGES.de, 'lang_de')],
  ]);

const supportKeyboard = () =>
  Markup.inlineKeyboard([
    [Markup.button.url(`💎 Diamond (${SUPPORT_LINKS.diamond.price})`, SUPPORT_LINKS.diamond.url)],
    [Markup.button.url(`🥇 Gold (${SUPPORT_LINKS.gold.price})`, SUPPORT_LINKS.gold.url)],
    [Markup.button.url(`🥈 Silver (${SUPPORT_LINKS.silver.price})`, SUPPORT_LINKS.silver.url)],
  ]);

// ─── Supabase: users table helpers ─────────────────────────────────────────────
async function getOrCreateUser(ctx) {
  const chatId = String(ctx.chat.id);
  const name   = ctx.from?.first_name || 'Friend';

  // try get
  let { data, error } = await sb.from('users').select('*').eq('telegram_id', chatId).maybeSingle();
  if (error && error.code !== 'PGRST116') console.log('[sb] get error', error);

  // create if missing
  if (!data) {
    const payload = {
      telegram_id: chatId,
      language: 'en',
      name,
      goal: null,
      goal_why: null,
      chat_enabled: true,
      streak: 0,
      wins: 0,
      notes: [],
      diary: [],
      history: [],
    };
    const ins = await sb.from('users').insert(payload).select('*').single();
    if (ins.error) { console.log('[sb] insert error', ins.error); throw ins.error; }
    data = ins.data;
  }
  return data;
}

async function updateUser(chatId, patch) {
  const { error, data } = await sb
    .from('users')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('telegram_id', String(chatId))
    .select('*')
    .single();
  if (error) { console.log('[sb] update error', error); throw error; }
  return data;
}

// ─── AI chat helper ───────────────────────────────────────────────────────────
async function askAI(history, prompt) {
  // history: [{role:'system'|'user'|'assistant', content:'...'}]
  const messages = [
    {
      role: 'system',
      content:
        "You are EverGrace, a warm, non-judgmental companion. Keep replies short, supportive, and conversational. Use user's language if known (en/it/de).",
    },
    ...history,
    { role: 'user', content: prompt },
  ];

  // try mini then fallback
  const tryModels = ['gpt-4o-mini', 'gpt-4o'];
  let output = 'I’m here.';
  for (const model of tryModels) {
    try {
      const res = await ai.chat.completions.create({ model, messages, temperature: 0.6 });
      output = res.choices?.[0]?.message?.content?.trim() || output;
      break;
    } catch (e) {
      console.log(`[ai] ${model} error`, e?.status || e?.message);
      continue;
    }
  }
  return output;
}

// ─── Brand card (optional) ────────────────────────────────────────────────────
async function sendBrandCard(ctx) {
  try {
    if (fs.existsSync(BRAND_CARD)) {
      await ctx.replyWithPhoto({ source: BRAND_CARD });
    }
  } catch {}
}

// ─── Flow helpers ─────────────────────────────────────────────────────────────
async function showMenu(ctx) {
  await ctx.reply('Here’s your menu:', menuKeyboard());
}

async function showSupport(ctx) {
  await ctx.reply('If you’d like to support EverGrace ❤️ choose a tier:', supportKeyboard());
}

async function showLanguages(ctx) {
  await ctx.reply('Choose your language:', langKeyboard());
}

async function handleSOS(ctx) {
  await ctx.reply(
    "SOS received. How can I help right now?\n\n" +
    "If you are in immediate danger, call your local emergency number.\n" +
    "🇮🇹 Samaritans: 06 77208977\n" +
    "🌐 findahelpline.com\n" +
    "Emergency numbers: 112 (EU) • 911 (US/CA)",
    bottomBar()
  );
}

// ─── Bot handlers ─────────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  const u = await getOrCreateUser(ctx);
  await ctx.reply(`Hi ${u.name}! I’m EverGrace. How can I help you today?`, bottomBar());
  await showMenu(ctx);
});

bot.hears('🏠 Menu', async (ctx) => {
  await getOrCreateUser(ctx);
  await showMenu(ctx);
});

bot.hears('💎 Support', async (ctx) => {
  await getOrCreateUser(ctx);
  await showSupport(ctx);
});

bot.hears('🆘 SOS', async (ctx) => {
  await getOrCreateUser(ctx);
  await handleSOS(ctx);
});

bot.hears('🌐 Language', async (ctx) => {
  await getOrCreateUser(ctx);
  await showLanguages(ctx);
});

bot.action(/lang_(en|it|de)/, async (ctx) => {
  const lang = ctx.match[1];
  await updateUser(ctx.chat.id, { language: lang });
  await ctx.answerCbQuery('Language updated ✅');
  await ctx.reply(`Language set to ${LANGUAGES[lang]}.`, bottomBar());
});

bot.hears('🎯 Goal', async (ctx) => {
  const u = await getOrCreateUser(ctx);
  await ctx.reply(u.goal ? `Your current goal is: “${u.goal}”. Send a new one to change it.` :
    'Tell me your goal in one sentence.');
});

bot.hears('💬 Chat ON', async (ctx) => {
  await updateUser(ctx.chat.id, { chat_enabled: true });
  await ctx.reply('Conversation mode is ON. Talk to me freely.', bottomBar());
});

bot.hears('🤫 Chat OFF', async (ctx) => {
  await updateUser(ctx.chat.id, { chat_enabled: false });
  await ctx.reply("It seems like you'd like a quiet moment. I’m here when you need me.", bottomBar());
});

bot.hears('📓 Diary', async (ctx) => {
  const u = await getOrCreateUser(ctx);
  await sendBrandCard(ctx); // optional, once per open; keeping simple
  await ctx.reply('Send me a diary entry (it will be saved privately). Use /browse to read recent entries.');
});

bot.command('browse', async (ctx) => {
  const ures = await sb.from('users').select('diary').eq('telegram_id', String(ctx.chat.id)).single();
  const diary = ures.data?.diary || [];
  if (!diary.length) return ctx.reply('Diary is empty.');
  const last = diary.slice(-5).map(e => `• ${new Date(e.ts).toISOString().slice(0,10)} — ${e.text}`).join('\n');
  await ctx.reply(last);
});

bot.hears('📈 Progress', async (ctx) => {
  const u = await getOrCreateUser(ctx);
  await ctx.reply(
    `Streak: ${u.streak}  | Wins: ${u.wins}\n` +
    (u.goal ? `Goal: ${u.goal}\n` : '') +
    `Use 🎯 Goal to update goal, or tell me what you did today to log a win.`
  );
});

// free text
bot.on('text', async (ctx) => {
  const u = await getOrCreateUser(ctx);
  const text = ctx.message.text?.trim();

  // goal change heuristics
  if (/^goal[:\- ]/i.test(text)) {
    const newGoal = text.replace(/^goal[:\- ]/i, '').trim();
    if (newGoal.length) {
      await updateUser(ctx.chat.id, { goal: newGoal });
      await ctx.reply(`Goal updated: “${newGoal}”. Why is this important to you?`);
      return;
    }
  }

  // diary shortcut
  if (/^diary[:\- ]/i.test(text)) {
    const entry = text.replace(/^diary[:\- ]/i, '').trim();
    if (entry.length) {
      const { data, error } = await sb.rpc('append_diary', {
        p_telegram_id: String(ctx.chat.id),
        p_text: entry
      });
      if (error) {
        // fallback if RPC not installed: manual append
        await updateUser(ctx.chat.id, { diary: [...(u.diary||[]), { ts: new Date().toISOString(), text: entry }] });
      }
      await ctx.reply('Saved in your diary 📝');
      return;
    }
  }

  // chat disabled? store to diary instead
  if (!u.chat_enabled) {
    await updateUser(ctx.chat.id, { diary: [...(u.diary||[]), { ts: new Date().toISOString(), text }] });
    await ctx.reply('Noted privately in your diary. Turn 💬 Chat ON to chat.');
    return;
  }

  // conversational reply (store history lightweight)
  const history = (u.history || []).slice(-8); // keep short context
  const answer = await askAI(history, text);
  const newHistory = [...history, { role: 'user', content: text }, { role: 'assistant', content: answer }];

  await updateUser(ctx.chat.id, { history: newHistory });
  await ctx.reply(answer, bottomBar());
});

// ─── Boot with retry ──────────────────────────────────────────────────────────
async function startWithRetry(max = 3) {
  let attempt = 0;
  while (attempt < max) {
    try {
      console.log(`[sb] ready → ${SUPABASE_URL}`);
      await bot.launch();
      console.log('Grace bot started in long polling mode');
      break;
    } catch (e) {
      attempt++;
      console.log(`[boot] Attempt ${attempt} failed: ${e?.message || e}`);
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
}

startWithRetry(3).catch(() => {});
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

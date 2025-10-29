// index.js — EverGrace (Phase A: Conversational + Modes)
// CommonJS build; works on Render and locally

// 1) ENV (Render uses dashboard vars; local uses .env)
require('dotenv').config();
const MUST = ['BOT_TOKEN', 'SUPABASE_URL', 'SUPABASE_KEY'];
const miss = MUST.filter(k => !process.env[k] || String(process.env[k]).trim() === '');
if (miss.length) {
  console.error('[ENV] Missing:', miss.join(', '));
  process.exit(1);
}

// 2) Imports
const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const http = require('http');

// 3) Clients
const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 4) Healthcheck (keeps Render happy)
const PORT = Number(process.env.PORT || 10000);
http.createServer((_, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}).listen(PORT, () => console.log(`[hc] listening on ${PORT}`));

// 5) Locales loader (en/it/de)
function loadLocales() {
  const dir = path.join(__dirname, 'locales');
  const L = {};
  for (const f of ['en.json', 'it.json', 'de.json']) {
    const fp = path.join(dir, f);
    if (fs.existsSync(fp)) {
      L[f.replace('.json', '')] = JSON.parse(fs.readFileSync(fp, 'utf8'));
    }
  }
  return L;
}
const LOCALES = loadLocales();
const FALLBACK_LANG = 'en';

// 6) Small state store (per chat): only current mode
//    mode ∈ 'journal' | 'coach' | 'sos'
const memory = new Map();

// 7) i18n
function t(lang, key, vars = {}) {
  const look = (obj, path) => path.split('.').reduce((a, k) => (a && a[k] != null ? a[k] : undefined), obj);
  const str = look(LOCALES[lang], key) ?? look(LOCALES[FALLBACK_LANG], key);
  if (typeof str !== 'string') return key;
  return str.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : `{${k}}`));
}

// 8) Keyboards
function homeKeyboard(lang = 'en') {
  return Markup.keyboard([
    ['📒 Journal', '📌 Coach'],
    ['⚡ SOS', '📊 Progress'],
    ['🔗 Invite']
  ]).resize();
}
function coachPicker(lang = 'en') {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('🤝 Friend', 'COACH_friend'),
      Markup.button.callback('🕊️ Spiritual', 'COACH_spiritual'),
      Markup.button.callback('🎯 Life & Goals', 'COACH_goal'),
    ]
  ]);
}

// 9) DB helpers (schema compatible with your fresh tables)
function pickLangFromTelegram(ctx) {
  const code = (ctx.from.language_code || '').slice(0, 2).toLowerCase();
  return LOCALES[code] ? code : FALLBACK_LANG;
}

async function ensureUser(ctx) {
  const id = ctx.from.id;
  const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ').trim() || null;
  const language = pickLangFromTelegram(ctx);

  const { data, error } = await supabase
    .from('users')
    .upsert({
      id,
      name,
      language,
      updated_at: new Date().toISOString()
    }, { onConflict: 'id' })
    .select('*')
    .single();
  if (error) {
    console.error('[ensureUser]', error);
    return { id, name, language, coach_mode: 'friend', streak_count: 0, freezes: 0, sos_counts: true };
  }
  // defaults if null
  if (data.coach_mode == null) data.coach_mode = 'friend';
  if (data.sos_counts == null) data.sos_counts = true;
  if (data.streak_count == null) data.streak_count = 0;
  if (data.freezes == null) data.freezes = 0;
  return data;
}

async function setCoachMode(userId, mode) {
  await supabase.from('users').update({
    coach_mode: mode,
    updated_at: new Date().toISOString()
  }).eq('id', userId);
}

async function addNote(user_id, mode, text) {
  const { error } = await supabase.from('notes').insert({ user_id, mode, text });
  if (error) throw error;
}

function ymd(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString().slice(0,10);
}

function daysBetween(a, b) {
  const A = new Date(a + 'T00:00:00Z').getTime();
  const B = new Date(b + 'T00:00:00Z').getTime();
  return Math.round((B - A) / 86400000);
}

async function ensureCheckIn(user, source) {
  if (source === 'sos' && user.sos_counts === false) return;

  const today = ymd(new Date());

  // already checked today?
  const { data: exists } = await supabase
    .from('checkins')
    .select('id').eq('user_id', user.id).eq('day', today).maybeSingle();
  if (exists && exists.id) return;

  let streak = 1;
  let freezes = user.freezes || 0;

  if (user.last_checkin) {
    const gap = daysBetween(user.last_checkin, today);
    if (gap <= 1) {
      streak = (user.streak_count || 0) + 1;
    } else if (gap === 2 && freezes > 0) {
      freezes -= 1;
      streak = (user.streak_count || 0) + 1;
    } else {
      streak = 1;
    }
  }

  await supabase.from('users').update({
    streak_count: streak,
    last_checkin: today,
    freezes,
    updated_at: new Date().toISOString()
  }).eq('id', user.id);

  await supabase.from('checkins').insert({ user_id: user.id, day: today, source })
    .then(({ error }) => { if (error && error.code !== '23505') console.error('[checkins insert]', error); });
}

async function getRecentNotes(user_id, limit = 5) {
  const { data, error } = await supabase
    .from('notes').select('mode,text,created_at')
    .eq('user_id', user_id)
    .order('created_at', { ascending: false })
    .limit(limit);
  return error ? [] : (data || []);
}

function bullets(lang, rows) {
  if (!rows.length) return t(lang, 'progress.empty') || 'No notes yet.';
  const lines = rows.map(r => {
    const d = new Date(r.created_at);
    const ts = d.toLocaleString();
    const ico = r.mode === 'journal' ? '📒' : r.mode === 'coach' ? '📌' : '⚡';
    return `• ${ts} — ${ico} ${r.text.split('\n')[0].slice(0,120)}`;
  }).join('\n');
  return (t(lang, 'progress.latest') || 'Latest:') + '\n' + lines;
}

// 10) Coach personalities
function coachFollowup(mode) {
  const R = {
    friend: [
      "I get you. And what’s the first step?",
      "I’m here. Why does that matter to you?",
      "Seems important. What’s one thing you can do today?"
    ],
    spiritual: [
      "Close your eyes. What shifts inside now?",
      "Where do you feel this most in your body?",
      "Is there a gentle truth emerging?"
    ],
    goal: [
      "If you had to move this today, what’s one micro-step?",
      "What result can you see in 24 hours?",
      "If success was tiny—what would it look like?"
    ]
  };
  const arr = R[mode] || R.friend;
  return arr[Math.floor(Math.random() * arr.length)];
}

// 11) Commands & entry points

bot.start(async (ctx) => {
  const user = await ensureUser(ctx);
  const lang = user.language || FALLBACK_LANG;
  memory.set(ctx.chat.id, { mode: 'journal' }); // default capture
  await ctx.reply(
    `${t(lang, 'welcome.hello', { name: ctx.from.first_name || '' })}\n${t(lang, 'welcome.subtitle')}`,
    homeKeyboard(lang)
  );
  await ctx.reply(t(lang, 'journal.prompt') || 'What would you like to note today? ✍️');
});

bot.command('id', (ctx) => ctx.reply(String(ctx.from.id)));

bot.hears(/^📒\s*Journal$/i, async (ctx) => {
  const user = await ensureUser(ctx);
  const lang = user.language || FALLBACK_LANG;
  memory.set(ctx.chat.id, { mode: 'journal' });
  await ctx.reply(t(lang, 'journal.prompt') || 'What would you like to note today? ✍️', homeKeyboard(lang));
});

bot.hears(/^📌\s*Coach$/i, async (ctx) => {
  const user = await ensureUser(ctx);
  const lang = user.language || FALLBACK_LANG;
  memory.set(ctx.chat.id, { mode: 'coach' });
  await ctx.reply(t(lang, 'coach.pick') || 'Pick a coaching style:', coachPicker(lang));
});

bot.action(/^COACH_(friend|spiritual|goal)$/, async (ctx) => {
  const mode = ctx.match[1];
  const user = await ensureUser(ctx);
  const lang = user.language || FALLBACK_LANG;
  await setCoachMode(user.id, mode);
  await ctx.answerCbQuery('OK');
  const confirm = mode === 'friend' ? 'Coach set to Friend.' :
                  mode === 'spiritual' ? 'Coach set to Spiritual.' :
                  'Coach set to Life & Goals.';
  await ctx.reply(confirm, homeKeyboard(lang));
});

bot.hears(/^⚡\s*SOS$/i, async (ctx) => {
  const user = await ensureUser(ctx);
  const lang = user.language || FALLBACK_LANG;
  memory.set(ctx.chat.id, { mode: 'sos' });
  await ctx.reply(t(lang, 'sos.open') || 'Tell me—what happened? I’m here with you.', homeKeyboard(lang));
  await ctx.reply(t(lang, 'sos.tools') || 'Two quick tools: 4-7-8 breathing and the 5-4-3-2-1 grounding.');
});

bot.hears(/^📊\s*Progress$/i, async (ctx) => {
  const user = await ensureUser(ctx);
  const lang = user.language || FALLBACK_LANG;
  const rows = await getRecentNotes(user.id, 5);
  await ctx.reply(bullets(lang, rows), homeKeyboard(lang));
});

bot.hears(/^🔗\s*Invite$/i, async (ctx) => {
  const user = await ensureUser(ctx);
  const lang = user.language || FALLBACK_LANG;
  await ctx.reply(t(lang, 'invite.text', { link: 'https://t.me/EverGraceRabeBot' }) || 'Invite: https://t.me/EverGraceRabeBot', homeKeyboard(lang));
});

// 12) Conversational capture (big fix)
bot.on('text', async (ctx) => {
  const text = (ctx.message.text || '').trim();
  if (!text) return;

  const state = memory.get(ctx.chat.id);
  if (!state) {
    // no active mode → default to journal capture
    memory.set(ctx.chat.id, { mode: 'journal' });
  }
  const mode = (state && state.mode) || 'journal';

  const user = await ensureUser(ctx);
  const lang = user.language || FALLBACK_LANG;

  try {
    // save entry
    await addNote(user.id, mode, text);
    await ensureCheckIn(user, mode);

    // tailored follow-ups
    if (mode === 'journal') {
      return ctx.reply(t(lang, 'journal.saved') || 'Saved. Want to add more?');
    }
    if (mode === 'sos') {
      return ctx.reply(t(lang, 'sos.talk_more') || 'I’m here. Tell me more when you’re ready.');
    }
    if (mode === 'coach') {
      const follow = coachFollowup(user.coach_mode || 'friend');
      return ctx.reply(follow);
    }
  } catch (e) {
    console.error('[text capture]', e);
    return ctx.reply(t(lang, 'common.save_error') || 'Sorry, I couldn’t save. Please try later.');
  }
});

// 13) Error guard & launch
bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  try { ctx.reply('Oops—please try again.'); } catch {}
});

bot.launch().then(() => console.log('EverGrace (Phase A) running ✅'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

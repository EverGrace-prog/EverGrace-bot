// index.js — HITH (Telegram)  — CommonJS

// ─────────────────────────────────────────────────────────────
// 1) ENV (local only; on Render keys come from Settings/Env)
require('dotenv').config();

// 2) ENV sanity check (no secrets printed)
const REQUIRED_ENV = ['BOT_TOKEN', 'SUPABASE_URL', 'SUPABASE_KEY'];
const missing = REQUIRED_ENV.filter(k => !process.env[k] || String(process.env[k]).trim() === '');
if (missing.length) {
  console.error('[ENV] Missing:', missing.join(', '));
  console.error('[Tip] Link your Env Group on Render → redeploy.');
  process.exit(1);
}
console.log('[ENV] Present:', REQUIRED_ENV.join(', '));

// ─────────────────────────────────────────────────────────────
// 3) Imports
const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const http = require('http');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));

// ─────────────────────────────────────────────────────────────
// 4) Clients
const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ─────────────────────────────────────────────────────────────
// 5) Healthcheck (Render)
const PORT = Number(process.env.PORT || 10000);
http.createServer((_, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}).listen(PORT, () => console.log(`[hc] listening on ${PORT}`));

// ─────────────────────────────────────────────────────────────
// 6) Locales loader (en/it/de.json in ./locales)
function safeParseJSON(raw) {
  // trim BOM & trailing commas
  const clean = String(raw).replace(/^\uFEFF/, '').replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(clean);
}
function loadLocales() {
  const L = {};
  const dir = path.join(__dirname, 'locales');
  for (const f of ['en.json', 'it.json', 'de.json']) {
    const fp = path.join(dir, f);
    if (fs.existsSync(fp)) {
      try { L[f.replace('.json', '')] = safeParseJSON(fs.readFileSync(fp, 'utf8')); }
      catch (e) { console.error('[i18n] JSON error in', f, e.message); }
    }
  }
  return L;
}
const LOCALES = loadLocales();
const FALLBACK_LANG = 'en';
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const SOS_COUNTS_DEFAULT = String(process.env.SOS_COUNTS || 'true').toLowerCase() !== 'false';

// i18n helper
function t(lang, key, vars = {}) {
  const pick = (obj, dotted) => dotted.split('.').reduce((a, k) => (a && a[k] != null ? a[k] : undefined), obj);
  const str = pick(LOCALES[lang] || {}, key) ?? pick(LOCALES[FALLBACK_LANG] || {}, key);
  if (typeof str !== 'string') return key;
  return str.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : `{${k}}`));
}

// ─────────────────────────────────────────────────────────────
// 7) Inline UI (no persistent reply keyboard)
function removeBoard() { return { reply_markup: { remove_keyboard: true } }; }

function menuInline(lang = 'en') {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📒 Journal', 'MENU_JOURNAL'),
     Markup.button.callback('📊 Progress', 'MENU_PROGRESS')],
    [Markup.button.callback('📌 Coach', 'MENU_COACH'),
     Markup.button.callback('⚡ SOS', 'MENU_SOS')],
    [Markup.button.callback(`⚙️ ${t(lang, 'common.k_settings') || 'Settings'}`, 'SETTINGS_OPEN')]
  ]);
}

function coachPicker(lang = 'en') {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(`🤝 ${t(lang, 'coach.friend')}`, 'COACH_friend'),
      Markup.button.callback(`🕊️ ${t(lang, 'coach.spiritual')}`, 'COACH_spiritual'),
      Markup.button.callback(`🎯 ${t(lang, 'coach.goal')}`, 'COACH_goal'),
    ],
  ]);
}

function langPicker(lang = 'en') {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🇬🇧 English', 'LANG_en'), Markup.button.callback('🇮🇹 Italiano', 'LANG_it')],
    [Markup.button.callback('🇩🇪 Deutsch', 'LANG_de')],
  ]);
}

// ─────────────────────────────────────────────────────────────
// 8) Ephemeral session state (per chat)
const memory = new Map(); // chat_id -> { mode: 'journal'|'coach'|'sos'|null }

// ─────────────────────────────────────────────────────────────
// 9) DB helpers
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
    .upsert({ id, name, language, updated_at: new Date().toISOString() }, { onConflict: 'id' })
    .select('*')
    .single();
  if (error || !data) {
    console.error('[ensureUser]', error);
    return { id, language, sos_counts: SOS_COUNTS_DEFAULT, streak_count: 0, freezes: 0 };
  }
  if (data.sos_counts == null) {
    await supabase.from('users').update({ sos_counts: SOS_COUNTS_DEFAULT }).eq('id', id);
    data.sos_counts = SOS_COUNTS_DEFAULT;
  }
  return data;
}

async function getUser(id) {
  const { data } = await supabase.from('users').select('*').eq('id', id).single();
  return data || null;
}
async function setUserLanguage(id, language) {
  await supabase.from('users').update({ language, updated_at: new Date().toISOString() }).eq('id', id);
}
async function setCoachMode(id, coach_mode) {
  await supabase.from('users').update({ coach_mode, updated_at: new Date().toISOString() }).eq('id', id);
}
async function addNote(user_id, mode, text) {
  const { error } = await supabase.from('notes').insert({ user_id, mode, text });
  if (error) throw error;
}
async function getRecentNotes(user_id, limit = 5) {
  const { data, error } = await supabase
    .from('notes')
    .select('id, mode, text, created_at')
    .eq('user_id', user_id)
    .order('created_at', { ascending: false })
    .limit(limit);
  return error ? [] : (data || []);
}

// streak helpers
function ymd(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  const A = new Date(a + 'T00:00:00Z').getTime();
  const B = new Date(b + 'T00:00:00Z').getTime();
  return Math.round((B - A) / 86400000);
}
/** ensure daily check-in (with one-day freeze bridge) */
async function ensureCheckIn(user, sourceMode) {
  if (sourceMode === 'sos' && user.sos_counts === false) return { updated: false, reason: 'sos_disabled' };
  const today = ymd(new Date());

  const { data: existing } = await supabase
    .from('checkins')
    .select('id')
    .eq('user_id', user.id)
    .eq('day', today)
    .maybeSingle();
  if (existing && existing.id) return { updated: false, reason: 'already_today' };

  let newStreak = 1;
  let newFreezes = user.freezes || 0;

  if (user.last_checkin) {
    const gap = daysBetween(user.last_checkin, today);
    if (gap <= 1) newStreak = (user.streak_count || 0) + 1;
    else if (gap === 2 && newFreezes > 0) { newFreezes -= 1; newStreak = (user.streak_count || 0) + 1; }
    else newStreak = 1;
  }

  await supabase.from('users').update({
    streak_count: newStreak,
    last_checkin: today,
    freezes: newFreezes,
    updated_at: new Date().toISOString(),
  }).eq('id', user.id);

  const ins = await supabase.from('checkins').insert({ user_id: user.id, day: today, source: sourceMode });
  if (ins.error && ins.error.code !== '23505') console.error('[checkins insert]', ins.error);
  return { updated: true, streak: newStreak, freezes: newFreezes };
}

function bulletList(lang, rows) {
  if (!rows.length) return t(lang, 'progress.empty');
  const bullets = rows.map(r => {
    const d = new Date(r.created_at);
    const ts = d.toLocaleString('it-IT', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const icon = r.mode === 'journal' ? '📒' : r.mode === 'coach' ? '📌' : '⚡';
    return `• ${ts} — ${icon} ${r.text.split('\n')[0].slice(0, 120)}`;
  }).join('\n');
  return `${t(lang, 'progress.latest')}\n${bullets}`;
}

// ─────────────────────────────────────────────────────────────
// 10) AI & research helpers
async function aiReply({ system, prompt }) {
  if (!process.env.OPENAI_API_KEY) return null;
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: system || 'You are HITH, a warm, multilingual assistant. Be brief, kind, practical.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.6
    })
  });
  const j = await r.json();
  return j?.choices?.[0]?.message?.content?.trim() || null;
}
async function webResearch(q) {
  const key = process.env.SEARCH_API_KEY;
  if (!key) return null;
  const prov = (process.env.SEARCH_PROVIDER || 'tavily').toLowerCase();
  if (prov === 'tavily') {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ query: q, max_results: 5 })
    });
    const j = await r.json();
    return (j.results || []).slice(0, 3).map(x => `• ${x.title} — ${x.url}`).join('\n') || null;
  }
  const r = await fetch(`https://serpapi.com/search.json?q=${encodeURIComponent(q)}&engine=google&api_key=${key}`);
  const j = await r.json();
  return (j.organic_results || []).slice(0, 3).map(x => `• ${x.title} — ${x.link}`).join('\n') || null;
}

// ─────────────────────────────────────────────────────────────
// 11) Commands & actions

bot.start(async (ctx) => {
  const user = await ensureUser(ctx);
  const lang = user.language || FALLBACK_LANG;
  memory.set(ctx.chat.id, { mode: null });
  const subtitle = (t(lang, 'welcome.subtitle') || '').replace(/EverGrace/gi, 'HITH');
  await ctx.reply(`${t(lang, 'welcome.hello', { name: ctx.from.first_name || '' })}\n${subtitle}`, removeBoard());
  await ctx.reply('Type /menu any time to open actions.');
});

bot.command('menu', async (ctx) => {
  const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
  await ctx.reply(' ', removeBoard());
  await ctx.reply('Menu', menuInline(user.language || FALLBACK_LANG));
});

bot.command('id', (ctx) => ctx.reply(String(ctx.from.id)));

bot.command('ask', async (ctx) => {
  const q = (ctx.message.text || '').replace(/^\/ask\s*/i, '').trim();
  if (!q) return ctx.reply('Ask me anything like: /ask best breathing techniques');
  const research = await webResearch(q);
  const answer = await aiReply({
    prompt: `${research ? `Use these links:\n${research}\n\n` : ''}Question: ${q}\nAnswer concisely in the user’s language if obvious.`
  }) || 'I’m here.';
  await ctx.reply(answer);
});

// Inline menu actions
bot.action('MENU_JOURNAL', async (ctx) => {
  const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
  memory.set(ctx.chat.id, { mode: 'journal' });
  await ctx.answerCbQuery();
  await ctx.reply(t(user.language, 'journal.prompt'), removeBoard());
});
bot.action('MENU_PROGRESS', async (ctx) => {
  const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
  const rows = await getRecentNotes(user.id, 5);
  await ctx.answerCbQuery();
  await ctx.reply(bulletList(user.language, rows), removeBoard());
});
bot.action('MENU_COACH', async (ctx) => {
  const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
  memory.set(ctx.chat.id, { mode: 'coach' });
  await ctx.answerCbQuery();
  await ctx.reply(t(user.language, 'coach.pick'), coachPicker(user.language));
});
bot.action('MENU_SOS', async (ctx) => {
  const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
  memory.set(ctx.chat.id, { mode: 'sos' });
  await ctx.answerCbQuery();
  await ctx.reply(t(user.language, 'sos.open'), removeBoard());
  await ctx.reply(t(user.language, 'sos.tools'));
});

// Settings
bot.action('SETTINGS_OPEN', async (ctx) => {
  const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
  await ctx.answerCbQuery();
  await ctx.reply(t(user.language, 'settings.title'), Markup.inlineKeyboard([
    [Markup.button.callback(`🌐 ${t(user.language, 'settings.change_lang')}`, 'SETTINGS_LANG')],
    [Markup.button.callback(`🎯 ${t(user.language, 'settings.coach_mode')}`, 'SETTINGS_COACH')]
  ]));
});
bot.action('SETTINGS_LANG', async (ctx) => {
  const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
  await ctx.answerCbQuery();
  await ctx.reply(t(user.language, 'settings.pick_lang'), langPicker(user.language));
});
for (const code of ['en', 'it', 'de']) {
  bot.action(`LANG_${code}`, async (ctx) => {
    await setUserLanguage(ctx.from.id, code);
    await ctx.answerCbQuery('OK');
    await ctx.reply(t(code, 'settings.lang_ok'), removeBoard());
  });
}
bot.action('SETTINGS_COACH', async (ctx) => {
  const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
  await ctx.answerCbQuery();
  await ctx.reply(t(user.language, 'coach.pick'), coachPicker(user.language));
});
for (const mode of ['friend', 'spiritual', 'goal']) {
  bot.action(`COACH_${mode}`, async (ctx) => {
    const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
    await setCoachMode(user.id, mode);
    await ctx.answerCbQuery();
    await ctx.reply(t(user.language, `coach.set_${mode}`), removeBoard());
  });
}

// ─────────────────────────────────────────────────────────────
// 12) Free-form text: capture OR conversational
bot.on('text', async (ctx, next) => {
  const state = memory.get(ctx.chat.id);
  const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
  const lang = user.language || FALLBACK_LANG;
  const text = (ctx.message.text || '').trim();
  if (!text) return;

  // If actively capturing (journal/coach/sos)…
  if (state?.mode === 'journal' || state?.mode === 'coach' || state?.mode === 'sos') {
    // If it's a question, answer conversationally but DON'T save it as a note
    const looksLikeQ = /[?？]$/.test(text) || /(^|\s)(how|why|what|when|dove|come|perch[eé]|warum|wie|was)(\s|$)/i.test(text);
    if (looksLikeQ) {
      const answer = await aiReply({ prompt: text }) || "I'm here.";
      return ctx.reply(answer);
    }

    // Save note
    try {
      await addNote(user.id, state.mode, text);
      await ensureCheckIn(user, state.mode);
    } catch (e) {
      console.error('[note]', e);
      return ctx.reply(t(lang, 'common.save_error'));
    }

    if (state.mode === 'journal') return ctx.reply(t(lang, 'journal.saved'), removeBoard());
    if (state.mode === 'sos')     return ctx.reply(t(lang, 'coach.escalate'), removeBoard());
    return ctx.reply(t(lang, 'coach.coach_intro'), removeBoard());
  }

  // …else: fully conversational
  const answer = await aiReply({ prompt: text }) || "I'm here.";
  return ctx.reply(answer);
});

// ─────────────────────────────────────────────────────────────
// 13) Admin utilities
function isAdmin(ctx) { return ADMIN_IDS.includes(String(ctx.from.id)); }

/** /give_freeze <n> [userId] */
bot.command('give_freeze', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Not authorized.');
  const parts = (ctx.message.text || '').trim().split(/\s+/);
  const n = Number(parts[1] || '0');
  const targetId = parts[2] ? Number(parts[2]) : Number(ctx.from.id);
  if (!Number.isFinite(n) || n <= 0) return ctx.reply('Usage: /give_freeze <n> [userId]');
  const user = await getUser(targetId);
  if (!user) return ctx.reply('User not found.');
  const { error } = await supabase.from('users').update({ freezes: (user.freezes || 0) + n }).eq('id', targetId);
  if (error) return ctx.reply('DB error.');
  await ctx.reply(`Granted ${n} freeze(s) to ${targetId}. Total: ${(user.freezes || 0) + n}`);
});

/** /sos_counts on|off */
bot.command('sos_counts', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Not authorized.');
  const flag = ((ctx.message.text || '').split(/\s+/)[1] || '').toLowerCase();
  if (!['on', 'off'].includes(flag)) return ctx.reply('Usage: /sos_counts on|off');
  const val = flag === 'on';
  const { error } = await supabase.from('users').update({ sos_counts: val }).eq('id', ctx.from.id);
  if (error) return ctx.reply('DB error.');
  await ctx.reply(`SOS counts: ${val ? 'ON' : 'OFF'}`);
});

/** /streak — quick status */
bot.command('streak', async (ctx) => {
  const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
  const streak = user.streak_count || 0;
  const freezes = user.freezes || 0;
  const last = user.last_checkin || '—';

  const today = new Date();
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    days.push(ymd(d));
  }
  const { data } = await supabase.from('checkins').select('day').eq('user_id', user.id)
    .gte('day', days[0]).lte('day', days[days.length - 1]);
  const set = new Set((data || []).map(r => r.day));
  const bar = days.map(d => (set.has(d) ? '🟩' : '⬜️')).join('');
  await ctx.reply(`🔥 Streak: ${streak}\n❄️ Freezes: ${freezes}\n📅 Last: ${last}\n${bar}`);
});

// ─────────────────────────────────────────────────────────────
// 14) Error guard & launch
bot.catch((err, ctx) => {
  console.error('Bot error', err);
  try { ctx.reply('Oops, qualcosa è andato storto. Riprova.'); } catch {}
});

bot.launch().then(() => console.log('HITH is live ✅'));
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

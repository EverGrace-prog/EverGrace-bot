// index.js — EverGrace bot (CommonJS)

/* ─────────────────────────────────────────
 * 1) ENV
 * ───────────────────────────────────────── */
require('dotenv').config();
const requiredEnv = ['BOT_TOKEN', 'SUPABASE_URL', 'SUPABASE_KEY'];
const missing = requiredEnv.filter(k => !process.env[k] || String(process.env[k]).trim() === '');
if (missing.length) {
  console.error('[Env] Missing:', missing.join(', '));
  console.error('[Env Tip] Service → Settings → Environment: link your Env Group (EverGrace Keys) and Redeploy.');
  process.exit(1);
}
console.log('[Env] Present:', requiredEnv.join(', '));

/* ─────────────────────────────────────────
 * 2) Imports
 * ───────────────────────────────────────── */
const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const http = require('http');
const JSON5 = require('json5'); // tolerant JSON parser

/* ─────────────────────────────────────────
 * 3) Clients
 * ───────────────────────────────────────── */
const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

/* ─────────────────────────────────────────
 * 4) Healthcheck (Render)
 * ───────────────────────────────────────── */
const PORT = Number(process.env.PORT || 10000);
http.createServer((_, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('OK');
}).listen(PORT, () => console.log(`[hc] listening on ${PORT}`));

/* ─────────────────────────────────────────
 * 5) Locales (forgiving loader)
 * ───────────────────────────────────────── */
function loadLocales() {
  const L = {};
  const dir = path.join(__dirname, 'locales');
  for (const f of ['en.json', 'it.json', 'de.json']) {
    const fp = path.join(dir, f);
    if (!fs.existsSync(fp)) continue;
    try {
      const raw = fs.readFileSync(fp, 'utf8').replace(/^\uFEFF/, ''); // strip BOM
      L[f.replace('.json', '')] = JSON5.parse(raw);
    } catch (e) {
      console.error(`[i18n] Failed to parse ${f}: ${e.message}`);
      L[f.replace('.json', '')] = {};
    }
  }
  return L;
}
const LOCALES = loadLocales();
const FALLBACK_LANG = 'en';
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const SOS_COUNTS_DEFAULT = String(process.env.SOS_COUNTS || 'true').toLowerCase() !== 'false';

/* ─────────────────────────────────────────
 * 6) i18n helper
 * ───────────────────────────────────────── */
function t(lang, key, vars = {}) {
  const get = (obj, k) => k.split('.').reduce((o, p) => (o && o[p] != null ? o[p] : undefined), obj);
  const val = get(LOCALES[lang], key) ?? get(LOCALES[FALLBACK_LANG], key);
  if (typeof val !== 'string') return key;
  return val.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : `{${k}}`));
}

/* ─────────────────────────────────────────
 * 7) Keyboards
 * ───────────────────────────────────────── */
function homeKeyboard(lang = 'en') {
  const k = (s, fallback) => t(lang, s) || fallback;
  return Markup.keyboard([
    [`🎯 ${k('common.k_menu', 'Menu')}`, `📒 ${k('common.k_journal', 'Journal')}`],
    [`📊 ${k('common.k_progress', 'Progress')}`, `📌 ${k('common.k_coach', 'Coach')}`],
    [`⚡ ${k('common.k_sos', 'SOS')}`, `🔗 ${k('common.k_invite', 'Invite')}`],
  ]).resize();
}
function settingsKeyboard(lang) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(`🌐 ${t(lang, 'settings.change_lang')}`, 'SETTINGS_LANG')],
    [Markup.button.callback(`🎯 ${t(lang, 'settings.coach_mode')}`, 'SETTINGS_COACH')],
  ]);
}
function langPicker() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🇬🇧 English', 'LANG_en'), Markup.button.callback('🇮🇹 Italiano', 'LANG_it')],
    [Markup.button.callback('🇩🇪 Deutsch', 'LANG_de')],
  ]);
}
function coachPicker(lang) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(`🤝 ${t(lang, 'coach.friend')}`, 'COACH_friend'),
      Markup.button.callback(`🕊️ ${t(lang, 'coach.spiritual')}`, 'COACH_spiritual'),
      Markup.button.callback(`🎯 ${t(lang, 'coach.goal')}`, 'COACH_goal'),
    ],
  ]);
}
function menuInline(lang) {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📄 TXT', 'EXPORT_TXT')],
    [Markup.button.callback(`⚙️ ${t(lang, 'common.k_settings') || 'Settings'}`, 'SETTINGS_OPEN')],
  ]);
}

/* ─────────────────────────────────────────
 * 8) Simple in-memory session
 * ───────────────────────────────────────── */
const memory = new Map(); // chat_id -> { mode: 'journal'|'coach'|'sos' }

/* ─────────────────────────────────────────
 * 9) DB helpers
 * ───────────────────────────────────────── */
function pickLangFromTelegram(ctx) {
  const code = (ctx.from.language_code || '').slice(0, 2).toLowerCase();
  return LOCALES[code] ? code : FALLBACK_LANG;
}

async function ensureUser(ctx) {
  const chat_id = ctx.from.id;
  const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ').trim();
  const language = pickLangFromTelegram(ctx);

  const { data, error } = await supabase
    .from('users')
    .upsert(
      { id: chat_id, name: name || null, language, updated_at: new Date().toISOString() },
      { onConflict: 'id' }
    )
    .select('*')
    .single();
  if (error) {
    console.error('[ensureUser] upsert error', error);
    return { id: chat_id, language, sos_counts: SOS_COUNTS_DEFAULT, freezes: 0, streak_count: 0 };
  }
  if (data.sos_counts === null || data.sos_counts === undefined) {
    await supabase.from('users').update({ sos_counts: SOS_COUNTS_DEFAULT }).eq('id', chat_id);
    data.sos_counts = SOS_COUNTS_DEFAULT;
  }
  return data;
}

async function getUser(user_id) {
  const { data } = await supabase.from('users').select('*').eq('id', user_id).single();
  return data || null;
}

async function setUserLanguage(user_id, language) {
  await supabase.from('users').update({ language, updated_at: new Date().toISOString() }).eq('id', user_id);
}
async function setCoachMode(user_id, coach_mode) {
  await supabase.from('users').update({ coach_mode, updated_at: new Date().toISOString() }).eq('id', user_id);
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

/* Streak helpers */
function ymd(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  const A = new Date(a + 'T00:00:00Z').getTime();
  const B = new Date(b + 'T00:00:00Z').getTime();
  return Math.round((B - A) / 86400000);
}
async function ensureCheckIn(user, sourceMode) {
  if (sourceMode === 'sos' && user.sos_counts === false) return { updated: false, reason: 'sos_disabled' };

  const today = ymd(new Date());
  const { data: exists } = await supabase
    .from('checkins')
    .select('id')
    .eq('user_id', user.id)
    .eq('day', today)
    .maybeSingle();
  if (exists && exists.id) return { updated: false, reason: 'already_today' };

  let newStreak = 1;
  let newFreezes = user.freezes || 0;

  if (user.last_checkin) {
    const gap = daysBetween(user.last_checkin, today);
    if (gap <= 1) {
      newStreak = (user.streak_count || 0) + 1;
    } else if (gap === 2 && newFreezes > 0) {
      newFreezes -= 1; // use a freeze to bridge
      newStreak = (user.streak_count || 0) + 1;
    } else {
      newStreak = 1;
    }
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

/* ─────────────────────────────────────────
 * 10) Formatting helpers
 * ───────────────────────────────────────── */
function bulletList(lang, rows) {
  if (!rows.length) return t(lang, 'progress.empty');
  const bullets = rows.map(r => {
    const d = new Date(r.created_at);
    const ts = d.toLocaleString('it-IT', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit' });
    const icon = r.mode === 'journal' ? '📒' : r.mode === 'coach' ? '📌' : '⚡';
    return `• ${ts} — ${icon} ${r.text.split('\n')[0].slice(0,120)}`;
  }).join('\n');
  return `${t(lang, 'progress.latest')}\n${bullets}`;
}

/* ─────────────────────────────────────────
 * 11) Commands & Buttons
 * ───────────────────────────────────────── */
bot.start(async (ctx) => {
  const user = await ensureUser(ctx);
  const lang = user.language || pickLangFromTelegram(ctx);
  memory.set(ctx.chat.id, { mode: 'journal' });
  await ctx.reply(`${t(lang, 'welcome.hello', { name: ctx.from.first_name || '' })}\n${t(lang, 'welcome.subtitle')}`, homeKeyboard(lang));
  await ctx.reply(t(lang, 'journal.prompt'));
});

bot.command('id', (ctx) => ctx.reply(String(ctx.from.id)));

bot.hears(/^🎯\s*Menu$/i, async (ctx) => {
  const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
  const lang = user.language || FALLBACK_LANG;
  await ctx.reply(t(lang, 'invite.text', { link: 'https://t.me/EverGraceRabeBot' }), menuInline(lang));
});

bot.hears(/^📒\s*Journal$/i, async (ctx) => {
  const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
  const lang = user.language || FALLBACK_LANG;
  memory.set(ctx.chat.id, { mode: 'journal' });
  await ctx.reply(t(lang, 'journal.prompt'), homeKeyboard(lang));
});

bot.hears(/^📌\s*Coach$/i, async (ctx) => {
  const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
  const lang = user.language || FALLBACK_LANG;
  memory.set(ctx.chat.id, { mode: 'coach' });
  await ctx.reply(t(lang, 'coach.pick'), coachPicker(lang));
});

bot.hears(/^⚡\s*SOS$/i, async (ctx) => {
  const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
  const lang = user.language || FALLBACK_LANG;
  memory.set(ctx.chat.id, { mode: 'sos' });
  await ctx.reply(t(lang, 'sos.open'), homeKeyboard(lang));
  await ctx.reply(t(lang, 'sos.tools'));
});

bot.hears(/^📊\s*Progress$/i, async (ctx) => {
  const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
  const lang = user.language || FALLBACK_LANG;
  const rows = await getRecentNotes(user.id, 5);
  await ctx.reply(bulletList(lang, rows), homeKeyboard(lang));
});

bot.hears(/^🔗\s*Invite$/i, async (ctx) => {
  const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
  const lang = user.language || FALLBACK_LANG;
  await ctx.reply(t(lang, 'invite.text', { link: 'https://t.me/EverGraceRabeBot' }), homeKeyboard(lang));
});

/* Inline actions */
bot.action('SETTINGS_OPEN', async (ctx) => {
  const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
  const lang = user.language || FALLBACK_LANG;
  await ctx.answerCbQuery();
  await ctx.reply(t(lang, 'settings.title'), settingsKeyboard(lang));
});
bot.action('SETTINGS_LANG', async (ctx) => {
  const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
  const lang = user.language || FALLBACK_LANG;
  await ctx.answerCbQuery();
  await ctx.reply(t(lang, 'settings.pick_lang'), langPicker(lang));
});
for (const code of ['en','it','de']) {
  bot.action(`LANG_${code}`, async (ctx) => {
    await setUserLanguage(ctx.from.id, code);
    await ctx.answerCbQuery('OK');
    await ctx.reply(t(code, 'settings.lang_ok'), homeKeyboard(code));
  });
}
bot.action('SETTINGS_COACH', async (ctx) => {
  const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
  const lang = user.language || FALLBACK_LANG;
  await ctx.answerCbQuery();
  await ctx.reply(t(lang, 'coach.pick'), coachPicker(lang));
});
for (const mode of ['friend','spiritual','goal']) {
  bot.action(`COACH_${mode}`, async (ctx) => {
    const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
    const lang = user.language || FALLBACK_LANG;
    await setCoachMode(user.id, mode);
    await ctx.answerCbQuery();
    await ctx.reply(t(lang, `coach.set_${mode}`), homeKeyboard(lang));
  });
}
bot.action('EXPORT_TXT', async (ctx) => {
  const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
  await ctx.answerCbQuery();
  const { data, error } = await supabase
    .from('notes')
    .select('mode,text,created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error || !data || !data.length) return ctx.reply('Nothing to export yet.');
  const body = data.map(r => `[${new Date(r.created_at).toISOString()}] ${r.mode.toUpperCase()}: ${r.text}`).join('\n');
  await ctx.replyWithDocument({ source: Buffer.from(body, 'utf8'), filename: `evergrace_${user.id}.txt` });
});

/* ─────────────────────────────────────────
 * 12) Free-form capture (journal/coach/sos)
 * ───────────────────────────────────────── */
bot.on('text', async (ctx, next) => {
  const st = memory.get(ctx.chat.id);
  if (!st) return next();

  const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
  const lang = user.language || FALLBACK_LANG;
  const mode = st.mode;
  const text = (ctx.message.text || '').trim();
  if (!text) return;

  try { await addNote(user.id, mode, text); }
  catch (e) { console.error('[addNote]', e); return ctx.reply(t(lang, 'common.save_error')); }

  try { await ensureCheckIn(user, mode); }
  catch (e) { console.error('[ensureCheckIn]', e); }

  if (mode === 'journal') {
    await ctx.reply(t(lang, 'journal.saved'), homeKeyboard(lang));
  } else if (mode === 'sos') {
    await ctx.reply(t(lang, 'coach.escalate'), homeKeyboard(lang));
  } else {
    await ctx.reply(t(lang, 'coach.coach_intro'), homeKeyboard(lang));
  }
});

/* ─────────────────────────────────────────
 * 13) Admin utilities
 * ───────────────────────────────────────── */
const isAdmin = (ctx) => ADMIN_IDS.includes(String(ctx.from.id));

bot.command('give_freeze', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Not authorized.');
  const parts = (ctx.message.text || '').trim().split(/\s+/);
  const n = Number(parts[1] || '0');
  const targetId = parts[2] ? Number(parts[2]) : Number(ctx.from.id);
  if (!Number.isFinite(n) || n <= 0) return ctx.reply('Usage: /give_freeze <n> [userId]');
  const user = await getUser(targetId);
  if (!user) return ctx.reply('User not found in DB.');
  const total = (user.freezes || 0) + n;
  const { error } = await supabase.from('users').update({ freezes: total, updated_at: new Date().toISOString() }).eq('id', targetId);
  if (error) return ctx.reply('DB error.');
  await ctx.reply(`Granted ${n} freeze(s) to ${targetId}. New total: ${total}`);
});

bot.command('sos_counts', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('Not authorized.');
  const parts = (ctx.message.text || '').trim().split(/\s+/);
  const flag = (parts[1] || '').toLowerCase();
  if (!['on','off'].includes(flag)) return ctx.reply('Usage: /sos_counts on|off');
  const val = flag === 'on';
  const { error } = await supabase.from('users').update({ sos_counts: val }).eq('id', ctx.from.id);
  if (error) return ctx.reply('DB error.');
  await ctx.reply(`SOS counts: ${val ? 'ON' : 'OFF'}`);
});

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
  const { data } = await supabase
    .from('checkins').select('day')
    .eq('user_id', user.id)
    .gte('day', days[0])
    .lte('day', days[days.length - 1]);
  const set = new Set((data || []).map(r => r.day));
  const bar = days.map(d => (set.has(d) ? '🟩' : '⬜️')).join('');
  await ctx.reply(`🔥 Streak: ${streak}\n❄️ Freezes: ${freezes}\n📅 Last: ${last}\n${bar}`, homeKeyboard(user.language || FALLBACK_LANG));
});

/* ─────────────────────────────────────────
 * 14) Error guard & Launch
 * ───────────────────────────────────────── */
bot.catch((err, ctx) => {
  console.error('Bot error', err);
  try { return ctx.reply('Oops, qualcosa è andato storto. Riprova.'); } catch {}
});

bot.launch().then(() => console.log('EverGrace bot running ✅'));
process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

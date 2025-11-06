// index.js — HITH (EverGrace) bot, CJS

// ─────────────────────────────────────────────────────────────
// 1) ENV + sanity (no secrets printed)
require('dotenv').config();
const REQUIRED = ['BOT_TOKEN', 'SUPABASE_URL', 'SUPABASE_KEY'];
const missing = REQUIRED.filter(k => !process.env[k] || String(process.env[k]).trim() === '');
if (missing.length) {
  console.error('[Env] Missing:', missing.join(', '));
  process.exit(1);
}
console.log('[Env] Present:', REQUIRED.join(', '));

// ─────────────────────────────────────────────────────────────
// 2) Imports
const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');

// ─────────────────────────────────────────────────────────────
// 3) Clients
const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ─────────────────────────────────────────────────────────────
// 4) Locales
function loadLocales() {
  const L = {};
  const dir = path.join(__dirname, 'locales');
  for (const f of ['en.json', 'it.json', 'de.json']) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) {
      try { L[f.replace('.json', '')] = JSON.parse(fs.readFileSync(p, 'utf8')); }
      catch (e) { console.error('[i18n] bad JSON in', f, e.message); }
    }
  }
  return L;
}
const LOCALES = loadLocales();
const FALLBACK_LANG = 'en';

// safe translation: never echo raw key
function t(lang, key, vars = {}) {
  const segs = key.split('.');
  const find = (root) => segs.reduce((a, k) => (a && a[k] != null ? a[k] : undefined), root);
  let msg = find(LOCALES[lang]);
  if (typeof msg !== 'string') msg = find(LOCALES[FALLBACK_LANG]);
  if (typeof msg !== 'string') return ''; // never show [common.k_*]
  return msg.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? String(vars[k]) : ''));
}

// user-facing labels (no leaking keys)
function lbl(lang, id) {
  const map = {
    journal: t(lang, 'common.k_journal') || 'Journal',
    progress: t(lang, 'common.k_progress') || 'Progress',
    coach:    t(lang, 'common.k_coach') || 'Coach',
    sos:      t(lang, 'common.k_sos') || 'SOS',
    invite:   t(lang, 'common.k_invite') || 'Invite',
    menu:     'Menu',
    settings: t(lang, 'common.k_settings') || 'Settings'
  };
  return map[id];
}

// small warmth helper
function warm(s) {
  if (!s) return '';
  const tail = ['💚','✨','🌿','🙂','🤝','💫'];
  return s.endsWith('.') || s.endsWith('!') || s.endsWith('…') ? `${s} ${tail[Math.floor(Math.random()*tail.length)]}` : `${s} ${tail[Math.floor(Math.random()*tail.length)]}`;
}

// ─────────────────────────────────────────────────────────────
// 5) Keyboards (emoji + localized words, no key names)
function homeKeyboard(lang='en') {
  return Markup.keyboard([
    [`📒 ${lbl(lang,'journal')}`, `📊 ${lbl(lang,'progress')}`],
    [`📌 ${lbl(lang,'coach')}`,   `⚡ ${lbl(lang,'sos')}`],
    [`🔗 ${lbl(lang,'invite')}`,  `🎯 ${lbl(lang,'menu')}`],
  ]).resize();
}

function settingsKeyboard(lang='en') {
  return Markup.inlineKeyboard([
    [Markup.button.callback(`🌐 ${t(lang,'settings.change_lang') || 'Language'}`, 'SETTINGS_LANG')],
    [Markup.button.callback(`🎯 ${t(lang,'settings.coach_mode') || 'Coach mode'}`, 'SETTINGS_COACH')],
  ]);
}

function langPicker() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🇬🇧 English', 'LANG_en'), Markup.button.callback('🇮🇹 Italiano', 'LANG_it')],
    [Markup.button.callback('🇩🇪 Deutsch', 'LANG_de')],
  ]);
}

function coachPicker(lang='en') {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(`🤝 ${t(lang,'coach.friend')||'Friend'}`, 'COACH_friend'),
      Markup.button.callback(`🕊️ ${t(lang,'coach.spiritual')||'Spiritual'}`, 'COACH_spiritual'),
      Markup.button.callback(`🎯 ${t(lang,'coach.goal')||'Life & Goals'}`, 'COACH_goal'),
    ],
  ]);
}

function menuInline(lang='en') {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📄 TXT', 'EXPORT_TXT')],
    [Markup.button.callback(`⚙️ ${lbl(lang,'settings')}`, 'SETTINGS_OPEN')],
  ]);
}

// ─────────────────────────────────────────────────────────────
// 6) Memory (last mode per chat)
const memory = new Map(); // chatId -> {mode:'journal'|'coach'|'sos'}

// ─────────────────────────────────────────────────────────────
// 7) DB helpers
function pickLangFromTelegram(ctx) {
  const c = (ctx.from.language_code||'').slice(0,2).toLowerCase();
  return LOCALES[c] ? c : FALLBACK_LANG;
}

async function ensureUser(ctx) {
  const id = String(ctx.from.id);
  const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ').trim() || null;
  const language = pickLangFromTelegram(ctx);
  const base = { id, name, language, updated_at: new Date().toISOString() };

  const { data, error } = await supabase.from('users').upsert(base, { onConflict: 'id' }).select('*').single();
  if (error && error.code !== '23505') console.error('[ensureUser]', error);
  const row = data || base;
  // defaults (in case columns exist)
  if (row.sos_counts === undefined) row.sos_counts = true;
  if (row.freezes === undefined) row.freezes = 0;
  if (row.streak_count === undefined) row.streak_count = 0;
  return row;
}

async function getUser(id) {
  const { data } = await supabase.from('users').select('*').eq('id', id).maybeSingle();
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

function ymd(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString().slice(0,10);
}
function daysBetween(a,b) {
  return Math.round((new Date(b+'T00:00:00Z') - new Date(a+'T00:00:00Z'))/86400000);
}

async function ensureCheckIn(user, source) {
  if (source==='sos' && user.sos_counts===false) return { updated:false, reason:'sos_disabled' };
  const today = ymd(new Date());

  const { data:existing } = await supabase.from('checkins').select('id').eq('user_id', user.id).eq('day', today).maybeSingle();
  if (existing) return { updated:false, reason:'already_today' };

  let streak = 1, freezes = user.freezes||0;
  if (user.last_checkin) {
    const gap = daysBetween(user.last_checkin, today);
    if (gap<=1) streak = (user.streak_count||0)+1;
    else if (gap===2 && freezes>0) { freezes -= 1; streak = (user.streak_count||0)+1; }
    else streak = 1;
  }

  await supabase.from('users').update({
    streak_count: streak, last_checkin: today, freezes, updated_at: new Date().toISOString()
  }).eq('id', user.id);
  await supabase.from('checkins').insert({ user_id:user.id, day:today, source });
  return { updated:true, streak, freezes };
}

async function recentNotes(user_id, limit=5) {
  const { data } = await supabase
    .from('notes')
    .select('mode,text,created_at')
    .eq('user_id', user_id)
    .order('created_at', { ascending:false })
    .limit(limit);
  return data || [];
}

function listBullets(lang, rows) {
  if (!rows.length) return t(lang,'progress.empty') || 'No notes yet. Start with the Journal.';
  const lines = rows.map(r=>{
    const d = new Date(r.created_at);
    const ts = d.toLocaleString('it-IT',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});
    const icon = r.mode==='journal'?'📒':r.mode==='coach'?'📌':'⚡';
    return `• ${ts} — ${icon} ${r.text.split('\n')[0].slice(0,120)}`;
  }).join('\n');
  return `${t(lang,'progress.latest') || 'Your recent notes:'}\n${lines}`;
}

// ─────────────────────────────────────────────────────────────
// 8) Telegram commands

const ADMIN_IDS = (process.env.ADMIN_IDS||'').split(',').map(s=>s.trim()).filter(Boolean);
const isAdmin = (ctx) => ADMIN_IDS.includes(String(ctx.from.id));

bot.start(async (ctx)=>{
  const user = await ensureUser(ctx);
  const lang = user.language || FALLBACK_LANG;
  memory.set(ctx.chat.id, { mode:'journal' });
  await ctx.reply(`${t(lang,'welcome.hello',{name:ctx.from.first_name||'Friend'})}\n${t(lang,'welcome.subtitle')}`, homeKeyboard(lang));
  await ctx.reply(warm(t(lang,'journal.prompt')));
});

bot.command('id', (ctx)=>ctx.reply(String(ctx.from.id)));

bot.hears(/^🎯\s*Menu$/i, async (ctx)=>{
  const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
  const lang = user.language || FALLBACK_LANG;
  await ctx.reply(t(lang,'invite.text',{link:'https://t.me/EverGraceRabeBot'}) || 'Invite a friend: https://t.me/EverGraceRabeBot', menuInline(lang));
});

bot.hears(/^📒\s*.+/i, async (ctx)=>{ // Journal button
  const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
  const lang = user.language || FALLBACK_LANG;
  memory.set(ctx.chat.id, { mode:'journal' });
  await ctx.reply(warm(t(lang,'journal.prompt')), homeKeyboard(lang));
});

bot.hears(/^📌\s*.+/i, async (ctx)=>{ // Coach button
  const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
  const lang = user.language || FALLBACK_LANG;
  memory.set(ctx.chat.id, { mode:'coach' });
  await ctx.reply(t(lang,'coach.pick') || 'Pick a coaching style:', coachPicker(lang));
});

bot.hears(/^⚡\s*.+/i, async (ctx)=>{ // SOS button
  const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
  const lang = user.language || FALLBACK_LANG;
  memory.set(ctx.chat.id, { mode:'sos' });
  await ctx.reply(warm(t(lang,'sos.open')), homeKeyboard(lang));
  await ctx.reply(t(lang,'sos.tools'));
});

bot.hears(/^📊\s*.+/i, async (ctx)=>{ // Progress button
  const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
  const lang = user.language || FALLBACK_LANG;
  const rows = await recentNotes(user.id, 5);
  await ctx.reply(listBullets(lang, rows), homeKeyboard(lang));
});

bot.hears(/^🔗\s*.+/i, async (ctx)=>{ // Invite button
  const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
  const lang = user.language || FALLBACK_LANG;
  await ctx.reply(t(lang,'invite.text',{link:'https://t.me/EverGraceRabeBot'}) || 'Invite a friend: https://t.me/EverGraceRabeBot', homeKeyboard(lang));
});

// Inline: settings / language / coach mode / export
bot.action('SETTINGS_OPEN', async (ctx)=>{
  const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
  const lang = user.language || FALLBACK_LANG;
  await ctx.answerCbQuery();
  await ctx.reply(t(lang,'settings.title') || 'Settings', settingsKeyboard(lang));
});

bot.action('SETTINGS_LANG', async (ctx)=>{
  await ctx.answerCbQuery();
  await ctx.reply(t(FALLBACK_LANG,'settings.pick_lang') || 'Choose your language:', langPicker());
});

['en','it','de'].forEach(code=>{
  bot.action(`LANG_${code}`, async (ctx)=>{
    await setUserLanguage(ctx.from.id, code);
    await ctx.answerCbQuery('OK');
    await ctx.reply(t(code,'settings.lang_ok') || 'Language updated.', homeKeyboard(code));
  });
});

bot.action('SETTINGS_COACH', async (ctx)=>{
  const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
  const lang = user.language || FALLBACK_LANG;
  await ctx.answerCbQuery();
  await ctx.reply(t(lang,'coach.pick') || 'Pick a coaching style:', coachPicker(lang));
});

['friend','spiritual','goal'].forEach(mode=>{
  bot.action(`COACH_${mode}`, async (ctx)=>{
    const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
    const lang = user.language || FALLBACK_LANG;
    await setCoachMode(user.id, mode);
    const key = `coach.set_${mode}`;
    await ctx.answerCbQuery();
    await ctx.reply(t(lang,key) || `Coach set to ${mode}.`, homeKeyboard(lang));
  });
});

bot.action('EXPORT_TXT', async (ctx)=>{
  const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
  await ctx.answerCbQuery();
  const { data } = await supabase
    .from('notes').select('mode,text,created_at')
    .eq('user_id', user.id).order('created_at',{ascending:false}).limit(50);
  if (!data || !data.length) return ctx.reply('Nothing to export yet.');
  const lines = data.map(r=>`[${new Date(r.created_at).toISOString()}] ${r.mode.toUpperCase()}: ${r.text}`).join('\n');
  await ctx.replyWithDocument({ source: Buffer.from(lines,'utf8'), filename: `hith_${user.id}.txt` });
});

// Text capture (journal/coach/sos)
bot.on('text', async (ctx, next)=>{
  const state = memory.get(ctx.chat.id);
  if (!state) return next();
  const text = (ctx.message.text||'').trim();
  if (!text) return;

  const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
  const lang = user.language || FALLBACK_LANG;
  const mode = state.mode;

  try { await addNote(user.id, mode, text); } catch (e) { 
    console.error('[addNote]', e); 
    return ctx.reply(t(lang,'common.save_error') || 'Sorry, I couldn’t save. Please try again.');
  }
  try { await ensureCheckIn(user, mode); } catch {}

  if (mode==='journal')      await ctx.reply(warm(t(lang,'journal.saved')), homeKeyboard(lang));
  else if (mode==='sos')     await ctx.reply(warm(t(lang,'coach.escalate') || 'That sounds like a coach question — let’s explore it together.'), homeKeyboard(lang));
  else                       await ctx.reply(warm(t(lang,'coach.coach_intro') || 'Let’s talk. I’m here with you.'), homeKeyboard(lang));
});

// Admin
bot.command('give_freeze', async (ctx)=>{
  if (!isAdmin(ctx)) return ctx.reply('Not authorized.');
  const parts = (ctx.message.text||'').trim().split(/\s+/);
  const n = Number(parts[1]||'0');
  const target = parts[2] ? parts[2] : String(ctx.from.id);
  if (!Number.isFinite(n) || n<=0) return ctx.reply('Usage: /give_freeze <n> [userId]');
  const user = await getUser(target);
  if (!user) return ctx.reply('User not found.');
  const total = (user.freezes||0) + n;
  await supabase.from('users').update({ freezes: total, updated_at: new Date().toISOString() }).eq('id', target);
  await ctx.reply(`Granted ${n} freeze(s) to ${target}. Now: ${total}`);
});

bot.command('sos_counts', async (ctx)=>{
  if (!isAdmin(ctx)) return ctx.reply('Not authorized.');
  const flag = ((ctx.message.text||'').split(/\s+/)[1]||'').toLowerCase();
  if (!['on','off'].includes(flag)) return ctx.reply('Usage: /sos_counts on|off');
  const val = flag==='on';
  await supabase.from('users').update({ sos_counts: val }).eq('id', String(ctx.from.id));
  await ctx.reply(`SOS counts: ${val ? 'ON' : 'OFF'}`);
});

bot.command('streak', async (ctx)=>{
  const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
  const streak = user.streak_count||0;
  const freezes = user.freezes||0;
  const last = user.last_checkin || '—';
  await ctx.reply(`🔥 Streak: ${streak}\n❄️ Freezes: ${freezes}\n📅 Last: ${last}`, homeKeyboard(user.language||FALLBACK_LANG));
});

// Errors
bot.catch((err, ctx)=>{
  console.error('Bot error:', err);
  try { ctx.reply('Oops—qualcosa è andato storto. Riprova.'); } catch {}
});

// ─────────────────────────────────────────────────────────────
// 9) WhatsApp Cloud webhook (same brain)
const app = express();
app.use(express.json());

// healthcheck
app.get('/', (_req,res)=>res.status(200).send('HITH bot active.'));

// verify
const WA_VERIFY = process.env.WHATSAPP_VERIFY_TOKEN || '';
const WA_TOKEN  = process.env.WHATSAPP_TOKEN || '';
const WA_PHONE  = process.env.WHATSAPP_PHONE_ID || '';

app.get('/wa/webhook', (req,res)=>{
  const { ['hub.mode']:mode, ['hub.verify_token']:token, ['hub.challenge']:challenge } = req.query;
  if (mode==='subscribe' && token===WA_VERIFY) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

async function waSendText(to, text) {
  if (!WA_TOKEN || !WA_PHONE) return;
  try {
    await axios.post(
      `https://graph.facebook.com/v20.0/${WA_PHONE}/messages`,
      { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
      { headers: { Authorization:`Bearer ${WA_TOKEN}`, 'Content-Type':'application/json' } }
    );
  } catch (e) { console.error('[WA send]', e?.response?.data || e.message); }
}

app.post('/wa/webhook', async (req,res)=>{
  try {
    const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msg || msg.type!=='text') return res.sendStatus(200);
    const from = msg.from;
    const text = msg.text?.body || '';
    const fakeCtx = { from:{ id: from, first_name:'Friend', language_code:'en' }, chat:{ id: from } };

    const user = (await getUser(from)) || (await ensureUser(fakeCtx));
    const lang = user.language || FALLBACK_LANG;

    let mode = 'journal';
    const low = text.toLowerCase().trim();
    if (low==='sos' || /panic|help/.test(low)) mode = 'sos';
    else if (low==='coach') mode='coach';

    try { await addNote(user.id, mode, text); await ensureCheckIn(user, mode); } catch {}

    if (mode==='journal')      await waSendText(from, warm(t(lang,'journal.saved') || 'Saved. Want to add more?'));
    else if (mode==='sos') {   await waSendText(from, warm(t(lang,'sos.open'))); await waSendText(from, t(lang,'sos.tools')); }
    else                      await waSendText(from, warm(t(lang,'coach.coach_intro') || 'Let’s talk. I’m here with you.'));
  } catch (e) { console.error('[WA webhook]', e); }
  return res.sendStatus(200);
});

// ─────────────────────────────────────────────────────────────
// 10) Launch (Telegram long-poll + Express)
const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, ()=>console.log(`[web] listening on ${PORT}`));
bot.launch().then(()=>console.log('HITH (Telegram) running ✅'));

process.once('SIGINT', ()=>bot.stop('SIGINT'));
process.once('SIGTERM', ()=>bot.stop('SIGTERM'));

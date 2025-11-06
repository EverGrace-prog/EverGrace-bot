// index.js — HITH (EverGrace) bot — CommonJS

// 1) Env
require('dotenv').config();
const REQUIRED = ['BOT_TOKEN', 'SUPABASE_URL', 'SUPABASE_KEY'];
const missing = REQUIRED.filter(k => !process.env[k] || String(process.env[k]).trim() === '');
if (missing.length) {
  console.error('[Env] Missing:', missing.join(', '));
  process.exit(1);
}
console.log('[Env] OK:', REQUIRED.join(', '));

// 2) Imports
const { Telegraf, Markup } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');
const http = require('http');

// 3) Clients
const bot = new Telegraf(process.env.BOT_TOKEN);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 4) Render healthcheck
const PORT = Number(process.env.PORT || 10000);
http.createServer((_, res) => { res.writeHead(200, {'Content-Type':'text/plain'}); res.end('OK'); })
    .listen(PORT, () => console.log(`[hc] listening on ${PORT}`));

// 5) Locales
function loadLocales() {
  const dir = path.join(__dirname, 'locales');
  const L = {};
  for (const code of ['en','it','de']) {
    const fp = path.join(dir, `${code}.json`);
    if (fs.existsSync(fp)) L[code] = JSON.parse(fs.readFileSync(fp, 'utf8'));
  }
  return L;
}
const LOCALES = loadLocales();
const FALLBACK = 'en';

// 6) Helpers
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const SOS_COUNTS_DEFAULT = String(process.env.SOS_COUNTS || 'true').toLowerCase() !== 'false';

function t(lang, key, vars={}) {
  const find = (o, k) => k.split('.').reduce((a, c) => (a && a[c] != null ? a[c] : undefined), o);
  const str = find(LOCALES[lang], key) ?? find(LOCALES[FALLBACK], key) ?? key;
  return typeof str === 'string' ? str.replace(/\{(\w+)\}/g, (_,k)=> (vars[k]!=null?String(vars[k]):`{${k}}`)) : key;
}
function pickLang(ctx) {
  const code = (ctx.from.language_code||'').slice(0,2).toLowerCase();
  return LOCALES[code] ? code : FALLBACK;
}
const memory = new Map(); // chat_id -> { mode: 'journal'|'coach'|'sos' }

// 7) Menus
function mainMenu(lang='en') {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📒 Journal', 'MENU_JOURNAL'), Markup.button.callback('📊 Progress', 'MENU_PROGRESS')],
    [Markup.button.callback('📌 Coach', 'MENU_COACH'), Markup.button.callback('⚡ SOS', 'MENU_SOS')],
    [Markup.button.callback('🔗 Invite', 'MENU_INVITE'), Markup.button.callback(`⚙️ ${t(lang,'settings.title')}`, 'SETTINGS_OPEN')],
  ]);
}
function coachPicker(lang='en') {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(`🤝 ${t(lang,'coach.friend')}`, 'COACH_friend'),
      Markup.button.callback(`🕊️ ${t(lang,'coach.spiritual')}`, 'COACH_spiritual'),
      Markup.button.callback(`🎯 ${t(lang,'coach.goal')}`, 'COACH_goal'),
    ],
  ]);
}
function langPicker() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🇬🇧 English','LANG_en'), Markup.button.callback('🇮🇹 Italiano','LANG_it')],
    [Markup.button.callback('🇩🇪 Deutsch','LANG_de')],
  ]);
}
function settingsMenu(lang='en') {
  return Markup.inlineKeyboard([
    [Markup.button.callback(`🌐 ${t(lang,'settings.change_lang')}`, 'SETTINGS_LANG')],
    [Markup.button.callback(`🎯 ${t(lang,'settings.coach_mode')}`, 'SETTINGS_COACH')],
  ]);
}

// 8) DB helpers
async function ensureUser(ctx) {
  const id = ctx.from.id;
  const name = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ').trim() || null;
  const language = pickLang(ctx);

  const { data, error } = await supabase
    .from('users')
    .upsert({ id, name, language, updated_at: new Date().toISOString() }, { onConflict: 'id' })
    .select('*').single();

  if (error) {
    console.error('[ensureUser]', error);
    return { id, language, sos_counts:SOS_COUNTS_DEFAULT, freezes:0, streak_count:0 };
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
async function recentNotes(user_id, limit=5) {
  const { data } = await supabase
    .from('notes').select('id,mode,text,created_at')
    .eq('user_id', user_id).order('created_at',{ascending:false}).limit(limit);
  return data || [];
}
function bulletList(lang, rows) {
  if (!rows.length) return t(lang,'progress.empty');
  const bullets = rows.map(r=>{
    const d = new Date(r.created_at);
    const ts = d.toLocaleString('it-IT',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'});
    const icon = r.mode==='journal'?'📒':r.mode==='coach'?'📌':'⚡';
    return `• ${ts} — ${icon} ${r.text.split('\n')[0].slice(0,120)}`;
  }).join('\n');
  return `${t(lang,'progress.latest')}\n${bullets}`;
}

// streak helpers
const ymd = (d)=> new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString().slice(0,10);
const daysBetween = (a,b)=> Math.round((new Date(b+'T00:00:00Z')-new Date(a+'T00:00:00Z'))/86400000);

async function ensureCheckIn(user, source) {
  if (source==='sos' && user.sos_counts===false) return {updated:false};

  const today = ymd(new Date());
  const { data:exists } = await supabase
    .from('checkins').select('id').eq('user_id', user.id).eq('day', today).maybeSingle();
  if (exists && exists.id) return {updated:false};

  let streak = 1, freezes = user.freezes||0;
  if (user.last_checkin) {
    const gap = daysBetween(user.last_checkin, today);
    if (gap<=1) streak = (user.streak_count||0)+1;
    else if (gap===2 && freezes>0) { freezes -= 1; streak = (user.streak_count||0)+1; }
    else streak = 1;
  }
  await supabase.from('users').update({
    streak_count:streak, last_checkin:today, freezes, updated_at:new Date().toISOString()
  }).eq('id', user.id);
  await supabase.from('checkins').insert({ user_id:user.id, day:today, source });

  return {updated:true, streak, freezes};
}

// 9) Start / Menu
bot.start(async ctx => {
  const user = await ensureUser(ctx);
  const lang = user.language || FALLBACK;
  memory.set(ctx.chat.id, { mode: 'journal' });
  await ctx.reply(`${t(lang,'welcome.hello',{name:ctx.from.first_name||''})}\n${t(lang,'welcome.subtitle')}`, mainMenu(lang));
  await ctx.reply(t(lang,'journal.prompt'), { reply_markup: { remove_keyboard: true } });
});

bot.command('menu', async ctx => {
  const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
  const lang = user.language || FALLBACK;
  await ctx.reply('—', mainMenu(lang)); // tiny anchor to show inline menu
});

bot.command('id', ctx => ctx.reply(String(ctx.from.id)));

// 10) Inline actions (menu)
bot.action('MENU_INVITE', async ctx => {
  const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
  const lang = user.language || FALLBACK;
  await ctx.answerCbQuery();
  await ctx.reply(t(lang,'invite.text',{link:'https://t.me/EverGraceRabeBot'}), mainMenu(lang));
});

bot.action('MENU_PROGRESS', async ctx => {
  const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
  const lang = user.language || FALLBACK;
  const rows = await recentNotes(user.id, 5);
  await ctx.answerCbQuery();
  await ctx.reply(bulletList(lang, rows), mainMenu(lang));
});

bot.action('MENU_JOURNAL', async ctx => {
  const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
  const lang = user.language || FALLBACK;
  memory.set(ctx.chat.id, { mode:'journal' });
  await ctx.answerCbQuery();
  await ctx.reply(t(lang,'journal.prompt'), mainMenu(lang));
});

bot.action('MENU_COACH', async ctx => {
  const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
  const lang = user.language || FALLBACK;
  memory.set(ctx.chat.id, { mode:'coach' });
  await ctx.answerCbQuery();
  await ctx.reply(t(lang,'coach.pick'), coachPicker(lang));
});

bot.action('MENU_SOS', async ctx => {
  const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
  const lang = user.language || FALLBACK;
  memory.set(ctx.chat.id, { mode:'sos' });
  await ctx.answerCbQuery();
  await ctx.reply(t(lang,'sos.open'), mainMenu(lang));
  await ctx.reply(t(lang,'sos.tools'));
});

// 11) Settings
bot.action('SETTINGS_OPEN', async ctx => {
  const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
  const lang = user.language || FALLBACK;
  await ctx.answerCbQuery();
  await ctx.reply(t(lang,'settings.title'), settingsMenu(lang));
});
bot.action('SETTINGS_LANG', async ctx => {
  await ctx.answerCbQuery();
  await ctx.reply(t(FALLBACK,'settings.pick_lang'), langPicker());
});
for (const code of ['en','it','de']) {
  bot.action(`LANG_${code}`, async ctx => {
    await setUserLanguage(ctx.from.id, code);
    await ctx.answerCbQuery('OK');
    await ctx.reply(t(code,'settings.lang_ok'), mainMenu(code));
  });
}
bot.action('SETTINGS_COACH', async ctx => {
  const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
  const lang = user.language || FALLBACK;
  await ctx.answerCbQuery();
  await ctx.reply(t(lang,'coach.pick'), coachPicker(lang));
});
for (const mode of ['friend','spiritual','goal']) {
  bot.action(`COACH_${mode}`, async ctx => {
    const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
    const lang = user.language || FALLBACK;
    await setCoachMode(user.id, mode);
    await ctx.answerCbQuery();
    await ctx.reply(t(lang, `coach.set_${mode}`), mainMenu(lang));
  });
}

// 12) Free-form text capture
bot.on('text', async (ctx, next) => {
  const state = memory.get(ctx.chat.id);
  if (!state) return next();

  const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
  const lang = user.language || FALLBACK;
  const mode = state.mode;
  const text = (ctx.message.text || '').trim();
  if (!text) return;

  try { await addNote(user.id, mode, text); }
  catch { return ctx.reply(t(lang,'common.save_error')); }

  try { await ensureCheckIn(user, mode); } catch {}

  if (mode === 'journal') {
    await ctx.reply(t(lang,'journal.saved'), mainMenu(lang));
  } else if (mode === 'sos') {
    await ctx.reply(t(lang,'coach.escalate'), mainMenu(lang));
  } else {
    await ctx.reply(t(lang,'coach.coach_intro'), mainMenu(lang));
  }
});

// 13) Admin
const isAdmin = (ctx) => ADMIN_IDS.includes(String(ctx.from.id));

bot.command('give_freeze', async ctx => {
  if (!isAdmin(ctx)) return ctx.reply('Not authorized.');
  const [_, nStr, idStr] = (ctx.message.text||'').trim().split(/\s+/);
  const n = Number(nStr); const target = idStr ? Number(idStr) : Number(ctx.from.id);
  if (!Number.isFinite(n) || n<=0) return ctx.reply('Usage: /give_freeze <n> [userId]');
  const user = await getUser(target); if (!user) return ctx.reply('User not found.');
  await supabase.from('users').update({ freezes:(user.freezes||0)+n, updated_at:new Date().toISOString() }).eq('id', target);
  await ctx.reply(`Granted ${n} freeze(s) to ${target}.`);
});

bot.command('sos_counts', async ctx => {
  if (!isAdmin(ctx)) return ctx.reply('Not authorized.');
  const flag = ((ctx.message.text||'').split(/\s+/)[1]||'').toLowerCase();
  if (!['on','off'].includes(flag)) return ctx.reply('Usage: /sos_counts on|off');
  await supabase.from('users').update({ sos_counts: flag==='on' }).eq('id', ctx.from.id);
  await ctx.reply(`SOS counts: ${flag.toUpperCase()}`);
});

bot.command('streak', async ctx => {
  const user = (await getUser(ctx.from.id)) || (await ensureUser(ctx));
  const streak = user.streak_count||0, freezes=user.freezes||0, last=user.last_checkin||'—';
  const today = new Date(); const days=[];
  for (let i=6;i>=0;i--) days.push(ymd(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()-i))));
  const { data } = await supabase.from('checkins').select('day').eq('user_id', user.id).gte('day', days[0]).lte('day', days[6]);
  const set = new Set((data||[]).map(r=>r.day)); const bar = days.map(d=> set.has(d)?'🟩':'⬜️').join('');
  await ctx.reply(`🔥 Streak: ${streak}\n❄️ Freezes: ${freezes}\n📅 Last: ${last}\n${bar}`, mainMenu(user.language||FALLBACK));
});

// 14) Errors & launch
bot.catch((err, ctx) => { console.error('Bot error', err); try{ctx.reply('Oops, qualcosa è andato storto. Riprova.');}catch{}; });
bot.launch().then(()=>console.log('HITH bot running ✅'));
process.once('SIGINT', ()=>bot.stop('SIGINT'));
process.once('SIGTERM', ()=>bot.stop('SIGTERM'));

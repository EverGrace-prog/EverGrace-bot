// EverGrace — Telegram bot by RABE (Coach + Conversational + Supabase)
// Avvio: npm run start  |  Node 18+ (ESM)

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { Telegraf, Markup } from 'telegraf';
import OpenAI from 'openai';
import { createClient } from '@supabase/supabase-js';

/* ========== ENV ========== */
const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

if (!BOT_TOKEN) throw new Error('Missing BOT_TOKEN');
if (!OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY');
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE');

/* ========== CLIENTS ========== */
const bot = new Telegraf(BOT_TOKEN);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);
console.log(`[sb] Supabase → ${SUPABASE_URL}`);

/* ========== COSTANTI UI / ASSET ========== */
const BRAND_CARD = path.resolve('rabe_bg.jpg'); // opzionale
const brandSentThisRun = new Set(); // per-utente-per-processo

const SUPPORT_LINKS = {
  DIAMOND: { label: '💎 Diamond — €9', url: 'https://buy.stripe.com/test_7sYcN52SX1S029906kbwk04' },
  GOLD:    { label: '🥇 Gold — €5',    url: 'https://buy.stripe.com/test_00waEX1OT8go0117yMbwk05' },
  SILVER:  { label: '🥈 Silver — €2',  url: 'https://buy.stripe.com/test_cNifZh3X154c1551aobwk06' },
};

const bottomBar = () => Markup.keyboard([['🏠 Menu', '🆘 SOS', '💠 Support']]).resize();
const mainMenu = (lang='en', chatOn=true) => {
  const on  = lang==='it' ? '💬 Chat ON' : lang==='de' ? '💬 Chat AN'  : '💬 Chat ON';
  const off = lang==='it' ? '🤫 Chat OFF': lang==='de' ? '🤫 Chat AUS' : '🤫 Chat OFF';
  return Markup.keyboard([
    ['🌐 Language', '🎯 Goal'],
    [chatOn ? off : on, '📖 Diary'],
    ['🏠 Back']
  ]).resize();
};
const langPicker = () => Markup.keyboard([['English','Italiano','Deutsch'],['🏠 Back']]).resize();
const diaryMenu  = () => Markup.keyboard([['📝 New entry','📚 Browse entries'],['🏠 Back']]).resize();

/* ========== UTILS ========== */
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));
const isoDate = (d=new Date()) => new Date(d).toISOString().slice(0,10);

function buildSystemPrompt(u) {
  const name   = u?.name || '';
  const goal   = u?.goal || '';
  const why    = u?.goal_why || '';
  const streak = u?.streak ?? 0;
  return `
You are EverGrace — a warm, emotionally intelligent companion & gentle coach (by RABE).
Listen first, reflect briefly, then offer up to 3 clear, doable next steps.
Mirror user's language; default English. Be concise and natural.
If user uses emojis, mirror 1–2 lightly. Validate feelings before advising.

Known:
- Name: ${name || '—'}
- Goal: ${goal || '—'}
- Why: ${why || '—'}
- Streak: ${streak} day(s)

Rules:
- Ask clarifying questions only when useful.
- Avoid medical/legal/financial claims; nudge professional help when appropriate.
- Conversational tone over encyclopedic answers.
`.trim();
}

/* ========== SUPABASE HELPERS ========== */
// Usa Telegram user id come PK (colonna id BIGINT)
async function getOrCreateUser(ctx){
  const id = Number(ctx.from?.id);
  const name = ctx.from?.first_name || 'Friend';
  const lang = ['en','it','de'].includes(ctx.from?.language_code) ? ctx.from.language_code : 'en';

  let { data:u } = await supabase.from('users').select('*').eq('id', id).single();
  if (!u) {
    const insert = { id, name, language: lang, chat_enabled: true, notes: [], diary: [], history: [] };
    const { data:created, error } = await supabase.from('users').insert(insert).select('*').single();
    if (error) throw error;
    u = created;
  }
  return u;
}

async function updateUser(id, patch){
  patch.updated_at = new Date().toISOString();
  const { data, error } = await supabase.from('users').update(patch).eq('id', id).select('*').single();
  if (error) throw error;
  return data;
}

// diary append atomico via RPC con fallback
async function diaryAppendAtomic(userId, text){
  const { error: rpcErr } = await supabase.rpc('append_diary', { p_id: userId, p_text: text });
  if (!rpcErr) return;
  console.warn('[sb] append_diary RPC failed, fallback →', rpcErr.message || rpcErr);
  // fallback sicuro RMW
  const { data: row, error: readErr } = await supabase.from('users').select('diary').eq('id', userId).single();
  if (readErr) throw readErr;
  const diary = Array.isArray(row?.diary) ? row.diary : [];
  diary.push({ date: isoDate(), text });
  const { error: updErr } = await supabase.from('users').update({ diary, updated_at: new Date().toISOString() }).eq('id', userId);
  if (updErr) throw updErr;
}

// history + summary (tollerante se history_summary manca)
async function fetchHistoryAndSummary(userId){
  let history = [], summary = '';
  // prova a leggere entrambe
  let res = await supabase.from('users').select('history,history_summary').eq('id', userId).single();
  if (res.error && String(res.error.message||'').includes('column "history_summary"')) {
    // colonna non esiste → rileggi solo history
    const r2 = await supabase.from('users').select('history').eq('id', userId).single();
    history = Array.isArray(r2.data?.history) ? r2.data.history : [];
  } else {
    history = Array.isArray(res.data?.history) ? res.data.history : [];
    summary = res.data?.history_summary || '';
  }
  return { history, summary };
}

async function saveTurn(userId, role, content){
  const { data } = await supabase.from('users').select('history').eq('id', userId).single();
  const history = Array.isArray(data?.history) ? data.history : [];
  history.push({ role, content, ts: Date.now() });
  const pruned = history.slice(-200);
  await supabase.from('users').update({ history: pruned, updated_at: new Date().toISOString() }).eq('id', userId);
}

async function maybeSummarize(userId){
  const { history } = await fetchHistoryAndSummary(userId);
  if (history.length % 12 !== 0) return;
  const transcript = history.slice(-60).map(t => `${t.role==='user'?'User':'EverGrace'}: ${t.content}`).join('\n');
  try {
    const r = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.3,
      messages: [
        { role:'system', content: 'Summarize key preferences, goals, decisions, concerns. <=120 words.' },
        { role:'user',   content: transcript }
      ]
    });
    const summary = r.choices?.[0]?.message?.content?.trim() || '';
    if (!summary) return;
    // aggiorna summary se la colonna esiste, altrimenti ignora
    const { error } = await supabase.from('users').update({ history_summary: summary, updated_at: new Date().toISOString() }).eq('id', userId);
    if (error && String(error.message||'').includes('column "history_summary"')) {
      // ignora: la colonna non esiste
    }
  } catch {}
}

/* ========== LLM HELPERS ========== */
async function buildMessagesForLLM(userRow, userText){
  const { history, summary } = await fetchHistoryAndSummary(userRow.id);
  const lastTurns = history.slice(-12);
  const msgs = [{ role:'system', content: buildSystemPrompt(userRow) }];
  if (summary) msgs.push({ role:'system', content: `Conversation so far (summary): ${summary}` });
  for (const t of lastTurns) if (t?.role && t?.content) msgs.push({ role: t.role, content: t.content });
  msgs.push({ role:'user', content: userText });
  return msgs;
}

async function askLLM(messages){
  try {
    const r = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.75,
      top_p: 0.95,
      presence_penalty: 0.35,
      max_tokens: 450,
      messages
    });
    const txt = r.choices?.[0]?.message?.content?.trim();
    if (txt) return txt;
    throw new Error('empty');
  } catch {
    const r2 = await openai.chat.completions.create({
      model: 'gpt-4o',
      temperature: 0.75,
      top_p: 0.95,
      presence_penalty: 0.35,
      max_tokens: 450,
      messages
    });
    return r2.choices?.[0]?.message?.content?.trim() || 'Sorry, a small hiccup—could you repeat?';
  }
}

/* ========== BRAND CARD ========== */
async function sendBrandCardOnce(ctx, userId){
  if (!fs.existsSync(BRAND_CARD)) return;
  const key = String(userId);
  if (brandSentThisRun.has(key)) return;
  brandSentThisRun.add(key);
  try { await ctx.replyWithPhoto({ source: BRAND_CARD }); } catch {}
}

/* ========== STATO EPHEMERAL ========== */
const state = new Map(); // userId -> { expect: 'goal'|'why'|'diary' }

/* ========== SOS (chiedi prima) ========== */
async function handleSOS(ctx, u){
  const footer = [
    "If you are in immediate danger, call your local emergency number.",
    "🚨 112 (EU) | 911 (US/Canada)",
    "🇮🇹 Samaritans: 06 77208977",
    "🌐 findahelpline.com"
  ].join('\n');
  await ctx.reply("Hi 👋 How can I help you right now?\n\n" + footer, bottomBar());
}

/* ========== GOAL (coachy breve) ========== */
async function askGoal(ctx){ await ctx.reply("🎯 What’s one thing you want to achieve this month? One clear sentence."); }
async function askWhy(ctx){  await ctx.reply("Beautiful. Why is this important to you (one line)?"); }

/* ========== DIARY ========== */
async function openDiary(ctx, u){
  await sendBrandCardOnce(ctx, u.id);
  await ctx.reply("Diary: choose an option.", diaryMenu());
}
async function browseDiary(ctx, u){
  const { data } = await supabase.from('users').select('diary').eq('id', u.id).single();
  const d = Array.isArray(data?.diary) ? data.diary : [];
  if (!d.length) return ctx.reply("Your diary is empty. Tap “New entry” to add one.", diaryMenu());
  const last = d.slice(-5).reverse();
  const msg = last.map(e => `📅 ${e.date}\n${e.text}`).join('\n\n');
  await ctx.reply(msg, diaryMenu());
}

/* ========== FREE CHAT ========== */
async function handleFreeChat(ctx, u){
  const text = (ctx.message?.text || '').trim();
  if (!text) return;
  await saveTurn(u.id, 'user', text);
  const messages = await buildMessagesForLLM(u, text);
  const reply = await askLLM(messages);
  await ctx.reply(reply, bottomBar());
  await saveTurn(u.id, 'assistant', reply);
  await maybeSummarize(u.id);
}

/* ========== HANDLERS ========== */
// /start
bot.start(async (ctx)=>{
  const u = await getOrCreateUser(ctx);
  await ctx.reply("Hi! I’m EverGrace — your gentle coach & companion. How can I help today? 🙂", bottomBar());
});

// bar
bot.hears('🏠 Menu',  async (ctx)=>{ const u=await getOrCreateUser(ctx); await ctx.reply("Here’s your menu:", mainMenu(u.language, !!u.chat_enabled)); });
bot.hears('🆘 SOS',   async (ctx)=>{ const u=await getOrCreateUser(ctx); await handleSOS(ctx, u); });
bot.hears('💠 Support', async (ctx)=>{
  await ctx.reply("Thank you for supporting EverGrace 💛", Markup.inlineKeyboard([
    [Markup.button.url(SUPPORT_LINKS.DIAMOND.label, SUPPORT_LINKS.DIAMOND.url)],
    [Markup.button.url(SUPPORT_LINKS.GOLD.label,    SUPPORT_LINKS.GOLD.url)],
    [Markup.button.url(SUPPORT_LINKS.SILVER.label,  SUPPORT_LINKS.SILVER.url)]
  ]));
});

// menu
bot.hears('🏠 Back', async (ctx)=>{ await ctx.reply("Menu ready.", bottomBar()); });

bot.hears('🌐 Language', async (ctx)=>{ await ctx.reply("Choose your language:", langPicker()); });
bot.hears('English',  async (ctx)=>{ const u=await getOrCreateUser(ctx); await updateUser(u.id,{language:'en'}); await ctx.reply("Language updated ✅", mainMenu('en', u.chat_enabled)); });
bot.hears('Italiano', async (ctx)=>{ const u=await getOrCreateUser(ctx); await updateUser(u.id,{language:'it'}); await ctx.reply("Lingua aggiornata ✅", mainMenu('it', u.chat_enabled)); });
bot.hears('Deutsch',  async (ctx)=>{ const u=await getOrCreateUser(ctx); await updateUser(u.id,{language:'de'}); await ctx.reply("Sprache aktualisiert ✅", mainMenu('de', u.chat_enabled)); });

bot.hears('🎯 Goal', async (ctx)=>{ const u=await getOrCreateUser(ctx); state.set(u.id,{expect:'goal'}); await askGoal(ctx); });

bot.hears('📖 Diary', async (ctx)=>{ const u=await getOrCreateUser(ctx); await openDiary(ctx,u); });
bot.hears('📝 New entry', async (ctx)=>{ const u=await getOrCreateUser(ctx); state.set(u.id,{expect:'diary'}); await ctx.reply("Okay — send your text. I’ll save it with today’s date."); });
bot.hears('📚 Browse entries', async (ctx)=>{ const u=await getOrCreateUser(ctx); await browseDiary(ctx,u); });

bot.hears('💬 Chat ON', async (ctx)=>{ const u=await getOrCreateUser(ctx); const up=await updateUser(u.id,{chat_enabled:true}); await ctx.reply("Conversation mode is ON. Talk to me freely.", mainMenu(up.language,true)); });
bot.hears('🤫 Chat OFF',async (ctx)=>{ const u=await getOrCreateUser(ctx); const up=await updateUser(u.id,{chat_enabled:false});await ctx.reply("I’ll stay quiet. Tap Chat ON when you want me back.", mainMenu(up.language,false)); });

// text router (goal/why/diary + free chat)
bot.on('text', async (ctx)=>{
  const u = await getOrCreateUser(ctx);
  const txt = (ctx.message?.text || '').trim();
  const st = state.get(u.id);

  if (st?.expect === 'goal') {
    await updateUser(u.id,{ goal: txt.slice(0,200) });
    state.set(u.id,{expect:'why'});
    return askWhy(ctx);
  }
  if (st?.expect === 'why') {
    await updateUser(u.id,{ goal_why: txt.slice(0,300) });
    state.delete(u.id);
    return ctx.reply("Saved ✅ I’ll keep this in mind while we work together. 🌟", bottomBar());
  }
  if (st?.expect === 'diary') {
    await diaryAppendAtomic(u.id, txt);
    state.delete(u.id);
    return ctx.reply(`Saved in your diary 📝 (${isoDate()}).`, diaryMenu());
  }

  if (u.chat_enabled) return handleFreeChat(ctx, u);
  return ctx.reply("Chat is OFF. Tap 🏠 Menu to enable Chat ON or use tools.", bottomBar());
});

/* ========== AVVIO ROBUSTO CON RETRY ========== */
const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN || '';
const WEBHOOK_PATH   = process.env.WEBHOOK_PATH   || '/webhook';
const PORT           = process.env.PORT ? Number(process.env.PORT) : 3000;

async function startBotOnce(){
  console.log(`[sb] ready • ${SUPABASE_URL}`);
  const me = await bot.telegram.getMe();
  console.log(`Boot OK • @${me.username}`);

  if (WEBHOOK_DOMAIN) {
    const url = `${WEBHOOK_DOMAIN}${WEBHOOK_PATH}`;
    await bot.telegram.setWebhook(url);
    bot.startWebhook(WEBHOOK_PATH, null, PORT);
    console.log(`Webhook set at ${url} (port ${PORT})`);
  } else {
    await bot.launch();
    console.log('Grace bot started in long polling mode');
  }
}
async function startBotWithRetry(max=3){
  for (let i=1;i<=max;i++){
    try { await startBotOnce(); return; }
    catch (e) {
      console.error(`[boot] Attempt ${i} failed:`, e?.message||e);
      if (i===max) throw e;
      const w=2000*i; console.log(`[boot] Retrying in ${w} ms...`); await sleep(w);
    }
  }
}
startBotWithRetry(3).catch(()=>{});
process.once('SIGINT', ()=>bot.stop('SIGINT'));
process.once('SIGTERM',()=>bot.stop('SIGTERM'));

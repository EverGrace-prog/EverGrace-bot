// index.js — EverGrace by RABE (Supabase + Diary RPC + Modes + SOS + Retry)

import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import fs from 'fs';
import fse from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch';

/* ---------- ENV ---------- */
const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN || '';
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/webhook';
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

if (!BOT_TOKEN) throw new Error('Missing BOT_TOKEN');
if (!OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY');

/* ---------- PATHS ---------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const USERS_JSON = path.join(__dirname, 'users.json');
const BRAND_CARD = path.join(__dirname, 'rabe_bg.jpg'); // opzionale

/* ---------- CLIENTS ---------- */
const bot = new Telegraf(BOT_TOKEN);
const supabase = (SUPABASE_URL && SUPABASE_SERVICE_ROLE)
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession:false } })
  : null;

if (supabase) console.log(`[sb] ready → ${SUPABASE_URL}`);
else console.log('[sb] not configured — local users.json fallback will be used');

/* ---------- OPENAI (REST) ---------- */
const OAI_URL = 'https://api.openai.com/v1/chat/completions';
async function openaiChat({ messages, model = OPENAI_MODEL, temperature = 0.7 }) {
  async function call(m){
    const res = await fetch(OAI_URL, {
      method:'POST',
      headers:{
        'Authorization':`Bearer ${OPENAI_API_KEY}`,
        'Content-Type':'application/json'
      },
      body: JSON.stringify({ model:m, messages, temperature })
    });
    if (!res.ok) throw new Error(`[openai:${m}] ${res.status} ${await res.text()}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content?.trim() || '';
  }
  try { return await call(model); }
  catch(e){
    if (model !== 'gpt-4o') return await call('gpt-4o'); // fallback
    throw e;
  }
}

/* ---------- LOCAL FALLBACK STORE ---------- */
let localUsers = {};
if (fs.existsSync(USERS_JSON)) {
  try { localUsers = JSON.parse(fs.readFileSync(USERS_JSON,'utf-8')); } catch {}
}
function saveLocal(){ try { fse.writeJSONSync(USERS_JSON, localUsers, { spaces:2 }); } catch {} }

/* ---------- UI HELPERS ---------- */
const bottomBar = () => Markup.keyboard([['🏠 Menu','🆘 SOS','💎 Support']]).resize();
const menuInline = (u) => Markup.inlineKeyboard([
  [Markup.button.callback('🌐 Language', 'menu_lang'),
   Markup.button.callback(u.chat_enabled ? '🤫 Chat OFF' : '💬 Chat ON', 'menu_chat')],
  [Markup.button.callback('📖 Diary', 'menu_diary'),
   Markup.button.callback('🧭 Mode', 'menu_mode')],
  [Markup.button.callback('⬅️ Close', 'menu_close')]
]);
const langPicker = Markup.inlineKeyboard([
  [Markup.button.callback('English','lang_en')],
  [Markup.button.callback('Italiano','lang_it')],
  [Markup.button.callback('Deutsch','lang_de')],
  [Markup.button.callback('⬅️ Back','menu_back')]
]);
const diaryInline = Markup.inlineKeyboard([
  [Markup.button.callback('📝 New entry','diary_new')],
  [Markup.button.callback('📚 Browse entries','diary_browse')],
  [Markup.button.callback('⬅️ Back','menu_back')]
]);
const modePicker = (u) => Markup.inlineKeyboard([
  [Markup.button.callback(u.mode==='friend'?'🤝 Friend • On':'🤝 Friend','mode_friend')],
  [Markup.button.callback(u.mode==='spiritual'?'✨ Spiritual • On':'✨ Spiritual','mode_spiritual')],
  [Markup.button.callback(u.mode==='coach'?'🎯 Coach & Goals • On':'🎯 Coach & Goals','mode_coach')],
  [Markup.button.callback('⬅️ Back','menu_back')]
]);
const SUPPORT_LINKS = {
  DIAMOND: { label:'💎 Diamond — €9', url:'https://buy.stripe.com/test_7sYcN52SX1S029906kbwk04' },
  GOLD:    { label:'🥇 Gold — €5',    url:'https://buy.stripe.com/test_00waEX1OT8go0117yMbwk05' },
  SILVER:  { label:'🥈 Silver — €2',  url:'https://buy.stripe.com/test_cNifZh3X154c1551aobwk06' },
};
const supportInline = Markup.inlineKeyboard([
  [Markup.button.url(SUPPORT_LINKS.DIAMOND.label, SUPPORT_LINKS.DIAMOND.url)],
  [Markup.button.url(SUPPORT_LINKS.GOLD.label,    SUPPORT_LINKS.GOLD.url)],
  [Markup.button.url(SUPPORT_LINKS.SILVER.label,  SUPPORT_LINKS.SILVER.url)],
  [Markup.button.callback('⬅️ Close','menu_close')]
]);

/* ---------- STATE (ephemeral) ---------- */
const brandSentThisRun = new Set(); // by chat id
const composeState = new Map();     // userId -> { expect: 'diary' }

/* ---------- UTILS ---------- */
const isoDate = (d=new Date()) => new Date(d).toISOString().slice(0,10);
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

function toneSystemPrompt(u){
  if (u.mode === 'spiritual') return 'You are EverGrace, a gentle spiritual guide. Warm, reflective, short paragraphs, compassionate. Avoid medical/legal claims.';
  if (u.mode === 'coach')     return 'You are EverGrace, a pragmatic coach. Friendly, energetic, propose up to 3 tiny next steps, ask one powerful question.';
  return 'You are EverGrace, a kind friend. Be warm, validating, conversational, concise. Use occasional emojis, not too many.';
}
function emergencyFooter(u){
  const L = u.language || 'en';
  const map = {
    en: `If you're in immediate danger, call **112** or **911**.\n🇮🇹 Samaritans: 06 77208977\n🌐 findahelpline.com`,
    it: `Se sei in pericolo immediato, chiama **112** o **911**.\n🇮🇹 Samaritans: 06 77208977\n🌐 findahelpline.com`,
    de: `Bei akuter Gefahr rufe **112** oder **911**.\n🇮🇹 Samaritans: 06 77208977\n🌐 findahelpline.com`,
  };
  return map[L] || map.en;
}

/* ---------- DATA LAYER ---------- */
async function getUser(id){
  if (supabase){
    try {
      const { data, error } = await supabase.from('users').select('*').eq('id', id).single();
      if (error && error.code!=='PGRST116') throw error;
      if (data) return data;
    } catch (e){ console.error('[sb] get error:', e.message||e); }
  }
  return localUsers[id] || null;
}
async function upsertUser(u){
  if (supabase){
    try {
      const { error } = await supabase.from('users').upsert(u, { onConflict:'id' });
      if (error) throw error;
      return;
    } catch (e){ console.error('[sb] upsert error:', e.message||e); }
  }
  localUsers[u.id] = { ...(localUsers[u.id]||{}), ...u };
  saveLocal();
}
async function updateUserPatch(id, patch){
  patch.updated_at = new Date().toISOString();
  if (supabase){
    try {
      const { error } = await supabase.from('users').update(patch).eq('id', id);
      if (error) throw error;
      return;
    } catch (e){ console.error('[sb] update error:', e.message||e); }
  }
  localUsers[id] = { ...(localUsers[id]||{}), ...patch };
  saveLocal();
}
async function getOrCreateUser(ctx){
  const id = String(ctx.from.id);
  let u = await getUser(id);
  if (!u){
    const lang = ctx.from.language_code?.startsWith('it') ? 'it'
               : ctx.from.language_code?.startsWith('de') ? 'de' : 'en';
    u = {
      id,
      language: lang,
      name: ctx.from.first_name || '',
      goal: '',
      goal_why: '',
      chat_enabled: true,
      mode: 'friend',   // friend | spiritual | coach
      streak: 0, wins: 0,
      diary: [],
      history: [],
      notes: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    await upsertUser(u);
  }
  return u;
}

/* ---------- DIARY ATOMIC (RPC + fallback) ---------- */
async function diaryAppendAtomic(userId, text){
  if (supabase){
    const { error } = await supabase.rpc('append_diary', { p_id: Number(userId), p_text: text });
    if (!error) return;
    console.warn('[sb] append_diary RPC failed → fallback:', error?.message||error);
  }
  // fallback RMW
  const u = await getUser(userId);
  const diary = Array.isArray(u?.diary) ? u.diary : [];
  diary.push({ date: isoDate(), text });
  await updateUserPatch(userId, { diary });
}

/* ---------- BRAND CARD ---------- */
async function sendBrandCardOnce(ctx, userId){
  if (!fs.existsSync(BRAND_CARD)) return;
  const key = String(userId);
  if (brandSentThisRun.has(key)) return;
  brandSentThisRun.add(key);
  try { await ctx.replyWithPhoto({ source: BRAND_CARD }); } catch {}
}

/* ---------- CHAT FLOW ---------- */
async function buildMessages(u, userText){
  const last = (u.history || []).slice(-8);
  const histMsgs = last.flatMap(h => ([
    { role:'user', content: h.user },
    { role:'assistant', content: h.assistant }
  ]));
  return [{ role:'system', content: toneSystemPrompt(u) }, ...histMsgs, { role:'user', content: userText }];
}
async function chatReply(ctx, u, text){
  const messages = await buildMessages(u, text);
  const reply = await openaiChat({ messages, temperature: 0.75 }).catch(()=>
    u.language==='it' ? 'Scusa, non riesco a rispondere ora.' :
    u.language==='de' ? 'Sorry, ich kann gerade nicht antworten.' :
                        'Sorry, I can’t reply right now.'
  );
  // save short history
  const hist = [...(u.history||[]), { user:text, assistant:reply }].slice(-12);
  await updateUserPatch(u.id, { history: hist });
  await ctx.reply(reply, bottomBar());
}

/* ---------- COMMANDS ---------- */
bot.start(async (ctx)=>{
  const u = await getOrCreateUser(ctx);
  const hi = u.language==='it' ? `Ciao ${u.name||''}! Sono EverGrace. Come posso aiutarti oggi?`
          : u.language==='de' ? `Hallo ${u.name||''}! Ich bin EverGrace. Wie kann ich dir heute helfen?`
                              : `Hi ${u.name||''}! I’m EverGrace. How can I help you today? 😊`;
  await ctx.reply(hi, bottomBar());
  await ctx.reply(u.language==='it'?'Apri il menu per le impostazioni rapide:'
               : u.language==='de'?'Öffne das Menü für schnelle Einstellungen:'
                                   :'Open the menu for quick settings:', menuInline(u));
});

bot.hears(['🏠 Menu','Menu','/menu'], async (ctx)=>{
  const u = await getOrCreateUser(ctx);
  await ctx.reply(u.language==='it'?'Menu:':u.language==='de'?'Menü:':'Menu:', menuInline(u));
});

bot.hears(['🆘 SOS','SOS','/sos'], async (ctx)=>{
  const u = await getOrCreateUser(ctx);
  const prompt = u.language==='it' ? 'Dimmi in poche parole: come posso aiutarti adesso?'
               : u.language==='de' ? 'Sag mir kurz: Wie kann ich dir jetzt helfen?'
                                   : 'In a few words: how can I help right now?';
  await ctx.reply(`🆘 ${prompt}`, bottomBar());
  await ctx.reply(emergencyFooter(u), { disable_web_page_preview: true });
});

bot.hears(['💎 Support','Support','/support'], async (ctx)=>{
  const u = await getOrCreateUser(ctx);
  const txt = u.language==='it' ? 'Grazie per il tuo supporto! Scegli un’opzione:'
            : u.language==='de' ? 'Danke für deine Unterstützung! Wähle eine Option:'
                                : 'Thank you for your support! Choose an option:';
  await ctx.reply(txt, supportInline);
});

/* ---------- INLINE MENU ACTIONS ---------- */
bot.action('menu_lang', async (ctx)=>{
  const u = await getOrCreateUser(ctx);
  await ctx.editMessageText(u.language==='it'?'Scegli la lingua:'
                          :u.language==='de'?'Sprache wählen:'
                                             :'Choose your language:', langPicker);
});
bot.action('lang_en', async (ctx)=>{ const u=await getOrCreateUser(ctx); await updateUserPatch(u.id,{language:'en'}); await ctx.answerCbQuery('Language updated ✅'); await ctx.editMessageReplyMarkup(menuInline({...u,language:'en'}).reply_markup); });
bot.action('lang_it', async (ctx)=>{ const u=await getOrCreateUser(ctx); await updateUserPatch(u.id,{language:'it'}); await ctx.answerCbQuery('Lingua aggiornata ✅'); await ctx.editMessageReplyMarkup(menuInline({...u,language:'it'}).reply_markup); });
bot.action('lang_de', async (ctx)=>{ const u=await getOrCreateUser(ctx); await updateUserPatch(u.id,{language:'de'}); await ctx.answerCbQuery('Sprache aktualisiert ✅'); await ctx.editMessageReplyMarkup(menuInline({...u,language:'de'}).reply_markup); });

bot.action('menu_chat', async (ctx)=>{
  const u = await getOrCreateUser(ctx);
  const next = !u.chat_enabled;
  await updateUserPatch(u.id, { chat_enabled: next });
  await ctx.answerCbQuery(next?'Chat ON':'Chat OFF');
  await ctx.reply(next
    ? (u.language==='it'?'💬 Conversazione attiva. Parlami liberamente.'
       :u.language==='de'?'💬 Konversation aktiv. Sprich frei mit mir.'
                          :'💬 Conversation is ON. Talk to me freely.')
    : (u.language==='it'?'🤫 Chat OFF. Nessuna risposta automatica.'
       :u.language==='de'?'🤫 Chat OFF. Keine automatische Antwort.'
                          :'🤫 Chat OFF. I won’t reply automatically.')
  );
  await ctx.editMessageReplyMarkup(menuInline({...u,chat_enabled:next}).reply_markup);
});

bot.action('menu_diary', async (ctx)=>{
  const u = await getOrCreateUser(ctx);
  await sendBrandCardOnce(ctx, u.id);
  const title = u.language==='it'?'Diario':u.language==='de'?'Tagebuch':'Diary';
  await ctx.editMessageText(`${title}:`, diaryInline);
});

bot.action('diary_new', async (ctx)=>{
  const u = await getOrCreateUser(ctx);
  composeState.set(u.id, { expect:'diary' });
  const ask = u.language==='it' ? 'Scrivi la tua nuova pagina di diario. Quando hai finito, invia il testo.'
           : u.language==='de' ? 'Schreibe deinen neuen Tagebucheintrag. Sende den Text, wenn du fertig bist.'
                               : 'Write your new diary entry. Send your text when done.';
  await ctx.answerCbQuery();
  await ctx.reply(ask, bottomBar());
});

bot.action('diary_browse', async (ctx)=>{
  const u = await getOrCreateUser(ctx);
  const entries = u.diary || [];
  if (!entries.length){
    const none = u.language==='it'?'Nessuna pagina di diario salvata (ancora).'
               : u.language==='de'?'Noch keine Tagebuchseiten gespeichert.'
                                  :'No diary entries saved (yet).';
    await ctx.answerCbQuery();
    return ctx.reply(none);
  }
  let txt = u.language==='it'?'📚 Diario (ultimi 10):\n\n'
           : u.language==='de'?'📚 Tagebuch (letzte 10):\n\n'
                              :'📚 Diary (last 10):\n\n';
  [...entries].slice(-10).reverse().forEach(e=>{
    txt += `• ${e.date} — ${e.text.slice(0,140)}\n`;
  });
  await ctx.answerCbQuery();
  await ctx.reply(txt);
});

bot.action('menu_mode', async (ctx)=>{
  const u = await getOrCreateUser(ctx);
  await ctx.editMessageText(u.language==='it'?'Scegli la modalità conversazione:'
                          :u.language==='de'?'Wähle den Gesprächsmodus:'
                                             :'Choose conversation mode:', modePicker(u));
});
bot.action('mode_friend', async (ctx)=>{ const u=await getOrCreateUser(ctx); await updateUserPatch(u.id,{mode:'friend'}); await ctx.answerCbQuery('Friend mode ON'); await ctx.editMessageReplyMarkup(modePicker({...u,mode:'friend'}).reply_markup); });
bot.action('mode_spiritual', async (ctx)=>{ const u=await getOrCreateUser(ctx); await updateUserPatch(u.id,{mode:'spiritual'}); await ctx.answerCbQuery('Spiritual mode ON'); await ctx.editMessageReplyMarkup(modePicker({...u,mode:'spiritual'}).reply_markup); });
bot.action('mode_coach', async (ctx)=>{ const u=await getOrCreateUser(ctx); await updateUserPatch(u.id,{mode:'coach'}); await ctx.answerCbQuery('Coach mode ON'); await ctx.editMessageReplyMarkup(modePicker({...u,mode:'coach'}).reply_markup); });

bot.action('menu_back', async (ctx)=>{ const u=await getOrCreateUser(ctx); await ctx.editMessageText('Menu:', menuInline(u)); });
bot.action('menu_close', async (ctx)=>{ await ctx.deleteMessage().catch(()=>{}); });

/* ---------- TEXT ROUTER ---------- */
bot.on('text', async (ctx)=>{
  const u = await getOrCreateUser(ctx);
  const text = (ctx.message?.text || '').trim();

  // Diario in composizione?
  const st = composeState.get(u.id);
  if (st?.expect === 'diary'){
    await diaryAppendAtomic(u.id, text); // <-- ATOMICO via RPC (fallback se assente)
    composeState.delete(u.id);
    const ok = u.language==='it'?`Salvato nel diario 📝 (${isoDate()})`
             : u.language==='de'?`Im Tagebuch gespeichert 📝 (${isoDate()})`
                                :`Saved in your diary 📝 (${isoDate()})`;
    await ctx.reply(ok, diaryInline);
    return;
  }

  // Comandi "diary new" scritti a mano
  if (/^\/?diary\s+new/i.test(text)) {
    composeState.set(u.id, { expect:'diary' });
    return ctx.reply(u.language==='it'?'Scrivi la tua nuova pagina e invia.'
                      :u.language==='de'?'Schreibe deinen neuen Eintrag und sende ihn.'
                                         :'Write your new entry and send it.');
  }

  // Chat OFF → non rispondiamo in automatico
  if (!u.chat_enabled){
    return ctx.reply(u.language==='it'
      ? '🤫 Chat OFF. Vai su 🏠 Menu → 💬 Chat ON per riprendere.'
      : u.language==='de'
      ? '🤫 Chat OFF. Gehe zu 🏠 Menü → 💬 Chat ON, um fortzufahren.'
      : '🤫 Chat is OFF. Go to 🏠 Menu → 💬 Chat ON to continue.');
  }

  // Chat libera con tono in base alla modalità
  await chatReply(ctx, u, text);
});

/* ---------- BOOT WITH RETRY ---------- */
async function startBotOnce(){
  const me = await bot.telegram.getMe();
  console.log(`Boot OK • @${me.username}`);
  if (WEBHOOK_DOMAIN){
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
    catch(e){
      console.error(`[boot] Attempt ${i} failed:`, e?.message||e);
      if (i===max) throw e;
      const wait = 2000*i;
      console.log(`[boot] Retrying in ${wait} ms...`);
      await sleep(wait);
    }
  }
}
startBotWithRetry(3).catch(()=>{});
process.once('SIGINT', ()=>bot.stop('SIGINT'));
process.once('SIGTERM',()=>bot.stop('SIGTERM'));

// index.js — EverGrace (CommonJS)

// ---------- env & guards ----------
require('dotenv').config();
const MUST = (name) => {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`[env] Missing ${name}`);
  return v.trim();
};
const BOT_TOKEN       = MUST('BOT_TOKEN');
const SUPABASE_URL    = MUST('SUPABASE_URL');
const SUPABASE_KEY    = MUST('SUPABASE_KEY');
const OPENAI_API_KEY  = process.env.OPENAI_API_KEY || '';

// ---------- deps ----------
const { Telegraf } = require('telegraf');
const { createClient } = require('@supabase/supabase-js');
const http = require('http');

// lazy import for pdfkit to keep footprint small
async function getPDFKit() {
  try {
    // pdfkit 0.13+ supports CJS require
    return require('pdfkit');
  } catch {
    return null;
  }
}

// ---------- clients ----------
const bot = new Telegraf(BOT_TOKEN);
const sb  = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

// minimal openai client (CJS)
let openai = null;
if (OPENAI_API_KEY) {
  const OpenAI = require('openai');
  openai = new OpenAI({ apiKey: OPENAI_API_KEY });
}

// ---------- helpers ----------
function menuKeyboard() {
  return {
    keyboard: [
      [{ text: '📒 Journal' }, { text: '📊 Progress' }],
      [{ text: '🧑‍🏫 Coach'   }, { text: '⚡ SOS'     }],
      [{ text: '🔗 Invite'   }, { text: '🎯 Menu'    }],
    ],
    is_persistent: true,
    resize_keyboard: true,
  };
}

async function showMenu(ctx) {
  // zero-width no-break space → shows keyboard without a visible message
  await ctx.reply('\uFEFF', { reply_markup: menuKeyboard() });
}

function langOf(ctx) {
  const code = ctx.from?.language_code || 'it';
  if (code.startsWith('en')) return 'en';
  if (code.startsWith('de')) return 'de';
  if (code.startsWith('it')) return 'it';
  return 'en';
}

function nowTs() { return new Date().toISOString(); }

// in-memory dedupe for “Esporta PDF” button per chat/message
const sentButtons = new Set();
async function offerPdfOnce(ctx) {
  const key = `pdfbtn:${ctx.chat.id}:${ctx.message?.message_id || Date.now()}`;
  if (sentButtons.has(key)) return;
  sentButtons.add(key);
  setTimeout(() => sentButtons.delete(key), 60_000); // TTL 1 min
  await ctx.reply(' ', {
    reply_markup: {
      inline_keyboard: [[{ text: '📄 Esporta PDF', callback_data: 'journal_export_pdf' }]],
    },
  });
}

async function appendJournal(chat_id, text) {
  return sb.from('journal').insert({ chat_id, text }).select().single();
}

async function recentJournal(chat_id, limit = 6) {
  const { data } = await sb
    .from('journal')
    .select('id, text, ts')
    .eq('chat_id', chat_id)
    .order('id', { ascending: false })
    .limit(limit);
  return data || [];
}

async function exportJournalPDF(ctx) {
  const PDFDocument = await getPDFKit();
  if (!PDFDocument) {
    await ctx.reply('Per esportare in PDF installa prima: `npm i pdfkit` e riprova.', { parse_mode: 'Markdown' });
    return;
  }

  const fs = require('fs');
  const path = require('path');

  const list = await recentJournal(ctx.chat.id, 200);
  if (!list.length) {
    await ctx.reply('Nulla da esportare.');
    return;
  }

  const exportsDir = path.join(__dirname, 'exports');
  if (!fs.existsSync(exportsDir)) fs.mkdirSync(exportsDir, { recursive: true });
  const file = path.join(exportsDir, `journal_${ctx.chat.id}_${Date.now()}.pdf`);

  const doc = new PDFDocument({ margin: 40 });
  const stream = fs.createWriteStream(file);
  doc.pipe(stream);

  doc.fontSize(18).text('Journal — EverGrace', { underline: true });
  doc.moveDown(1);

  // print newest first
  for (const e of [...list].reverse()) {
    const when = new Date(e.ts).toLocaleString();
    doc.fontSize(12).text(`#${e.id} • ${when}`);
    doc.moveDown(0.25);
    doc.fontSize(12).text(e.text || '', { align: 'left' });
    doc.moveDown(0.75);
  }

  doc.end();
  await new Promise(r => stream.on('finish', r));
  await ctx.replyWithDocument({ source: file, filename: require('path').basename(file) });
}

// ---------- AI fallback (short, warm replies) ----------
function sysPrompt(lang) {
  if (lang === 'it') return `Sei "EverGrace", un coach gentile, pratico e incoraggiante.
- Rispondi in 1–3 frasi.
- Se l’utente è bloccato, suggerisci un micro-passo concreto.
- Evita ripetizioni.
- Se opportuno, aggiungi una breve incoraggiamento spirituale neutro.`;
  if (lang === 'de') return `Du bist „EverGrace“, ein warmherziger, praktischer Coach.
- Antworte in 1–3 Sätzen.
- Falls der Nutzer feststeckt, schlage einen winzigen nächsten Schritt vor.
- Vermeide Wiederholungen.
- Optional: kurze, neutrale spirituelle Ermutigung.`;
  return `You are "EverGrace", a warm, practical coach.
- Reply in 1–3 sentences.
- If the user seems stuck, propose one tiny next step.
- Avoid repetitive phrasing.
- Optionally add a short neutral spiritual encouragement.`;
}

function summarize(list, n = 6) {
  return list.slice(-n).map(e => `• ${new Date(e.ts).toLocaleString()}: ${e.text}`).join('\n');
}

async function aiReply(chat_id, text, lang) {
  if (!openai) return null;
  const mem = await recentJournal(chat_id, 6);
  const memory = summarize(mem, 6) || '(no notes yet)';
  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0.7,
    messages: [
      { role: 'system', content: sysPrompt(lang) },
      { role: 'user', content: `Recent notes:\n${memory}\n\nUser: ${text}` },
    ],
  });
  return res.choices?.[0]?.message?.content?.trim() || null;
}

// ---------- commands ----------
bot.start(async (ctx) => {
  const l = langOf(ctx);
  const hello = (l === 'it')
    ? 'Ooilà! Come va? Tocca i pulsanti qui sotto per iniziare.'
    : (l === 'de')
      ? 'Hey! Wie geht’s? Nutze die Tasten unten, um zu starten.'
      : 'Hey! How are you? Use the buttons below to begin.';
  await showMenu(ctx);
  await ctx.reply(hello, { reply_markup: menuKeyboard() });
});

bot.hears(['🎯 Menu', '/menu', 'Menu', 'menu'], async (ctx) => showMenu(ctx));

bot.command('version', async (ctx) => {
  const v = `EverGrace v-${new Date().toISOString().slice(0,10)}-Stable`;
  await ctx.reply(v, { reply_markup: menuKeyboard() });
});

// ---------- journal ----------
bot.hears(['📒 Journal', 'Journal', '/journal'], async (ctx) => {
  const l = langOf(ctx);
  const prompt = (l === 'it')
    ? 'Raccontami: cosa hai in mente oggi? ✍️'
    : (l === 'de')
      ? 'Erzähl mir: Was geht dir heute durch den Kopf? ✍️'
      : 'Tell me: what’s on your mind today? ✍️';
  await ctx.reply(prompt, { reply_markup: menuKeyboard() });
});

bot.on('text', async (ctx, next) => {
  const text = (ctx.message?.text || '').trim();
  // if this was a button label, skip to its handler
  const labels = ['📒 Journal','📊 Progress','🧑‍🏫 Coach','⚡ SOS','🔗 Invite','🎯 Menu'];
  if (labels.includes(text)) return next();

  // treat as a journal note by default
  const { error } = await appendJournal(ctx.chat.id, text);
  if (!error) {
    const l = langOf(ctx);
    const ok = (l === 'it') ? 'Annotato. ✅' : (l === 'de') ? 'Notiert. ✅' : 'Saved. ✅';
    await ctx.reply(ok, { reply_markup: menuKeyboard() });
    await offerPdfOnce(ctx);
    return;
  }

  // If insert failed for some reason, try AI fallback as a chat
  const reply = await aiReply(ctx.chat.id, text, langOf(ctx));
  if (reply) {
    await ctx.reply(reply, { reply_markup: menuKeyboard() });
    return;
  }

  await ctx.reply('Ops, non riesco a salvare ora. Riprova più tardi.', { reply_markup: menuKeyboard() });
});

// PDF export button
bot.action('journal_export_pdf', async (ctx) => {
  try {
    await ctx.answerCbQuery('Esporto in PDF…');
    await exportJournalPDF(ctx);
  } catch (e) {
    await ctx.answerCbQuery('Errore durante esportazione.');
  }
});

// ---------- progress (log & stop the loop) ----------
async function logProgress(ctx, payload = {}) {
  // Example: write one row into journal as a progress marker
  await appendJournal(ctx.chat.id, payload.text || 'Progress update');
  const l = langOf(ctx);
  const msg = (l === 'it') ? 'Fatto! 💪' : (l === 'de') ? 'Erledigt! 💪' : 'Done! 💪';
  await ctx.reply(msg, { reply_markup: menuKeyboard() });
}

bot.hears(['📊 Progress','Progress','/progress'], async (ctx) => {
  const l = langOf(ctx);
  const q = (l === 'it') ? 'Qual è il tuo micro-passo di oggi?' :
            (l === 'de') ? 'Was ist dein heutiger Mini-Schritt?' :
                           'What’s your tiny step for today?';
  await ctx.reply(q, { reply_markup: menuKeyboard() });
});

// If user answers with something like “done: …” treat as progress quickly
bot.hears(/^done[:\-]\s*/i, async (ctx) => {
  const text = ctx.message.text.replace(/^done[:\-]\s*/i,'').trim();
  await logProgress(ctx, { text: `✅ ${text}` });
});

// ---------- coach / sos / invite ----------
bot.hears(['🧑‍🏫 Coach','Coach','/coach'], async (ctx) => {
  const l = langOf(ctx);
  const msg = (l === 'it')
    ? 'Coach attivo. Dimmi l’obiettivo o chiedimi un micro-passo.'
    : (l === 'de')
      ? 'Coach aktiv. Nenne mir dein Ziel oder frag nach einem Mini-Schritt.'
      : 'Coach on. Tell me your goal or ask for a tiny next step.';
  await ctx.reply(msg, { reply_markup: menuKeyboard() });
});

bot.hears(['⚡ SOS','SOS','/sos'], async (ctx) => {
  const l = langOf(ctx);
  const msg = (l === 'it')
    ? 'Respira. 3 cose che puoi controllare adesso? Scrivile qui sotto.'
    : (l === 'de')
      ? 'Atme. Nenne 3 Dinge, die du jetzt kontrollieren kannst. Schreib sie hier.'
      : 'Breathe. Name 3 things you can control right now. Type them here.';
  await ctx.reply(msg, { reply_markup: menuKeyboard() });
});

bot.hears(['🔗 Invite','Invite','/invite'], async (ctx) => {
  const link = `https://t.me/${(await bot.telegram.getMe()).username}`;
  const l = langOf(ctx);
  const msg = (l === 'it')
    ? `Invita amici con questo link: ${link}`
    : (l === 'de')
      ? `Lade Freunde mit diesem Link ein: ${link}`
      : `Invite friends with this link: ${link}`;
  await ctx.reply(msg, { reply_markup: menuKeyboard() });
});

// ---------- healthcheck (Render) ----------
const PORT = process.env.PORT || 10000;
http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('ok');
}).listen(PORT, () => console.log(`[hc] listening on :${PORT}`));

// ---------- launch ----------
bot.launch().then(() => console.log('Bot OK. @EverGraceRabeBot'));

// graceful stop (Render)
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

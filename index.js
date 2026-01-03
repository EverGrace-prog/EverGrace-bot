"use strict";

/**
 * HITH — Telegram + WhatsApp (single server)
 * - Telegram: Telegraf webhook at /tg-webhook
 * - WhatsApp Cloud API: webhook at /whatsapp/webhook (GET verify + POST updates)
 * - Journal web page: /journal (write/save/share/print)
 */

const express = require("express");
const crypto = require("crypto");
const { Telegraf, Markup } = require("telegraf");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json({ limit: "2mb" }));

// -------------------- ENV --------------------
const PORT = process.env.PORT || 10000;

// Base URL of THIS Render service (ONE public URL for both Telegram + WhatsApp)
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/$/, "");

// Telegram
const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;

// OpenAI
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini"; // change if you want

// Supabase
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_KEY;

// WhatsApp
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN; // permanent token
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID; // phone number ID
const WHATSAPP_VERIFY_TOKEN =
  process.env.WHATSAPP_VERIFY_TOKEN || "hith_whatsapp_verify";

// -------------------- SAFETY CHECKS --------------------
function required(name, value) {
  if (!value) console.warn(`⚠️ Missing env: ${name}`);
}

required("PUBLIC_URL", PUBLIC_URL);
required("BOT_TOKEN (or TELEGRAM_BOT_TOKEN)", BOT_TOKEN);
required("OPENAI_API_KEY", OPENAI_API_KEY);
required("SUPABASE_URL", SUPABASE_URL);
required("SUPABASE_SERVICE_ROLE (or SUPABASE_KEY)", SUPABASE_SERVICE_ROLE);
// WhatsApp envs can be added later, but routes must exist for verification:
required("WHATSAPP_VERIFY_TOKEN", WHATSAPP_VERIFY_TOKEN);

// -------------------- SUPABASE --------------------
const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
        auth: { persistSession: false },
      })
    : null;

// Minimal fallback in-memory store (if Supabase is missing)
const mem = {
  prefs: new Map(), // key: "tg:123" or "wa:+39123"
  journal: new Map(), // key -> array of entries
};

// -------------------- UTILS --------------------
const HITH_NAME = "Hith";

function nowIso() {
  return new Date().toISOString();
}

function keyFor(channel, id) {
  return `${channel}:${id}`;
}

function safeText(x) {
  return String(x || "").trim();
}

function shortId() {
  return crypto.randomBytes(6).toString("hex");
}

// light emoji usage
function addEmoji(lang, text) {
  // tasteful: only add when it helps the tone
  if (!text) return text;
  // If it already contains emoji, don’t add more.
  if (/[^\u0000-\u007F]/.test(text)) return text;
  const tail = lang === "IT" ? " 🙂" : lang === "DE" ? " 🙂" : " 🙂";
  return text + tail;
}

// quick language guess if user didn’t set one
function guessLangFromText(t) {
  const s = (t || "").toLowerCase();
  const hasDe =
    /\b(und|nicht|ich|du|wir|danke|bitte|heute|machen)\b/.test(s) ||
    /[äöüß]/.test(s);
  const hasIt =
    /\b(che|non|sono|grazie|oggi|come|perché|bene|ciao)\b/.test(s);
  if (hasDe && !hasIt) return "DE";
  if (hasIt && !hasDe) return "IT";
  return "EN";
}

// -------------------- PREFS (Friend mode locked) --------------------
const DEFAULT_PREFS = {
  lang: "EN",
  friend_mode: true, // LOCKED ON
  friend_mode_locked: true,
};

async function getPrefs(channel, userId) {
  const k = keyFor(channel, userId);

  if (!supabase) {
    return mem.prefs.get(k) || { ...DEFAULT_PREFS };
  }

  const { data, error } = await supabase
    .from("hith_prefs")
    .select("*")
    .eq("user_key", k)
    .maybeSingle();

  if (error) {
    console.warn("Supabase getPrefs error:", error.message);
    return mem.prefs.get(k) || { ...DEFAULT_PREFS };
  }

  if (!data) {
    // create default row
    const row = {
      user_key: k,
      channel,
      user_id: String(userId),
      lang: DEFAULT_PREFS.lang,
      friend_mode: true,
      friend_mode_locked: true,
      updated_at: nowIso(),
    };
    const ins = await supabase.from("hith_prefs").insert(row);
    if (ins.error) console.warn("Supabase insertPrefs error:", ins.error.message);
    return { ...DEFAULT_PREFS };
  }

  return {
    lang: data.lang || DEFAULT_PREFS.lang,
    friend_mode: data.friend_mode !== false,
    friend_mode_locked: data.friend_mode_locked !== false,
  };
}

async function setPrefs(channel, userId, patch) {
  const k = keyFor(channel, userId);
  const next = { ...(await getPrefs(channel, userId)), ...patch };

  if (!supabase) {
    mem.prefs.set(k, next);
    return next;
  }

  const row = {
    user_key: k,
    channel,
    user_id: String(userId),
    lang: next.lang,
    friend_mode: next.friend_mode,
    friend_mode_locked: next.friend_mode_locked,
    updated_at: nowIso(),
  };

  const { error } = await supabase
    .from("hith_prefs")
    .upsert(row, { onConflict: "user_key" });

  if (error) console.warn("Supabase setPrefs error:", error.message);
  return next;
}

// -------------------- JOURNAL STORAGE --------------------
async function saveJournalEntry(channel, userId, text) {
  const k = keyFor(channel, userId);
  const entry = {
    id: shortId(),
    created_at: nowIso(),
    text: safeText(text),
  };

  if (!supabase) {
    const arr = mem.journal.get(k) || [];
    arr.unshift(entry);
    mem.journal.set(k, arr);
    return entry;
  }

  const { error } = await supabase.from("hith_journal").insert({
    user_key: k,
    channel,
    user_id: String(userId),
    entry_id: entry.id,
    text: entry.text,
    created_at: entry.created_at,
  });

  if (error) console.warn("Supabase saveJournalEntry error:", error.message);
  return entry;
}

async function listJournalEntries(channel, userId, limit = 20) {
  const k = keyFor(channel, userId);

  if (!supabase) {
    return (mem.journal.get(k) || []).slice(0, limit);
  }

  const { data, error } = await supabase
    .from("hith_journal")
    .select("entry_id, text, created_at")
    .eq("user_key", k)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.warn("Supabase listJournalEntries error:", error.message);
    return [];
  }

  return (data || []).map((r) => ({
    id: r.entry_id,
    text: r.text,
    created_at: r.created_at,
  }));
}

// -------------------- OPENAI (Responses API) --------------------
async function hithReply({ userText, lang, friendMode }) {
  const system = `
You are ${HITH_NAME}.
You are in FRIEND MODE: warm, human, playful, not clinical.
Absolutely avoid therapeutic coaching, "small steps", "I'm here to support you", or nagging.
Do not end every message with a question.
Ask a question ONLY if it directly helps the current conversation OR makes it genuinely more interesting.
Use a few emojis naturally (1 max) when it fits. Do not be stiff.
Reply in the same language as the user. Language code: ${lang}.
Keep replies concise and conversational.
If the user asks if you can keep secrets: say you will treat it as private, but you cannot guarantee secrecy or safety.
`.trim();

  const input = [
    { role: "system", content: system },
    { role: "user", content: userText },
  ];

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      input,
      max_output_tokens: 220,
    }),
  });

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`OpenAI error ${resp.status}: ${t}`);
  }

  const data = await resp.json();
  const out = (data.output_text || "").trim();
  return out || (lang === "IT" ? "Ok." : lang === "DE" ? "Okay." : "Ok.");
}

// -------------------- TELEGRAM --------------------
const bot = BOT_TOKEN ? new Telegraf(BOT_TOKEN) : null;

function telegramMainMenu() {
  // IMPORTANT: callback buttons (not sending text)
  return Markup.inlineKeyboard([
    [Markup.button.callback("📔 Journal", "MENU_JOURNAL"), Markup.button.callback("📊 Progress", "MENU_PROGRESS")],
    [Markup.button.callback("📌 Coach", "MENU_COACH"), Markup.button.callback("⚡ SOS", "MENU_SOS")],
    [Markup.button.callback("🔗 Invite", "MENU_INVITE"), Markup.button.callback("⚙️ Impostazioni", "MENU_SETTINGS")],
  ]);
}

function telegramSettingsMenu() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("🇮🇹 IT", "SET_LANG_IT"),
      Markup.button.callback("🇬🇧 EN", "SET_LANG_EN"),
      Markup.button.callback("🇩🇪 DE", "SET_LANG_DE"),
    ],
    [Markup.button.callback("🔒 Lock friend mode", "LOCK_FRIEND_MODE")],
  ]);
}

if (bot) {
  // Webhook callback path for Telegram
  const TG_PATH = "/tg-webhook";
  app.use(TG_PATH, bot.webhookCallback(TG_PATH));

  bot.start(async (ctx) => {
    const userId = ctx.from?.id;
    const prefs = await getPrefs("tg", userId);
    await ctx.reply(
      prefs.lang === "IT"
        ? "Ciao, sono Hith. 👋"
        : prefs.lang === "DE"
        ? "Hi, ich bin Hith. 👋"
        : "Hey, I’m Hith. 👋",
      telegramMainMenu()
    );
  });

  // Menu actions (NO AI chatter)
  bot.action("MENU_JOURNAL", async (ctx) => {
    try {
      await ctx.answerCbQuery();
      const userId = ctx.from.id;
      const prefs = await getPrefs("tg", userId);

      const url = `${PUBLIC_URL}/journal?channel=tg&user=${encodeURIComponent(
        userId
      )}&lang=${prefs.lang}`;

      const msg =
        prefs.lang === "IT"
          ? "📔 Journal pronto. Aprilo qui:"
          : prefs.lang === "DE"
          ? "📔 Journal ist bereit. Öffne es hier:"
          : "📔 Journal is ready. Open it here:";

      await ctx.reply(
        msg,
        Markup.inlineKeyboard([Markup.button.url("Open Journal", url)])
      );
    } catch (e) {
      console.error(e);
    }
  });

  bot.action("MENU_PROGRESS", async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    const prefs = await getPrefs("tg", userId);
    const msg =
      prefs.lang === "IT"
        ? "📊 Progress: (coming next) — per ora usiamo Journal."
        : prefs.lang === "DE"
        ? "📊 Fortschritt: (kommt als nächstes) — vorerst Journal nutzen."
        : "📊 Progress: (coming next) — for now use Journal.";
    await ctx.reply(msg);
  });

  bot.action("MENU_COACH", async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    const prefs = await getPrefs("tg", userId);
    const msg =
      prefs.lang === "IT"
        ? "📌 Coach è attivo, ma in friend mode non faccio ‘terapia’. Dimmi cosa vuoi fare."
        : prefs.lang === "DE"
        ? "📌 Coach ist da, aber im Friend Mode keine Therapie. Sag mir, worauf du Bock hast."
        : "📌 Coach is here — but in friend mode I’m not doing therapy. Tell me what you want.";
    await ctx.reply(msg);
  });

  bot.action("MENU_SOS", async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    const prefs = await getPrefs("tg", userId);
    const msg =
      prefs.lang === "IT"
        ? "⚡ SOS: Se c’è un’emergenza reale, chiama i servizi locali. Se vuoi, dimmi cosa sta succedendo in 1 frase."
        : prefs.lang === "DE"
        ? "⚡ SOS: Wenn es ein echter Notfall ist, ruf lokale Hilfe. Wenn du willst: 1 Satz, was los ist."
        : "⚡ SOS: If it’s a real emergency, contact local services. If you want: 1 sentence—what’s happening.";
    await ctx.reply(msg);
  });

  bot.action("MENU_INVITE", async (ctx) => {
    await ctx.answerCbQuery();
    const msg = `Invite a friend:\nhttps://t.me/${ctx.botInfo.username}`;
    await ctx.reply(msg);
  });

  bot.action("MENU_SETTINGS", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply("⚙️ Settings:", telegramSettingsMenu());
  });

  // Language set
  bot.action(["SET_LANG_IT", "SET_LANG_EN", "SET_LANG_DE"], async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    const code = ctx.callbackQuery.data.split("_").pop(); // IT/EN/DE
    await setPrefs("tg", userId, { lang: code });
    const msg =
      code === "IT" ? "Lingua: IT ✅" : code === "DE" ? "Sprache: DE ✅" : "Language: EN ✅";
    await ctx.reply(msg, telegramMainMenu());
  });

  // Lock friend mode (your request)
  bot.action("LOCK_FRIEND_MODE", async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from.id;
    const prefs = await getPrefs("tg", userId);

    await setPrefs("tg", userId, { friend_mode: true, friend_mode_locked: true });

    const msg =
      prefs.lang === "IT"
        ? "🔒 Friend mode bloccata. Rimango ‘amica’, niente terapia."
        : prefs.lang === "DE"
        ? "🔒 Friend Mode gesperrt. Ich bleibe ‘freundlich’, keine Therapie."
        : "🔒 Friend mode locked. I’ll stay ‘friend’, not therapy.";

    await ctx.reply(msg, telegramMainMenu());
  });

  // Normal chat (AI) — NOT triggered by menu buttons
  bot.on("text", async (ctx) => {
    const userId = ctx.from?.id;
    const text = safeText(ctx.message?.text);

    // ignore commands
    if (text.startsWith("/")) return;

    const prefs = await getPrefs("tg", userId);
    const lang = prefs.lang || guessLangFromText(text);

    try {
      const out = await hithReply({
        userText: text,
        lang,
        friendMode: prefs.friend_mode,
      });

      // add a light emoji if none
      const finalOut = addEmoji(lang, out);
      await ctx.reply(finalOut, telegramMainMenu());
    } catch (e) {
      console.error("Telegram AI error:", e.message);
      await ctx.reply("⚠️ Error. Try again.");
    }
  });

  // Set Telegram webhook on boot
  async function setupTelegramWebhook() {
    if (!PUBLIC_URL) return;
    const url = `${PUBLIC_URL}/tg-webhook`;
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url,
            allowed_updates: ["message", "callback_query"],
          }),
        }
      );
      const json = await res.json();
      console.log("Telegram webhook:", json);
    } catch (e) {
      console.error("Telegram setWebhook failed:", e.message);
    }
  }

  // Expose for later call after server start
  app.set("setupTelegramWebhook", setupTelegramWebhook);
}

// -------------------- JOURNAL WEB PAGE --------------------
app.get("/journal", async (req, res) => {
  const channel = req.query.channel || "tg";
  const userId = req.query.user || "";
  const lang = (req.query.lang || "EN").toUpperCase();

  // tiny UI copy
  const t =
    lang === "IT"
      ? {
          title: "HITH · Journal",
          placeholder: "Scrivi qui…",
          save: "Salva",
          share: "Condividi",
          print: "Stampa",
          history: "Storico",
        }
      : lang === "DE"
      ? {
          title: "HITH · Journal",
          placeholder: "Schreib hier…",
          save: "Speichern",
          share: "Teilen",
          print: "Drucken",
          history: "Verlauf",
        }
      : {
          title: "HITH · Journal",
          placeholder: "Write here…",
          save: "Save",
          share: "Share",
          print: "Print",
          history: "History",
        };

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${t.title}</title>
<style>
  :root{--bg:#07070a;--card:#0f0f14;--gold:#d4af37;--text:#f5f5f5;--muted:#a8a8a8;}
  body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;background:radial-gradient(circle at top,#1b1b22 0,#07070a 60%);color:var(--text);padding:18px;}
  .wrap{max-width:900px;margin:0 auto;}
  .card{background:rgba(0,0,0,.6);border:1px solid rgba(212,175,55,.25);border-radius:16px;padding:16px;}
  h1{margin:0 0 12px;font-size:18px;letter-spacing:.4px}
  textarea{width:100%;min-height:260px;border-radius:14px;border:1px solid rgba(212,175,55,.25);background:var(--card);color:var(--text);padding:14px;font-size:16px;outline:none;resize:vertical;}
  .row{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}
  button{border:0;border-radius:12px;padding:10px 14px;font-weight:600;cursor:pointer}
  .gold{background:var(--gold);color:#111}
  .ghost{background:transparent;border:1px solid rgba(212,175,55,.35);color:var(--text)}
  .list{margin-top:14px;color:var(--muted);font-size:14px}
  .entry{margin-top:10px;padding:10px;border-radius:12px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06)}
  .meta{font-size:12px;color:var(--muted);margin-bottom:6px}
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1>📔 ${t.title}</h1>
    <textarea id="text" placeholder="${t.placeholder}"></textarea>
    <div class="row">
      <button class="gold" id="save">${t.save}</button>
      <button class="ghost" id="share">${t.share}</button>
      <button class="ghost" id="print">${t.print}</button>
    </div>
    <div class="list">
      <div style="margin-top:14px;font-weight:700;color:var(--text)">${t.history}</div>
      <div id="history"></div>
    </div>
  </div>
</div>

<script>
  const channel = ${JSON.stringify(channel)};
  const user = ${JSON.stringify(userId)};
  const historyEl = document.getElementById("history");
  const textEl = document.getElementById("text");

  async function loadHistory(){
    const r = await fetch("/api/journal/list?channel="+encodeURIComponent(channel)+"&user="+encodeURIComponent(user));
    const j = await r.json();
    historyEl.innerHTML = "";
    (j.items || []).forEach(it=>{
      const d = document.createElement("div");
      d.className = "entry";
      d.innerHTML = '<div class="meta">'+new Date(it.created_at).toLocaleString()+'</div><div>'+escapeHtml(it.text)+'</div>';
      historyEl.appendChild(d);
    });
  }

  function escapeHtml(s){
    return (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  document.getElementById("save").onclick = async ()=>{
    const text = (textEl.value || "").trim();
    if(!text) return;
    await fetch("/api/journal/save", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ channel, user, text })
    });
    textEl.value = "";
    await loadHistory();
  };

  document.getElementById("share").onclick = async ()=>{
    const text = (textEl.value || "").trim();
    if(!text) return;
    if(navigator.share){
      try{ await navigator.share({ text }); } catch(e){}
    } else {
      await navigator.clipboard.writeText(text);
      alert("Copied ✅");
    }
  };

  document.getElementById("print").onclick = ()=>{
    window.print();
  };

  loadHistory();
</script>
</body>
</html>`);
});

app.post("/api/journal/save", async (req, res) => {
  const channel = safeText(req.body?.channel || "tg");
  const user = safeText(req.body?.user || "");
  const text = safeText(req.body?.text || "");
  if (!user || !text) return res.status(400).json({ ok: false });
  const entry = await saveJournalEntry(channel, user, text);
  res.json({ ok: true, entry });
});

app.get("/api/journal/list", async (req, res) => {
  const channel = safeText(req.query.channel || "tg");
  const user = safeText(req.query.user || "");
  if (!user) return res.json({ ok: true, items: [] });
  const items = await listJournalEntries(channel, user, 20);
  res.json({ ok: true, items });
});

// -------------------- WHATSAPP WEBHOOK (Meta verify requires GET) --------------------
app.get("/whatsapp/webhook", (req, res) => {
  // Meta verification:
  // hub.mode=subscribe
  // hub.verify_token=...
  // hub.challenge=...
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post("/whatsapp/webhook", async (req, res) => {
  // Always ACK fast
  res.sendStatus(200);

  try {
    const body = req.body;

    // Typical message shape:
    // entry[0].changes[0].value.messages[0]
    const entry = body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    const msg = value?.messages?.[0];
    if (!msg) return;

    const from = msg.from; // WhatsApp user number (string)
    const text = msg?.text?.body || "";

    const prefs = await getPrefs("wa", from);
    const lang = prefs.lang || guessLangFromText(text);

    const out = await hithReply({
      userText: text,
      lang,
      friendMode: true,
    });

    await sendWhatsAppText(from, addEmoji(lang, out));
  } catch (e) {
    console.error("WhatsApp webhook error:", e.message);
  }
});

async function sendWhatsAppText(to, text) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID) {
    console.warn("WhatsApp not configured (missing WHATSAPP_TOKEN / WHATSAPP_PHONE_ID)");
    return;
  }

  const url = `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_ID}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
  };

  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!r.ok) {
    const t = await r.text();
    console.error("WhatsApp send failed:", r.status, t);
  }
}

// -------------------- HEALTH ROUTES --------------------
app.get("/", (req, res) => {
  res.status(200).send("HITH is alive.");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    time: nowIso(),
    public_url: PUBLIC_URL,
    telegram: !!BOT_TOKEN,
    whatsapp: {
      verify_token_set: !!WHATSAPP_VERIFY_TOKEN,
      token_set: !!WHATSAPP_TOKEN,
      phone_id_set: !!WHATSAPP_PHONE_ID,
    },
    supabase: !!supabase,
  });
});

// -------------------- START SERVER --------------------
app.listen(PORT, async () => {
  console.log("✅ Server listening on", PORT);
  console.log("PUBLIC_URL:", PUBLIC_URL);

  if (supabase) console.log("Supabase connection OK");

  // Telegram webhook setup after server is listening
  const setupTelegramWebhook = app.get("setupTelegramWebhook");
  if (setupTelegramWebhook) await setupTelegramWebhook();

  console.log("Telegram webhook URL:", PUBLIC_URL ? `${PUBLIC_URL}/tg-webhook` : "(missing PUBLIC_URL)");
  console.log("WhatsApp webhook URL:", PUBLIC_URL ? `${PUBLIC_URL}/whatsapp/webhook` : "(missing PUBLIC_URL)");
});

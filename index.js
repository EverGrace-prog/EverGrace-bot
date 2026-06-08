/**
 * HITH — Telegram + WhatsApp unified bot
 * Render-ready
 *
 * MEMORY v3:
 * - hith_memory   = recent conversation memory
 * - hith_facts    = long-term user facts
 * - hith_projects = project memory
 */

import express from "express";
import { Telegraf } from "telegraf";
import { createClient } from "@supabase/supabase-js";

// -------------------- ENV --------------------
const PORT = Number(process.env.PORT || 10000);

const PUBLIC_URL = String(process.env.PUBLIC_URL || "")
  .trim()
  .replace(/\/+$/, "");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID || "";
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || "";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE =
  process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_KEY || "";

const SUPABASE_TABLE = process.env.SUPABASE_TABLE || "hith_prefs";
const SUPABASE_MEMORY_TABLE =
  process.env.SUPABASE_MEMORY_TABLE || "hith_memory";
const SUPABASE_FACTS_TABLE =
  process.env.SUPABASE_FACTS_TABLE || "hith_facts";
const SUPABASE_PROJECTS_TABLE =
  process.env.SUPABASE_PROJECTS_TABLE || "hith_projects";

// -------------------- CONSTANTS --------------------
const TG_PATH = "/tg-webhook";
const WA_PATH = "/whatsapp/webhook";
const FRIEND_MODE_LOCKED = true;

// -------------------- SAFE FETCH --------------------
async function safeFetch(url, options) {
  if (typeof fetch !== "undefined") return fetch(url, options);
  const mod = await import("node-fetch");
  return mod.default(url, options);
}

// -------------------- APP --------------------
const app = express();
app.use(express.json({ limit: "2mb" }));

app.use((req, res, next) => {
  if (req.path === TG_PATH || req.path === WA_PATH) {
    console.log("📥 INCOMING", req.method, req.path);
  }
  next();
});

// -------------------- EMOJI --------------------
const EMOJI = {
  en: ["🙂", "✨", "🤍", "🫶"],
  it: ["🙂", "✨", "🤍", "🫶"],
  de: ["🙂", "✨", "🤍", "🫶"],
};

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function addEmoji(lang, text) {
  const l = (lang || "en").toLowerCase();
  const e = EMOJI[l] || EMOJI.en;
  const t = String(text || "").trim();
  if (!t) return t;
  if (/[🙂✨🤍🫶]$/.test(t)) return t;
  return `${t} ${pick(e)}`;
}

// -------------------- SUPABASE --------------------
let supa = null;

async function initSupabase() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    console.log("ℹ️ Supabase disabled: missing SUPABASE_URL or key");
    return false;
  }

  try {
    supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
      auth: { persistSession: false },
    });

    await supa.from(SUPABASE_TABLE).select("*").limit(1);
    await supa.from(SUPABASE_MEMORY_TABLE).select("*").limit(1);
    await supa.from(SUPABASE_FACTS_TABLE).select("*").limit(1);
    await supa.from(SUPABASE_PROJECTS_TABLE).select("*").limit(1);

    console.log("✅ Supabase connected");
    return true;
  } catch (e) {
    console.log("⚠️ Supabase issue:", e?.message || e);
    return false;
  }
}

// -------------------- PREFS --------------------
async function getPrefs(platform, userId) {
  const base = { lang: null, friendMode: true };
  if (!supa) return base;

  try {
    const { data, error } = await supa
      .from(SUPABASE_TABLE)
      .select("*")
      .eq("platform", platform)
      .eq("user_id", String(userId))
      .maybeSingle();

    if (error || !data) return base;

    return {
      lang: data.lang || null,
      friendMode: FRIEND_MODE_LOCKED ? true : data.friend_mode ?? true,
    };
  } catch {
    return base;
  }
}

async function setPrefs(platform, userId, patch = {}) {
  if (!supa || !userId) return false;

  const payload = {
    platform,
    user_id: String(userId),
    lang: patch.lang ?? null,
    friend_mode: FRIEND_MODE_LOCKED ? true : patch.friendMode ?? true,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supa.from(SUPABASE_TABLE).upsert(payload, {
    onConflict: "platform,user_id",
  });

  if (error) console.log("⚠️ setPrefs error:", error.message);
  return !error;
}

// -------------------- FALLBACK MEMORY --------------------
const MEMORY_FALLBACK = new Map();

function fallbackKey(platform, userId) {
  return `${platform}:${userId}`;
}

// -------------------- CONVERSATION MEMORY --------------------
async function saveMessage(platform, userId, role, content) {
  const clean = String(content || "").trim();
  if (!clean || !userId) return;

  const payload = {
    platform,
    user_id: String(userId),
    role,
    content: clean,
    created_at: new Date().toISOString(),
  };

  if (supa) {
    const { error } = await supa.from(SUPABASE_MEMORY_TABLE).insert(payload);
    if (!error) return;
    console.log("⚠️ saveMessage error:", error.message);
  }

  const k = fallbackKey(platform, userId);
  const arr = MEMORY_FALLBACK.get(k) || [];
  arr.push(payload);
  MEMORY_FALLBACK.set(k, arr.slice(-40));
}

async function getConversationMemory(platform, userId, max = 12) {
  if (!userId) return [];

  if (supa) {
    const { data, error } = await supa
      .from(SUPABASE_MEMORY_TABLE)
      .select("role, content, created_at")
      .eq("platform", platform)
      .eq("user_id", String(userId))
      .in("role", ["user", "assistant"])
      .order("created_at", { ascending: false })
      .limit(max);

    if (!error && data) {
      return data.reverse().map((m) => ({
        role: m.role,
        content: m.content,
      }));
    }

    if (error) console.log("⚠️ getConversationMemory error:", error.message);
  }

  const arr = MEMORY_FALLBACK.get(fallbackKey(platform, userId)) || [];
  return arr.slice(-max).map((m) => ({
    role: m.role,
    content: m.content,
  }));
}

// -------------------- FACT MEMORY --------------------
async function saveFact(platform, userId, fact, category = "general", confidence = 0.8) {
  const clean = String(fact || "").trim();
  if (!supa || !clean || !userId) return false;

  const { error } = await supa.from(SUPABASE_FACTS_TABLE).insert({
    platform,
    user_id: String(userId),
    fact: clean,
    category,
    confidence,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  if (error) {
    console.log("⚠️ saveFact error:", error.message);
    return false;
  }

  return true;
}

async function getFacts(platform, userId, max = 25) {
  if (!supa || !userId) return [];

  const { data, error } = await supa
    .from(SUPABASE_FACTS_TABLE)
    .select("fact, category, confidence, updated_at")
    .eq("platform", platform)
    .eq("user_id", String(userId))
    .order("updated_at", { ascending: false })
    .limit(max);

  if (error) {
    console.log("⚠️ getFacts error:", error.message);
    return [];
  }

  return data || [];
}

// -------------------- PROJECT MEMORY --------------------
async function saveProject(platform, userId, projectName, status, notes = "") {
  if (!supa || !userId || !projectName) return false;

  const { error } = await supa.from(SUPABASE_PROJECTS_TABLE).upsert(
    {
      platform,
      user_id: String(userId),
      project_name: projectName,
      status: status || "active",
      notes: notes || "",
      updated_at: new Date().toISOString(),
    },
    { onConflict: "platform,user_id,project_name" }
  );

  if (error) {
    console.log("⚠️ saveProject error:", error.message);
    return false;
  }

  return true;
}

async function getProjects(platform, userId, max = 20) {
  if (!supa || !userId) return [];

  const { data, error } = await supa
    .from(SUPABASE_PROJECTS_TABLE)
    .select("project_name, status, notes, updated_at")
    .eq("platform", platform)
    .eq("user_id", String(userId))
    .order("updated_at", { ascending: false })
    .limit(max);

  if (error) {
    console.log("⚠️ getProjects error:", error.message);
    return [];
  }

  return data || [];
}

// -------------------- MEMORY EXTRACTOR --------------------
async function extractLongTermMemory(platform, userId, userText, lang) {
  if (!OPENAI_API_KEY || !supa || !userText) return;

  const prompt = `
You extract long-term memory for HITH.

Save only information that may still matter in 6 months.

Do NOT save temporary mood, weather, small talk, or one-time details.

Return strict JSON only:

{
  "facts": [
    {
      "fact": "User is building HITH.",
      "category": "projects",
      "confidence": 0.9
    }
  ],
  "projects": [
    {
      "project_name": "HITH",
      "status": "active",
      "notes": "User is working on long-term memory."
    }
  ]
}

Allowed categories:
identity, family, work, projects, goals, location, preferences, skills, important_events, education, creative_work.

If there is nothing worth saving:
{
  "facts": [],
  "projects": []
}
`.trim();

  try {
    const resp = await safeFetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: userText },
        ],
        temperature: 0.1,
        response_format: { type: "json_object" },
      }),
    });

    const json = await resp.json();
    const raw = json?.choices?.[0]?.message?.content;
    if (!raw) return;

    const parsed = JSON.parse(raw);

    for (const item of parsed.facts || []) {
      if (item.fact) {
        await saveFact(
          platform,
          userId,
          item.fact,
          item.category || "general",
          item.confidence || 0.8
        );
      }
    }

    for (const p of parsed.projects || []) {
      if (p.project_name) {
        await saveProject(
          platform,
          userId,
          p.project_name,
          p.status || "active",
          p.notes || ""
        );
      }
    }
  } catch (e) {
    console.log("⚠️ extractLongTermMemory error:", e?.message || e);
  }
}

// -------------------- LANGUAGE --------------------
function guessLangFromText(text = "") {
  const t = text.toLowerCase();

  if (/[äöüß]/.test(t)) return "de";
  if (/\b(und|nicht|ich|du|wir|danke|bitte|heute|was|wie|warum)\b/.test(t))
    return "de";

  if (
    /\b(ciao|grazie|perché|oggi|bene|allora|non|voglio|sono|devo|posso|come|cosa)\b/.test(
      t
    )
  )
    return "it";

  return "en";
}

// -------------------- SYSTEM PROMPT --------------------
function buildSystemPrompt({ lang, facts, projects }) {
  const factText =
    facts.length > 0
      ? facts.map((f) => `- ${f.fact}`).join("\n")
      : "No saved facts yet.";

  const projectText =
    projects.length > 0
      ? projects
          .map(
            (p) =>
              `- ${p.project_name}: ${p.status || "active"}${
                p.notes ? ` — ${p.notes}` : ""
              }`
          )
          .join("\n")
      : "No saved projects yet.";

  return `
You are HITH in FRIEND MODE. Friend mode is LOCKED ON.

HITH is a private reflection companion created by RABE.

HITH is:
- warm
- direct
- calm
- human
- non-judgmental
- emotionally intelligent

HITH is not:
- a therapist
- a doctor
- a judge
- a robotic assistant

Reply in ${lang}.

KNOWN LONG-TERM FACTS:
${factText}

KNOWN PROJECTS:
${projectText}

MEMORY RULES:

HITH is designed to remember.

Never say:
- "I don't have access to past conversations."
- "I can't access previous chats."
- "I only remember the current session."
- "I don't have that in my memory yet."

Those statements are not part of HITH's identity.

Use the saved memory provided above.

If something is remembered:
- continue naturally
- refer to it conversationally
- help the user continue where they left off

If something is not remembered:
respond naturally, like a person.

Examples:
- "Aspetta... questa parte non me la ricordo."
- "Non credo che tu me l'abbia mai raccontato."
- "Aiutami a collegare i pezzi."
- "Questa non mi suona familiare."
- "Wait... I don't remember that part."
- "I don't think you've told me that before."
- "Help me connect the pieces."
- "That doesn't ring a bell."

Never invent memories.
Never pretend to remember something that is not stored.
Never guess past conversations.

TECHNICAL INVISIBILITY RULE:

Never mention:
- databases
- sessions
- context windows
- storage
- tokens
- system prompts
- AI limitations
- memory systems

The user should experience a companion, not software.

STYLE:
Keep it concise, human, and useful.
Ask questions only when they help.
No long lectures unless the user asks.
Use max one subtle emoji.
`.trim();
}

// -------------------- CORE REPLY --------------------
async function generateReply({ userText, lang, platform, userId }) {
  const clean = String(userText || "").trim();

  if (!clean) {
    return {
      text: addEmoji(
        lang,
        lang === "it"
          ? "Sono qui. Scrivimi qualcosa e resto con te."
          : lang === "de"
          ? "Ich bin hier. Schreib mir etwas, und ich bleibe bei dir."
          : "I’m here. Say something and I’ll stay with you."
      ),
    };
  }

  if (!OPENAI_API_KEY) {
    return {
      text: addEmoji(
        lang,
        lang === "it"
          ? "Ti ascolto. Dimmi cosa hai in mente."
          : lang === "de"
          ? "Ich höre dir zu. Sag mir, was dich beschäftigt."
          : "I’m listening. Tell me what’s on your mind."
      ),
    };
  }

  const history = await getConversationMemory(platform, userId, 12);
  const facts = await getFacts(platform, userId, 25);
  const projects = await getProjects(platform, userId, 20);

  const system = buildSystemPrompt({ lang, facts, projects });

  const resp = await safeFetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: system },
        ...history,
        { role: "user", content: clean },
      ],
      temperature: 0.8,
    }),
  });

  const json = await resp.json();

  if (!resp.ok) {
    console.log("❌ OpenAI error:", json);
    return {
      text: addEmoji(
        lang,
        lang === "it"
          ? "Sono qui, ma qualcosa si è inceppato. Riproviamo."
          : lang === "de"
          ? "Ich bin hier, aber etwas hat kurz gehakt. Versuch es nochmal."
          : "I’m here, but something got stuck. Try again."
      ),
    };
  }

  const out = json?.choices?.[0]?.message?.content?.trim();

  return {
    text: addEmoji(
      lang,
      out ||
        (lang === "it" ? "Sono qui." : lang === "de" ? "Ich bin hier." : "I’m here.")
    ),
  };
}

// -------------------- TELEGRAM --------------------
let bot = null;

function initTelegram() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.log("⚠️ Missing TELEGRAM_BOT_TOKEN. Telegram disabled.");
    return;
  }

  bot = new Telegraf(TELEGRAM_BOT_TOKEN);

  bot.start(async (ctx) => {
    const fromId = String(ctx.from?.id || "");
    await setPrefs("tg", fromId, { lang: "en", friendMode: true });

    await ctx.reply(
      "HITH is here.\n\nA private space to speak freely, without judgment. 🤍"
    );
  });

  bot.on("text", async (ctx) => {
    try {
      const fromId = String(ctx.from?.id || "");
      const text = ctx.message?.text || "";

      const prefs = await getPrefs("tg", fromId);
      const lang = prefs.lang || guessLangFromText(text);

      await setPrefs("tg", fromId, { lang, friendMode: true });
      await saveMessage("telegram", fromId, "user", text);

      await extractLongTermMemory("telegram", fromId, text, lang);

      const out = await generateReply({
        userText: text,
        lang,
        platform: "telegram",
        userId: fromId,
      });

      await saveMessage("telegram", fromId, "assistant", out.text);
      await ctx.reply(out.text);
    } catch (e) {
      console.error("Telegram handler error:", e?.message || e);
      try {
        await ctx.reply("Something went quiet for a moment. Try again.");
      } catch {}
    }
  });

  app.post(TG_PATH, bot.webhookCallback(TG_PATH));
}

async function setupTelegramWebhook() {
  if (!bot) return;

  if (!PUBLIC_URL) {
    console.log("⚠️ Missing PUBLIC_URL, cannot set Telegram webhook.");
    return;
  }

  const url = `${PUBLIC_URL}${TG_PATH}`;

  try {
    await bot.telegram.setWebhook(url, { drop_pending_updates: true });
    console.log("✅ Telegram webhook set:", url);
  } catch (e) {
    console.log("⚠️ Telegram setWebhook failed:", e?.message || e);
  }
}

// -------------------- WHATSAPP --------------------
app.get(WA_PATH, (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token && token === WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post(WA_PATH, async (req, res) => {
  res.sendStatus(200);

  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const msg = value?.messages?.[0];

    if (!msg) return;

    const from = String(msg.from || "");
    const text = msg?.text?.body || "";

    if (!text) {
      await sendWhatsAppText(from, "HITH can read text messages for now.");
      return;
    }

    const prefs = await getPrefs("wa", from);
    const lang = prefs.lang || guessLangFromText(text);

    await setPrefs("wa", from, { lang, friendMode: true });
    await saveMessage("whatsapp", from, "user", text);

    await extractLongTermMemory("whatsapp", from, text, lang);

    const out = await generateReply({
      userText: text,
      lang,
      platform: "whatsapp",
      userId: from,
    });

    await saveMessage("whatsapp", from, "assistant", out.text);
    await sendWhatsAppText(from, out.text);
  } catch (e) {
    console.error("WhatsApp webhook error:", e?.message || e);
  }
});

async function sendWhatsAppText(to, text) {
  if (!WHATSAPP_TOKEN || !WHATSAPP_PHONE_ID) {
    console.log("⚠️ WhatsApp not configured.");
    return;
  }

  const url = `https://graph.facebook.com/v21.0/${WHATSAPP_PHONE_ID}/messages`;

  const resp = await safeFetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });

  const j = await resp.json();

  if (!resp.ok) console.log("❌ WhatsApp send failed:", j);
  else console.log("✅ WhatsApp sent:", j?.messages?.[0]?.id || "ok");
}

// -------------------- DEBUG --------------------
app.get("/", (req, res) => {
  res.status(200).send("HITH is alive ✅");
});

app.get("/debug", (req, res) => {
  res.json({
    ok: true,
    publicUrl: PUBLIC_URL,
    openai: {
      enabled: !!OPENAI_API_KEY,
      model: OPENAI_MODEL,
    },
    telegram: {
      enabled: !!TELEGRAM_BOT_TOKEN,
      webhook: PUBLIC_URL ? `${PUBLIC_URL}${TG_PATH}` : null,
    },
    whatsapp: {
      enabled: !!(
        WHATSAPP_TOKEN &&
        WHATSAPP_PHONE_ID &&
        WHATSAPP_VERIFY_TOKEN
      ),
      callback: PUBLIC_URL ? `${PUBLIC_URL}${WA_PATH}` : null,
    },
    supabase: {
      enabled: !!supa,
      prefsTable: SUPABASE_TABLE,
      memoryTable: SUPABASE_MEMORY_TABLE,
      factsTable: SUPABASE_FACTS_TABLE,
      projectsTable: SUPABASE_PROJECTS_TABLE,
    },
  });
});

app.get("/memory-debug/:platform/:userId", async (req, res) => {
  const { platform, userId } = req.params;

  res.json({
    ok: true,
    platform,
    userId,
    conversation: await getConversationMemory(platform, userId, 10),
    facts: await getFacts(platform, userId, 25),
    projects: await getProjects(platform, userId, 20),
  });
});

// -------------------- START --------------------
(async function start() {
  await initSupabase();
  initTelegram();

  app.listen(PORT, async () => {
    console.log(`🚀 Server listening on ${PORT}`);
    console.log("🌐 PUBLIC_URL:", PUBLIC_URL || "(missing)");
    console.log("📌 Telegram:", TG_PATH);
    console.log("📌 WhatsApp:", WA_PATH);

    if (bot) await setupTelegramWebhook();
  });
})();

# Grace – Telegram Coach Bot (RABE/Legacy)

Multilingual coach bot for **WhatsApp/Telegram vision**, here the Telegram MVP. Languages: **IT / EN / DE**.
Focus: morning/evening routines, SOS moments, and the *Legacy* diary.

---

## 1) Quick start (local)

1. Install Node 18+ and run:
   ```bash
   npm install
   cp .env.example .env   # paste your bot token
   npm run start
   ```
2. Talk to your bot on Telegram after creating it with **@BotFather**, paste the token into `.env`.

> Default mode is **long polling** (works locally and on small VMs).

---

## 2) Commands

- `/start` – onboarding + language (IT/EN/DE) + goal.
- `/daily` – Morning routine (2 min).
- `/evening` – Evening routine (2 min).
- `/sos` – Short, compassionate guidance.
- `/legacy` – Save a memory/note for your legacy diary.
- `/settings` – Change language, timezone, goal, notification time.
- `/help` – Menu + tips.

The bot uses **inline keyboards** and saves state in memory; persistence stubs are included for **Supabase**.

---

## 3) Deploy (Railway/Render/Fly)

- Easiest: run long polling on a small dyno (no webhooks needed).
- For webhooks, set `WEBHOOK_DOMAIN` (e.g., your Render URL) and the bot will self-register on start.

---

## 4) Files

- `index.js` – Bot logic (Telegraf).
- `locales/*.json` – UI strings per language.
- `content/*.json` – 7-day scripts for morning/evening and SOS per language.

---

© 2025 RABE / Legacy – Grace.

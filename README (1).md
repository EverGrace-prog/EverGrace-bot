# EverGrace Bot 🤖✨

EverGrace è un **companion digitale** sviluppato con [Telegraf](https://telegraf.js.org/), [OpenAI](https://openai.com/), e [Supabase](https://supabase.com/).  
È pensato per essere:
- 🤝 un **Amico** con cui parlare liberamente  
- ✨ una **Guida spirituale** riflessiva  
- 🎯 un **Coach** pratico per fissare obiettivi e micro-azioni  

---

## 🚀 Funzionalità
- 🌐 Multilingue: Inglese (default), Italiano, Tedesco  
- 💬 Modalità conversazione: Amico / Spirituale / Coach & Goals  
- 📖 Diario digitale: aggiungi o consulta voci (salvate con data ISO, non chat history)  
- 🆘 SOS contestuale: risponde con empatia e con risorse immediate (112, 911, Samaritans)  
- 💎 Supporto: pulsante donazioni con livelli Silver (€2), Gold (€5), Diamond (€9) via Stripe  
- 🔄 Storico chat: mantiene un contesto breve per conversazioni più naturali  
- ☁️ Storage: Supabase (con fallback su `users.json`)  
- 🔁 Avvio robusto: retry automatico con long polling o webhook  

---

## 📂 Struttura del progetto
```
EverGrace/
├── index.js            # codice principale del bot
├── users.json          # fallback locale (se Supabase non è configurato)
├── rabe_bg.jpg         # brand card opzionale
├── package.json        # dipendenze npm
├── .env                # variabili ambiente (NON committare su GitHub)
└── README.md           # documentazione
```

---

## ⚙️ Setup locale
1. Clona il repo
   ```bash
   git clone https://github.com/<tuo-utente>/EverGrace-prog.git
   cd EverGrace-prog
   ```
2. Installa le dipendenze
   ```bash
   npm install
   ```
3. Crea un file `.env`:
   ```env
   BOT_TOKEN=telegram-bot-token
   OPENAI_API_KEY=sk-...
   SUPABASE_URL=https://xxxx.supabase.co
   SUPABASE_SERVICE_ROLE=your-service-role-key
   ```
4. Avvia il bot
   ```bash
   node index.js
   ```

---

## 🌐 Deploy
### Render
- Crea un servizio **Web Service** da GitHub  
- Aggiungi le variabili ambiente dal `.env`  
- Usa il piano **Hobby Free** per iniziare  

---

## 📌 Note
- Non condividere mai la tua **service role key** pubblicamente.  
- Se `rabe_bg.jpg` è presente, viene mostrata all’apertura del Diario.  
- Puoi modificare `toneSystemPrompt()` per cambiare la personalità del bot.  

---

✍️ Creato da **RABE** con amore 💛🖤  

// config.js
// Wrapper sicuro: legge tutto dalle Environment Variables.
// NON inserire segreti qui dentro.

module.exports = {
  env: process.env.NODE_ENV || 'production',

  // Telegram
  botToken: process.env.BOT_TOKEN,

  // OpenAI (opzionale se usi funzioni con OpenAI)
  openaiKey: process.env.OPENAI_API_KEY,

  // Supabase (URL pubblico + chiave anon/service impostate su Render)
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseKey: process.env.SUPABASE_KEY,
  supabaseServiceRole: process.env.SUPABASE_SERVICE_ROLE,

  // Porta per healthcheck HTTP (Render usa $PORT)
  port: Number(process.env.PORT || 3000),

  // Branding / version
  appName: 'EverGrace',
  versionTag: 'v-2025-10-01-MenuCoachJournal'
};

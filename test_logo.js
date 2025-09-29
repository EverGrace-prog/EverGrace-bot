import 'dotenv/config'
import { Telegraf } from 'telegraf'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { dirname } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = dirname(__filename)

const BOT_TOKEN = process.env.BOT_TOKEN
if (!BOT_TOKEN) {
  console.error('❌ Missing BOT_TOKEN in .env')
  process.exit(1)
}

const bot = new Telegraf(BOT_TOKEN)

// Comando: /logo
bot.command('logo', async (ctx) => {
  try {
    const logoPath = path.join(__dirname, 'rabe_logo.png')
    console.log('✅ Logo path:', logoPath)

    await ctx.replyWithPhoto(
      { source: fs.createReadStream(logoPath) },
      { caption: '🌟 Test logo inviato correttamente!' }
    )
  } catch (err) {
    console.error('❌ Errore nell’invio logo:', err)
  }
})

bot.launch().then(() => console.log('🚀 Test bot avviato. Scrivi /logo su Telegram'))

// test_telegram.js
import 'dotenv/config';
import { Telegraf } from 'telegraf';

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('BOT_TOKEN mancante in .env');
  process.exit(1);
}

const bot = new Telegraf(token);

(async () => {
  try {
    const me = await bot.telegram.getMe();
    console.log('Token OK ✅');
    console.log('Bot username:', '@' + me.username);
    console.log('Bot name    :', me.first_name);
  } catch (err) {
    console.error('Token KO ❌');
    console.error(err);
  } finally {
    process.exit(0);
  }
})();

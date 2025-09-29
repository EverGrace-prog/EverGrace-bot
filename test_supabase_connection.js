// test_supabase_connection.js
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE;

if (!url || !key) {
  console.error("❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE in .env");
  process.exit(1);
}

console.log("[env] URL:", url);
console.log("[env] KEY len:", key.length, "prefix:", key.slice(0, 6));

const supabase = createClient(url, key);

async function testConnection() {
  try {
    // Proviamo a leggere massimo 1 utente
    const { data, error } = await supabase.from('users').select('*').limit(1);

    if (error) {
      console.error("[supabase] Query error:", error.message);
    } else {
      console.log("[supabase] Query success:", data);
    }
  } catch (err) {
    console.error("[sdk] error:", err);
  }
}

testConnection();

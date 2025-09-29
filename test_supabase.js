import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'

// Prendi URL e KEY dal tuo .env
const supabaseUrl = process.env.SUPABASE_URL
const supabaseKey = process.env.SUPABASE_KEY
const supabase = createClient(supabaseUrl, supabaseKey)

async function main() {
  // 1. Inseriamo un utente di prova
  const { data: insertData, error: insertError } = await supabase
    .from('users')
    .insert([{ name: 'TestUser', language: 'en' }])

  console.log('Insert:', insertData, insertError)

  // 2. Leggiamo la tabella
  const { data: selectData, error: selectError } = await supabase
    .from('users')
    .select('*')

  console.log('Select:', selectData, selectError)
}

main()

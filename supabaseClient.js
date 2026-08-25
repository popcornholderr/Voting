const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
// Use the SERVICE ROLE key here (not the anon key) — this file only ever runs on
// the server, never sent to the browser, and needs to bypass RLS to read/write.
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

let client = null;

if (SUPABASE_URL && SUPABASE_KEY) {
  client = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false }
  });
} else {
  console.warn(
    '[supabase] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — ' +
    'running on local-file persistence only. Set them (see .env.example) to enable Supabase.'
  );
}

module.exports = client;

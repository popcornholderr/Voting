const { createClient } = require('@supabase/supabase-js');

let SUPABASE_URL = process.env.SUPABASE_URL;
// Use the SERVICE ROLE key here (not the anon key) — this file only ever runs on
// the server, never sent to the browser, and needs to bypass RLS to read/write.
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// supabase-js appends "/rest/v1" onto whatever base URL you give it. If .env
// already has that suffix on it (easy to do — it's literally in the field
// label in some Supabase dashboard screens), every request ends up hitting
// ".../rest/v1/rest/v1/..." and 404s. Strip it back off so either form works.
if (SUPABASE_URL) {
  SUPABASE_URL = SUPABASE_URL.replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
}

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

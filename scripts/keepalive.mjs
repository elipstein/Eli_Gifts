// scripts/keepalive.mjs
//
// Free-tier Supabase projects pause after ~7 days of inactivity. This writes a
// tiny heartbeat row (then prunes old ones) so the project stays awake. Run by
// .github/workflows/keepalive.yml every few days.
//
// Uses the SECRET key, which bypasses RLS. The dedicated `keepalive` table has
// RLS on with no public policies, so only this job can touch it — it never
// involves the `ideas` table or the web pages.
//
// Required env: SUPABASE_URL, SUPABASE_SECRET_KEY

import { createClient } from '@supabase/supabase-js';

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

const supabase = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SECRET_KEY'), {
  auth: { persistSession: false },
});

// Add a row — this write is what registers as activity.
const { error: insertError } = await supabase
  .from('keepalive')
  .insert({ pinged_at: new Date().toISOString() });
if (insertError) {
  console.error('Keep-alive insert failed:', insertError.message);
  process.exit(1);
}

// Prune anything older than a day so the table never grows.
const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
const { error: pruneError } = await supabase
  .from('keepalive')
  .delete()
  .lt('pinged_at', dayAgo);
if (pruneError) {
  console.error('Keep-alive prune failed:', pruneError.message);
  process.exit(1);
}

console.log('Supabase keep-alive ping OK (added a heartbeat row, pruned old ones).');

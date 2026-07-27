// scripts/keepalive.mjs
//
// Supabase free-tier keep-alive.
//
// Our previous approach — a background write with the SECRET key every 3 days —
// did NOT count as activity: the project paused anyway despite the pings. So this
// version instead mimics a real page visit: it uses the PUBLIC url + publishable
// key (exactly what a browser does) and runs a *different* harmless read of the
// `ideas` table each time, so no two pings look identical. Run several times a
// day by .github/workflows/keepalive.yml.
//
// These two values are the public client credentials — the same ones in
// docs/app.js. If you ever rotate the publishable key, update it in both places.
//
// NOTE: this is a best-effort defense. Supabase deliberately pauses idle
// free-tier projects and actively resists keep-alives, so it may still pause.
// If it does, just Restore it from the dashboard (data is preserved).

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://vusswtzedzeyyupmttoy.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_ZUniAM46QvpY0aZCCblPGw_6OayJeaz';

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: false },
});

const rnd = (n) => Math.floor(Math.random() * n);

// A harmless, randomized SELECT on `ideas` — ids/counts only, no content is
// fetched or logged. Randomizing the shape (columns, order, limit, count-vs-rows)
// means every ping is a little different.
function randomRead() {
  const limit = 1 + rnd(5);
  const ascending = Math.random() < 0.5;
  switch (rnd(4)) {
    case 0: return supabase.from('ideas').select('id').limit(limit);
    case 1: return supabase.from('ideas').select('id', { count: 'exact', head: true });
    case 2: return supabase.from('ideas').select('id, created_at').order('created_at', { ascending }).limit(limit);
    default: return supabase.from('ideas').select('id').order('id', { ascending }).limit(limit);
  }
}

// Do a random handful of reads per run (like a visitor loading a page or two).
const pings = 1 + rnd(3);
for (let i = 0; i < pings; i++) {
  const { error } = await randomRead();
  if (error) {
    console.error('Keep-alive read failed:', error.message);
    process.exit(1);
  }
}

console.log(`Supabase keep-alive OK — ${pings} varied read(s), page-visit style.`);

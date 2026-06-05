// scripts/generate.mjs
//
// Weekly gift-idea generator (build step 2).
//
// Reads config/interests.md, asks Claude — with web search enabled — for a few
// fresh, real, currently-purchasable gift ideas that don't repeat anything
// already in the Supabase `ideas` table, then inserts them as
// status: 'new', source: 'ai'.
//
// Run locally:  node --env-file=.env scripts/generate.mjs   (or: npm run generate:local)
// In CI:        env vars come from GitHub Actions secrets.
//
// Required env: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SECRET_KEY
//
// Model + tool strings were confirmed against the Anthropic docs, as the build
// spec instructs — these move, so re-check if you bump them:
//   - claude-sonnet-4-6      (the spec asks for "a current Sonnet model")
//   - web_search_20260209    (current web search tool; dynamic filtering is automatic)
//   - web_fetch_20260209     (lets the model confirm a specific buy link / price)

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const MODEL = 'claude-sonnet-4-6';
const WEB_SEARCH_TOOL = 'web_search_20260209';
const WEB_FETCH_TOOL = 'web_fetch_20260209';
const IDEAS_WANTED = '5 to 10';
const MAX_CONTINUATIONS = 6; // safety cap for server-tool `pause_turn` resumes

const __dirname = dirname(fileURLToPath(import.meta.url));
const INTERESTS_PATH = join(__dirname, '..', 'config', 'interests.md');

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

const SUPABASE_URL = requireEnv('SUPABASE_URL');
const SUPABASE_SECRET_KEY = requireEnv('SUPABASE_SECRET_KEY');
requireEnv('ANTHROPIC_API_KEY'); // read implicitly by the Anthropic client

const anthropic = new Anthropic(); // picks up ANTHROPIC_API_KEY from the env
const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { persistSession: false },
});

// ---- 1. Read the interests brief --------------------------------------------
const interests = await readFile(INTERESTS_PATH, 'utf8');

// ---- 2. Pull every existing title (the no-repeat list) ----------------------
const { data: existing, error: selectError } = await supabase
  .from('ideas')
  .select('title');
if (selectError) {
  console.error('Failed to read existing ideas from Supabase:', selectError.message);
  process.exit(1);
}
const existingTitles = (existing ?? []).map((row) => row.title).filter(Boolean);
console.log(`Found ${existingTitles.length} existing idea(s) — these will not be repeated.`);

// ---- 3. Build the prompt ----------------------------------------------------
const SYSTEM_PROMPT = [
  'You are a meticulous personal gift scout. You surface real, specific,',
  'currently-purchasable products tailored to one person. For every item you',
  'propose, use web search (and web fetch) to confirm it actually exists and is',
  'for sale right now, capture a working purchase link, and record a realistic',
  'current price. Never invent products, links, or prices — if you cannot verify',
  'an item, drop it and find another. It is better to return a few well-verified',
  'ideas than to pad the list with guesses.',
].join(' ');

const noRepeatList = existingTitles.length
  ? existingTitles.map((t) => `- ${t}`).join('\n')
  : '(none yet)';

const userPrompt = `Find ${IDEAS_WANTED} fresh gift ideas for the person described below.

# Who the gifts are for
${interests}

# Do NOT repeat or near-duplicate any of these (already on the list)
${noRepeatList}

# Requirements
- Every item must be a real, specific product purchasable right now. Use web search to confirm it exists, then give a working buy link and a realistic current price.
- Do not repeat or near-duplicate anything in the no-repeat list above, and don't propose near-duplicates of each other.
- Spread the ideas across different categories rather than clustering in one.
- Respect the budget bands and the "things to avoid" in the description above.
- Prefer a specific model/edition over a generic category (a named grinder, not "an espresso grinder").

# Output format
Return ONLY a JSON array — no prose, no markdown code fences — of objects shaped EXACTLY like:
[
  {
    "title": "short product name",
    "description": "1-2 sentences on why it fits this person",
    "category": "short lowercase tag, e.g. espresso, 3d-printing, cooking, gardening",
    "est_price": "e.g. $120-150",
    "url": "direct link where it can be bought"
  }
]
Return nothing except the JSON array.`;

// ---- 4. Call Claude with web search, resuming on pause_turn ------------------
const tools = [
  { type: WEB_SEARCH_TOOL, name: 'web_search' },
  { type: WEB_FETCH_TOOL, name: 'web_fetch' },
];
const messages = [{ role: 'user', content: userPrompt }];

let response;
for (let i = 0; ; i++) {
  response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system: SYSTEM_PROMPT,
    tools,
    messages,
  });

  // Server-side tools run an internal loop; if it hits its iteration cap the
  // turn pauses. Re-send the assistant turn (no extra user message) to resume.
  if (response.stop_reason === 'pause_turn' && i < MAX_CONTINUATIONS) {
    messages.push({ role: 'assistant', content: response.content });
    continue;
  }
  break;
}

if (response.stop_reason === 'refusal') {
  console.error('Model refused to produce ideas:', response.stop_details ?? '');
  process.exit(1);
}
if (response.stop_reason === 'max_tokens') {
  console.warn('Warning: response hit max_tokens — output may be truncated.');
}

// ---- 5. Parse defensively ---------------------------------------------------
const rawText = response.content
  .filter((block) => block.type === 'text')
  .map((block) => block.text)
  .join('\n')
  .trim();

function extractJsonArray(raw) {
  let s = raw.trim();
  // Strip a ```json ... ``` fence if the model added one despite instructions.
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  }
  // Grab the outermost [...] in case any stray prose slipped in around it.
  const first = s.indexOf('[');
  const last = s.lastIndexOf(']');
  if (first !== -1 && last > first) {
    s = s.slice(first, last + 1);
  }
  return JSON.parse(s);
}

let ideas;
try {
  ideas = extractJsonArray(rawText);
} catch (err) {
  console.error('Could not parse model output as JSON:', err.message);
  console.error('--- raw output ---\n' + rawText);
  process.exit(1);
}
if (!Array.isArray(ideas)) {
  console.error('Model output parsed but was not a JSON array.');
  process.exit(1);
}

// ---- 6. Shape, de-dupe defensively, and insert ------------------------------
const existingLower = new Set(existingTitles.map((t) => t.toLowerCase().trim()));
const rows = ideas
  .filter((it) => it && typeof it.title === 'string' && it.title.trim())
  .filter((it) => !existingLower.has(it.title.toLowerCase().trim()))
  .map((it) => ({
    title: it.title.trim(),
    description: typeof it.description === 'string' ? it.description.trim() : null,
    category: typeof it.category === 'string' ? it.category.trim() : null,
    est_price: typeof it.est_price === 'string' ? it.est_price.trim() : null,
    url: typeof it.url === 'string' ? it.url.trim() : null,
    source: 'ai',
    status: 'new',
  }));

if (rows.length === 0) {
  console.log('No new ideas to insert (model returned none, or all were duplicates).');
  process.exit(0);
}

const { data: inserted, error: insertError } = await supabase
  .from('ideas')
  .insert(rows)
  .select('id');
if (insertError) {
  console.error('Failed to insert ideas:', insertError.message);
  process.exit(1);
}

// ---- 7. Log -----------------------------------------------------------------
console.log(`Inserted ${inserted?.length ?? rows.length} new idea(s):`);
for (const row of rows) {
  console.log(`  • [${row.category ?? 'uncategorized'}] ${row.title} — ${row.est_price ?? 'n/a'}`);
}

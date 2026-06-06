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
//   - web_search_20250305    (basic web search; no code-execution container)
//
// Tip: set SMOKE=1 to dry-run the whole pipeline cheaply (Haiku, no web search).

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const MODEL = 'claude-sonnet-4-6';
// Basic web search (no dynamic filtering) — it does NOT spin up a code-execution
// container, so there's nothing to thread through pause/resume. The newer
// _20260209 does, which is what 400'd an earlier run. max_uses hard-caps spend.
const WEB_SEARCH_TOOL = 'web_search_20250305';
const MAX_SEARCHES = 8;
const IDEAS_WANTED = '5 to 10';
const MAX_CONTINUATIONS = 6; // safety cap for server-tool `pause_turn` resumes

// SMOKE=1 → cheap end-to-end test: Haiku, no web search, ~a fraction of a cent.
// Proves DB read → model → parse → insert before paying for a real run. The
// ideas it inserts are flagged [TEST] and are not web-verified; delete them after.
const SMOKE = process.env.SMOKE === '1' || process.env.SMOKE === 'true';

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

// Reads ANTHROPIC_API_KEY from the env. Generous timeout for multi-minute
// web-search runs (the request also streams). maxRetries: 0 so a failure fails
// fast instead of silently re-running the whole search three times.
const anthropic = new Anthropic({ timeout: 15 * 60 * 1000, maxRetries: 0 });
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
  'propose, use web search to confirm it actually exists and is',
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

// ---- 4. Ask the model for ideas ---------------------------------------------
let response;

if (SMOKE) {
  // Cheap plumbing check: Haiku, no web search, no thinking — a fraction of a
  // cent. Proves the whole path works before we pay for a real web-search run.
  console.log('SMOKE MODE: Haiku, no web search. Inserted ideas are [TEST] placeholders.');
  response = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 2000,
    system: 'Return only a JSON array, no prose and no code fences.',
    messages: [{
      role: 'user',
      content: `Suggest 3 plausible gift ideas (from general knowledge — do NOT browse) for the person below, as a strict JSON array of objects with keys title, description, category, est_price, url.\n\n${interests}`,
    }],
  });
} else {
  // Real run: web search (capped), streamed so a multi-minute run doesn't time out.
  const tools = [{ type: WEB_SEARCH_TOOL, name: 'web_search', max_uses: MAX_SEARCHES }];
  const messages = [{ role: 'user', content: userPrompt }];
  for (let i = 0; ; i++) {
    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: 8000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });
    response = await stream.finalMessage();

    // Basic web search has no code-execution container; on pause_turn just
    // re-send the assistant turn (no extra user message) to resume.
    if (response.stop_reason === 'pause_turn' && i < MAX_CONTINUATIONS) {
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }
    break;
  }
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
    title: (SMOKE ? '[TEST] ' : '') + it.title.trim(),
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

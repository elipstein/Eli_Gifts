# Gift Engine

A self-running pipeline that generates gift ideas tailored to me, routes them to my wife for triage, and quietly surfaces the ones she rejects back to me.

This file is both the repo README and the build spec. If you're Claude Code: build the project described below, in the order under "Build order." Verify any Anthropic API specifics (current model string, web search tool version) against https://docs.claude.com before writing the generator — those move.

---

## Goal

Every week, an automated job discovers real, currently-purchasable gift ideas matched to my interests and drops them into a shared list. My wife visits a private URL, sees new ideas, and either **keeps** one (it becomes her gift shortlist — I must not see these) or **passes** on it (it becomes visible to me, so I can buy it for myself). I can also seed the system: both with broad "avenues to explore" and with specific gifts I already want.

---

## Privacy model (read this first — it shapes everything)

Privacy is **soft / honor-system**, by my explicit choice. The rule is "don't show me kept items by default," not "make it cryptographically impossible for me to see them."

- The entire privacy mechanism is the `status` column on the `ideas` table.
- My wife's page renders `new` and `kept` items.
- My page renders **only** `passed` items, plus a form to add my own ideas.
- The data lives in one Supabase database that is technically readable in a browser's network tab. My page simply never *queries or renders* kept items. I agree not to go looking. That's the deal.
- Do **not** over-engineer this into server-side access control. If strict privacy is ever wanted later, that's a separate, larger build (a server-side function gating reads); it is explicitly out of scope now.

---

## Architecture

```
config/interests.md  ──►  Weekly GitHub Action (cron)  ──►  Anthropic API + web search
                                                                      │
                                                                      ▼
                                                            Supabase `ideas` table
                                                          (status: new | kept | passed)
                                                              │                  │
                                                              ▼                  ▼
                                                   her.html (new + kept)   index.html (passed only)
```

- **GitHub repo** — holds the code, the interests config, and the prompt. Free.
- **GitHub Actions** — weekly cron, no server to maintain. Free.
- **GitHub Pages** — serves the static site. Free.
- **Anthropic API** — the generator; web search enabled so it finds real products with live links/prices instead of hallucinating. Cost is pennies per weekly run.
- **Supabase** — the one external "free cloud tier" piece; holds the ideas and their status. (Cloudflare D1 is an acceptable swap if preferred.)

---

## Tech stack

- **Runtime for the generator:** Node (ESM, `.mjs`). No framework needed.
- **DB:** Supabase (Postgres) via `@supabase/supabase-js`.
- **Site:** plain static HTML/CSS/JS. No build step — GitHub Pages serves `/docs` directly. (A framework is overkill for two pages.)
- **AI:** Anthropic Messages API with the web search tool. Use a current Sonnet model for the cost/quality balance on a weekly batch job; confirm the exact model string and web-search tool version in the docs.

---

## Data model

Single table, `ideas`:

| column             | type          | notes                                          |
|--------------------|---------------|------------------------------------------------|
| `id`               | uuid          | primary key, default `gen_random_uuid()`       |
| `created_at`       | timestamptz   | default `now()`                                |
| `title`            | text          | short product name                             |
| `description`      | text          | why it fits me — the "pitch"                   |
| `category`         | text          | e.g. espresso, 3d-printing, cooking, gardening |
| `est_price`        | text          | fuzzy ranges are fine, e.g. "$120–150"         |
| `url`              | text          | where to buy                                   |
| `source`           | text          | `'ai'` or `'eli'`                              |
| `status`           | text          | `'new'` \| `'kept'` \| `'passed'`, default `'new'` |
| `status_changed_at`| timestamptz   | set when status changes                        |

`db/schema.sql` should contain the `CREATE TABLE` plus a check constraint on `source` and `status`.

---

## Two kinds of input from me

1. **Avenues to explore** (seeds for the AI) → I edit `config/interests.md`. The generator reads this every run. Example seeds: "manual espresso grinders under $400," "Prusa MK4 upgrades," "Israeli/Levantine cookbooks," "za'atar harvest + drying tools," "travel-points accessories."
2. **Specific gifts I already want** (finished ideas) → these should land in the DB directly as `status: new, source: eli` so my wife triages them in the same flow as AI ideas.

**Decision (default chosen):** add specific gifts via a small "add idea" form on `index.html` that writes straight to Supabase. (Alternative, not chosen: commit them to a file and let the generator ingest them — simpler code but they'd pass through dedup. The in-site form is the better UX; build that.)

---

## The generator (the make-or-break part)

`scripts/generate.mjs` should:

1. Read `config/interests.md` (the full text) as context.
2. Query Supabase for **all existing idea titles** (every status) — this is the no-repeat list.
3. Call the Anthropic API **with web search enabled**, asking for ~5–10 fresh ideas. The prompt should:
   - Use the interests text as the description of who the gifts are for.
   - Pass the existing titles and instruct: do not repeat or near-duplicate any of these.
   - Require real, currently-purchasable items with a working buy link and a realistic price.
   - Spread ideas across categories rather than clustering.
   - Respect any budget bands and "things to avoid" listed in `interests.md`.
   - Return a **strict JSON array** of objects matching the table fields (`title, description, category, est_price, url`), no prose, no markdown fences.
4. Parse defensively (strip any stray fences, `try/catch`), then insert each as `status: new, source: ai`.
5. Log how many were inserted.

Tune this by running it manually several times and reading the output before trusting the cron. Garbage in, garbage gift list.

---

## The two pages

`docs/her.html` — my wife's page:
- "New" feed: cards showing title, pitch, price, buy link, with **Keep** and **Pass** buttons (update `status` + `status_changed_at`).
- "Kept" tab/section: her private shortlist. Sorted newest first. Mobile-friendly — she'll use a phone.

`docs/index.html` — my page:
- Renders **only** `status = passed` items (things she rejected, which I can claim).
- An "add my own idea" form writing `status: new, source: eli` to Supabase.

`docs/app.js` — shared Supabase client init + render/update helpers.
`docs/styles.css` — keep it clean and legible on mobile.

---

## File structure

```
gift-engine/
├── README.md                       (this file)
├── package.json
├── .github/
│   └── workflows/
│       └── generate.yml            (weekly cron → runs scripts/generate.mjs)
├── config/
│   └── interests.md                (I edit: interests, avenues, budget, avoid-list)
├── scripts/
│   └── generate.mjs                (Anthropic API → Supabase)
├── db/
│   └── schema.sql                  (Supabase table)
└── docs/                           (GitHub Pages serves this folder)
    ├── index.html                  (my page)
    ├── her.html                    (wife's page)
    ├── app.js
    └── styles.css
```

---

## Secrets & config

GitHub repo → Settings → Secrets and variables → Actions:
- `ANTHROPIC_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY` — used by the Action to insert rows.

Committed in the client JS (public — acceptable under soft privacy):
- `SUPABASE_URL` + `SUPABASE_ANON_KEY`.

GitHub Pages: serve from the `/docs` folder on the main branch.

Cron in `generate.yml`: weekly, e.g. `0 14 * * 1` (Mondays 14:00 UTC ≈ early Monday Pacific). Also add `workflow_dispatch` so it can be triggered manually during tuning.

---

## Build order

1. **Repo + data model.** Scaffold the file structure, write `db/schema.sql`, create the Supabase project and run the schema. Seed `config/interests.md` with my real interests and avenues. Nothing user-facing yet.
2. **The generator.** Write `generate.mjs`. Run it manually (`workflow_dispatch` or local) several times. Read the output, tune the prompt until the ideas are genuinely good and non-repeating.
3. **Her page.** Build `her.html` — new feed + Keep/Pass + kept list. Deploy to Pages, test on a phone, hand her the URL.
4. **My page.** Build `index.html` — passed-items view + add-idea form.
5. **Turn on the cron.** Enable the weekly schedule. (Optional, later: a weekly email nudging her that new ideas landed.)

---

## Cost

GitHub Actions, Pages, and Supabase free tier are all $0 at this scale. The only spend is the weekly API call — a few cents per run. Comfortably under a few dollars a month.

---

## Seed content for `config/interests.md`

Start `interests.md` with these sections, then fill in over time:

- **Hard interests** — espresso gear, 3D printing (Prusa), Israeli/Levantine + Mediterranean cooking, bread baking, pizza-oven accessories, gardening (Mediterranean herbs), home automation (Home Assistant), travel/points accessories, longevity/health.
- **Avenues to explore** — the broad directions to mine each week (see examples above).
- **Budget bands** — e.g. stocking-stuffer ($0–40), mid ($40–150), splurge ($150–500).
- **Things to avoid** — anything already owned, gift cards, generic/low-effort items.

# JobScout

A live job aggregator + application tracker for a targeted engineering search.
It pulls postings straight from company ATS boards (Greenhouse, Lever, Ashby),
filters to engineering roles, scores each one on whether it's worth applying to,
and measures what actually comes back — all deployable free on Vercel.

## Why it exists

A static "companies hiring" list is stale in a week. This generates the list on
demand from the source of truth (each company's own job board API), so it's
always current.

More importantly, it answers the question that matters after a few dozen
applications: **why am I not hearing back?** Most job boards rank by "does this
title look like you". That's the wrong question — nearly every engineering
posting matches, so the ranking flattens into noise. This one ranks by *is this
worth an application*, which is dominated by two things:

1. **Eligibility** — can you actually be hired for it, or are you screened out on
   question one? A "Remote" role at a company that only employs people in the US
   is not a remote role for you.
2. **Freshness** — a req that's been open for months is usually filled, frozen,
   or buried under a thousand applicants. Applying on day 2 beats a perfect title
   match on day 80.

Title and stack matching are tiebreakers.

## Stack

- **Next.js (App Router) + TypeScript** — UI, server actions, API routes, worker
- **Postgres (Neon) + Drizzle ORM** — job cache + application tracker
- **Vercel Cron** — daily refresh (`vercel.json`)

## How it works

```
ATS APIs ──connectors/──▶ normalize ──▶ engineeringGate ──▶ assessEligibility ──▶ scoreJob ──▶ Postgres
(greenhouse, lever,      (RawPosting,   (drop non-eng     (regions + visa       (0-100)        │
 ashby, smartrecruiters,  + description) + sales roles)    blockers)                           ▼
 rippling)                                                                  Board / Tracker / Insights
```

- **Connectors** (`src/lib/connectors/`) — one per ATS, each returning a
  normalized `RawPosting`. Greenhouse, Lever and Ashby hand back the full
  description in the list call. SmartRecruiters and Rippling don't, so those two
  fetch details per posting — but only for postings where the description can
  change the verdict (see below). Add an ATS by dropping in a new connector.
- **Regions** (`src/lib/regions.ts`) — turns free-text locations ("Hybrid -
  Bangalore, India", "Remote (EMEA)", "AMER", "Global") into structured regions.
- **Eligibility** (`src/lib/eligibility.ts`) — combines the posting's regions,
  the company's actual hiring footprint, and work-authorization phrases found in
  the description into `eligible` / `longshot` / `blocked`.
- **Profile + scoring** (`src/lib/profile.ts`, `scoring.ts`) — all tuning lives
  in `profile.ts`. Edit keywords/levels/weights to re-rank the board with zero
  code changes.
- **Refresh** (`src/lib/refresh.ts`) — replaces each company's rows per run,
  carrying `firstSeenAt` forward so "new since yesterday" survives the rewrite.
- **Queue + worker** (`src/lib/queue.ts`, `worker.ts`) — one durable task per
  company, so a refresh isn't capped by a single function timeout. See
  [Background refresh](#background-refresh).
- **Insights** (`src/lib/insights.ts`) — reply rate sliced by eligibility,
  posting age, remote, company and board.

## The three pages

- **Board** — ranked roles. Blocked ones are hidden by default; the filter bar
  can show them. Each card carries its eligibility, posting age, and why it
  scored what it did. **Untracked only** hides anything already in the tracker,
  so the board reads as what's left to do rather than what you've already done.
- **Tracker** — your pipeline. Records **when you applied** and **when anyone
  first replied**; anything silent for 21 days is marked ghosted rather than
  quietly occupying a column forever.
- **Insights** — the funnel. Reply rate overall and broken down, so you can see
  *which kinds* of applications get answered instead of guessing.

## Local setup

```bash
pnpm install
cp .env.example .env          # add your Neon DATABASE_URL
pnpm db:push                  # create tables
pnpm dev                      # http://localhost:3000
```

Then click **Refresh now** on the Board (or `POST /api/queue/enqueue`) to pull
jobs. Refresh a single company while debugging: `GET /api/refresh?company=Neon`.

`pnpm db:push` needs drizzle-kit 0.31+. Older versions misread Postgres 17+
not-null constraints and try to drop every one of them, which fails on the
primary key and leaves the schema half-applied.

### Boards without descriptions in the list call

SmartRecruiters and Rippling need a request per posting to get the description,
which would be hundreds of calls per board. `connectors/detail.ts` fetches only
the ones that can change the answer.

The description feeds exactly one decision — the `blockPhrases` check in
`eligibility.ts` — and that only ever flips the verdict for postings already in
play: explicitly in a region you can work in, borderless ("Global"), or with no
parseable location. A role explicitly located somewhere you'd need sponsorship is
`blocked` on location alone and nothing in its text can change that, so we don't
ask for it. On Rippling's board that's 46 detail calls instead of 138, and the
whole board takes ~7s.

The trade-off is visible and deliberate: on Rippling, where the *posted date*
also only exists on the detail call, un-hydrated postings are ranked with an
unknown age (a small penalty) rather than a wrong one. They're the ones already
blocked on location, so they sink either way.

Also worth knowing: SmartRecruiters is paginated, so it sends no ETag we can
trust (page one being unchanged says nothing about page four) and Rippling sends
`cache-control: no-store`. Both boards are re-read in full each run; the
conditional-request savings apply to the other three.

## Background refresh

Fetching 31 boards inside one request was always going to hit the 60s
serverless limit, and it meant one slow board could take down a whole run with
nothing retried. Refreshes now go through a Postgres-backed queue.

```
enqueue ──▶ refresh_tasks (one durable row per company)
                  │
                  │  claim: UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED)
                  ▼
            worker invocation ──▶ connector ──▶ 200: rewrite rows
              (25s of claiming)                  304: nothing to do
                  │                              5xx/429: back off, retry
                  ▼
            done │ failed(retry) │ dead
```

- **Claiming is a lease, not a delete.** A worker killed mid-fetch leaves its row
  `running` with an expired `leaseUntil`, and the next worker takes it back.
  Nothing is lost and there's no janitor process. (Verified: killing the dev
  server mid-run stranded three boards, which the next worker picked up.)
- **Claims are atomic in one statement.** Neon's HTTP driver has no
  multi-statement transactions, so the claim is a single `UPDATE … FOR UPDATE
  SKIP LOCKED` — concurrent workers can never take the same company.
- **Conditional requests.** Each board's `ETag` is stored and sent back next run.
  All three ATSs support it, so a warm queue is mostly 304s: a re-run right after
  a full refresh had 27 of 31 boards answer "unchanged", costing no transfer and
  no writes.
- **Backoff respects the host.** `Retry-After` wins when a board sends one;
  otherwise 20s → 40s → 80s with jitter, then the board is parked as `dead`
  after 4 attempts rather than retried into a ban.
- **Politeness.** Boards are fetched a few at a time with a jittered gap, and the
  User-Agent carries `JOBSCOUT_CONTACT` so anyone who wants us to stop can say so.

### Endpoints

| Route | Does |
|---|---|
| `POST /api/queue/enqueue` | Queue every company (`?company=Neon` for one) and start a worker |
| `POST /api/queue/work` | Drain for ~25s, return what's left in `remaining` |
| `GET /api/queue/status` | Per-board state, last error, last result |
| `GET /api/refresh` | Synchronous refresh, no ETags — for debugging one connector |

A worker deliberately does **not** chain to itself. Aborting a "fire and forget"
trigger kills the request handler it just started, and awaiting the child means
the parent dies first and takes the child with it. Instead, whoever is driving
the run calls again while `remaining > 0`: the scheduler loop below, or the
board's status strip while a tab is open.

### Scheduling

`vercel.json` registers the daily cron Hobby allows. For a search where "posted
in the last 3 days" is the top-scoring signal, daily is too coarse, so
`.github/workflows/refresh.yml` ticks every 6 hours for free and loops until the
queue reports `remaining: 0`. Set `JOBSCOUT_URL` and `CRON_SECRET` as repo
secrets to use it.

## Deploy (Vercel, free)

1. Push to GitHub, import into Vercel.
2. Add `DATABASE_URL` (Neon), and optionally `CRON_SECRET` and
   `JOBSCOUT_CONTACT`, as env vars.
3. Deploy. `vercel.json` registers the daily cron (`0 6 * * *`).

## Tuning your search

Everything is in `src/lib/profile.ts`:

- `basedIn` / `alsoEligibleIn` — where you can work without sponsorship. This is
  the highest-impact setting in the file.
- `blockPhrases` — description text that means an automatic rejection
  ("we do not sponsor", "must be authorized to work in the United States").
- `freshness` — how hard to penalise old postings.
- `weights` — relative pull of eligibility, freshness, level and stack.
- `roleKeywords` / `seniorityPreferred` / `seniorityAvoid` — titles and level.
  Matched on word boundaries, so `lead` catches "Lead, Engineering" but not
  "leadership".
- `titleExclusions` — titles containing "engineer" that aren't software jobs
  (Customer Engineer, Solutions Engineer).
- `engineeringGate` — which titles are kept in the DB at all.

### Keeping `hiresIn` honest

`companies.ts` declares which regions each company actually employs people in.
It's used when a posting's own location is vague — a "Global" listing from a
company with no presence where you live is a long shot, not an opportunity.

`GET /api/audit` re-derives this from live board data and flags any company whose
declared `hiresIn` its own board contradicts. Run it after adding companies, and
occasionally to catch drift. It touches no database.

## Roadmap ideas

- Dedupe the same role posted on multiple boards.
- Email/Slack digest of new eligible roles.
- Track referrals separately — cold applications and referred ones have very
  different reply rates, and mixing them muddies the Insights numbers.

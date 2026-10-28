# FlickAtlas Watchdog — System Specification

> This file is the watchdog's brain. Every hourly AI-watch call gets this
> document + a compact live state summary. When the process changes, this
> file MUST change with it — a stale spec makes the watchdog judge a
> healthy system as broken (or worse, a broken one as healthy).
>
> Times are Pakistan Time (PKT, UTC+5) unless marked UTC. "Today" means
> the PKT calendar day.

## 1. What FlickAtlas is

Entertainment-info website (AdSense). No watch/download buttons. Content:
movies (Bollywood + World Cinema + Pakistani), box office (India Net
day-wise, Sacnilk model), news articles, Pakistani drama episode guides
with Roman Urdu summaries, reviews, trailers, OTT info.

- **Live site:** https://flickatlas.co.uk — Cloudflare Worker `flickatlas`
  (also flickatlas.hidden-decodes.workers.dev).
- **Repos:** `Msohaib012/flickatlas-site` (main — site + pipeline),
  `Msohaib012/Flickposts` (branch `cue/flickatlas-admin-review-2026-10-24` —
  admin panel; branch `muse/fetch-automation` — fetch state + queue).
- **Admin panel:** https://flickatlas-admin.hidden-decodes.workers.dev —
  Cloudflare Worker `flickatlas-admin`, version panel-4.

## 2. The hourly machine (cadence)

| Piece | Schedule | Notes |
|---|---|---|
| Hourly pipeline (site) | `:35 * * * *` UTC, one job `hourly` | ONE commit per run (`scripts/commit_with_retry.sh`, 3-attempt rebase retry). A failed step never fails the run (`continue-on-error: true` on most steps); the commit + deploy still run. |
| Dispatcher (Worker `flickatlas-dispatcher`) | cron `50 * * * *` UTC | Sole scheduler (watchdog disabled 2026-10-27). Hour-coverage rule: skip only if a run started *this* hour is in-flight or succeeded; a failed hour is retried at :50; the "too recent" guard applies only to in-flight runs. A run belongs to the UTC hour it started in. |
| Fetch workflow (Flickposts) | `:17 * * * *` UTC | Runs the fetch-automation branch code; commits state + queue back to that branch. Has a concurrency group (`flickatlas-fetch`, no cancel). |
| AI watchdog (site, own workflow `watchdog.yml`) | PRIMARY: dispatched by the pipeline AFTER the deploy step · BACKUP: own schedule `:25 * * * *` UTC | Own workflow since 2026-10-28 (owner rule: "watchdog bhi GitHub/Gemini ki tarah so na jaye"). NEVER a pipeline step — it must not depend on the system it watches. See §16. |

A normal hour, in ORDER: fetch (site) → Gemini batch (2 drafts) →
apply → box office / overseas / stats as gated → record step runs +
daily history → commit → deploy to Cloudflare → **watchdog check**
(dispatched by the pipeline after deploy; verdict covers that run's
hour). Total pipeline run ~16–30 min; the multi-source box-office step
alone takes 5–12 min (7 readers × many titles). A slow run is NOT a
stuck run.

## 3. Sources (fetching)

- **Site registry** `scripts/registry.json`: **137 sources** (2026-10-28,
  after removing 2 DNS-dead). Flickposts registry: 134.
- **Fetch step** `scripts/fetch.py --registry scripts/registry.json --out out`
  reads every source's RSS/Atom, writes `out/queue.json` (this run's new
  stories, ~30–250/run), `out/categories/<slug>.json` (per-category files),
  `out/report.json` (per-source status + per-category counts + dropped counts).
- **Per-source status:** `ok` / `error` / `unchanged` / `baseline`.
  15–23 sources error EVERY run — known: 2 were DNS-dead (removed
  2026-10-28), **13 are bot-walled but ALIVE** (403/502/526/415 from
  GitHub runner IPs: Gadgets 360, NRIPage, Tellychakkar, Indian Express,
  News18, Firstpost, Instant Bollywood, NDTV Movies, Box Office Pro,
  Reelgood, HUM TV, DramaWiki, People) — kept by the OWNER's call, do NOT
  propose removing them as a "fix". Pinkvilla returns 404.
- **Dropped items** (never a failure): `section-page` (sitemap section
  pages), `slug-title`, `no-date`, `sports-section`,
  `fallback-blocked-non-entertainment`.
- **Queue:** panel queue `data/triage-queue.json` (Flickposts) ~1,089
  items after the first live rotation (2026-10-28, was 4,961).
  Rotation is **LIVE on schedule** (owner's 24-hour news rule):
  every hour, never-picked items discovered >24h ago are archived +
  the size trim down to ~850 KB. Archive-only, nothing is ever
  deleted; approved/decided items are protected. The site pipeline
  sees only the per-run queue
  (`out/queue.json`); the backlog total lives panel-side. Panel import
  dedupes by URL.

## 4. Categories + division of sources

Sources are NOT assigned to categories one by one. `scripts/fetch.py`
`classify()` assigns each item a category from its **title + URL slug
keywords, priority order (first match wins)**. The category is only a
HINT — the real category is re-decided at AI draft time from the panel's
categories.

Priority order (11 categories):

1. **Box Office** — box office, collection, day N, opening weekend,
   worldwide gross, occupancy, crore/cr
2. **Awards** — awards, oscar, bafta, grammy, emmy, nomination, filmfare
3. **Trailers** — trailer, teaser, first look, motion poster
4. **Music / OST** — song, soundtrack, ost, music video, album, single,
   concert, tour, debut, title track
5. **Episodes** — episode, ep N, episode guide
6. **Upcoming releases** — release date, releasing, in theatres/cinemas,
   arrives on, Diwali/Eid/Christmas + release
7. **OTT / Streaming** — ott, netflix, prime video, disney, hotstar,
   web series, streaming, sonyliv, zee5, jiohotstar
8. **TV & Dramas** — drama, tv show, serial, television, reality show,
   daily soap, tv series, finale, contestant
9. **Celebrity news & events** — celebrity, spotted, birthday, wedding,
   engagement, dating, vacation, red carpet, funeral, hospitalised
10. **Movies** — film, movie, actor, actress, director, cast, bollywood,
    hollywood, cinema, shooting, wrap, sequel, franchise, remake, biopic
11. **Entertainment viral** — viral, trending, trolled, fans react,
    social media

Anything matching nothing is DROPPED (not queued).

### Per-category draft quotas (commit d7005b18, sum = DAILY_CAP 40)

| Category | Quota/day |
|---|---|
| movies | 6 |
| box_office | 6 |
| celebrities | 5 |
| upcoming | 4 |
| ott | 4 |
| tv_dramas | 4 |
| trailers | 3 |
| episodes | 2 |
| awards | 2 |
| music | 2 |
| viral | 2 |

Reservations, NOT ceilings — leftover redistributes to categories with
need. Total stays DAILY_CAP = 40 (owner's rule: all categories move
together, allocate BY NEED).

## 5. Gemini drafting + caps

- **Keys:** `GEMINI_API_KEY_1..6` (flickatlas-site secrets). Rotation: on
  429/5xx try the next key; if ALL fail, the batch is skipped (never
  retried into the quota). Free tier; quotas reset midnight Pacific.
- **Model:** `gemini-3.5-flash-lite` (batch). `gemini-3.5-flash` (panel
  connector). The 2.5 family 404s for these keys.
- **DAILY_CAP = 40** articles/day (resets 05:00 PKT = 00:00 UTC).
  **BATCH_SIZE = 2** per run — with 4/run the cap was exhausted by
  ~09:00 UTC and the site went stale for 15h (26 Oct incident). At
  2/run the same 40 spread across the whole day.
- **Box-office FIGURES are never AI-guessed.** Review scores are
  editorial opinions (Gemini may write them, Tavily-grounded).
- **Draft workflow** (Flickposts `flickatlas-admin.yml`) needs
  `GEMINI_API_KEY_1` in Flickposts — the owner's step.

## 6. Episode summaries (Pakistani dramas only)

- Tracker runs **00:00 / 06:00 / 12:00 / 18:00 PKT** (19/1/7/13 UTC).
- **RULE (owner order): however many episodes arrive in one day, ALL get
  a summary, instantly — in the SAME tracker run that detects the episode.**
  Caps `SUMMARY_MAX_PER_DAY` / `SUMMARY_PER_RUN` = 50 are a safety
  ceiling only, never binding.
- Summaries come from Gemini fileData on the episode's OWN YouTube URL,
  Roman Urdu, ~120–180 words, "sirf IS episode mein jo kuch hota hai"
  (never the drama's premise). Heading: "Episode Summary".
- Remaining delay is tracker cadence (max 6h). Hourly tracking is blocked
  by YouTube Data API quota (100 units/channel/run; 4 channels × 24 runs
  = 9,600/day vs 10,000/day default) — needs a Google quota increase,
  not a code change.

## 7. Step gates (PKT)

| Step | Gate (PKT) | Interval |
|---|---|---|
| fetch | hourly | — |
| gemini_batch (draft + structured data) | hourly | cap 40/day |
| apply_auto, convert_news, ott, publish, stats_traffic | hourly | — |
| multisource_boxoffice | 07:00 / 13:00 / 19:00 / 01:00 | 6h |
| episode_guides | 00:00 / 06:00 / 12:00 / 18:00 | 6h |
| title_seed | 23:00 | 24h |
| gemini_reviews | 00:00 | 24h |
| trending_weekly | 23:00 | 24h |
| overseas_ai | 13:00 | 24h |
| tavily_boxoffice | 13:00 + 23:00 | 12h |
| stats_pipeline | 05:00 / 11:00 / 17:00 / 23:00 | 6h |
| stats_health | 11:00 | 24h |
| metadata_refresh | Sunday 23:00 | 168h |
| providers_backfill | 07:00 | 24h |

Each gated step also fires on **overdue catch-up** (last run older than
interval + 1h grace). A gated step that did not run yet today is
**normal**, not a failure.

## 8. Box office

- **7 readers** (scripts/multisource_boxoffice.py): Sacnilk, FNN
  (`/api/all-box-office`), WP (FlickOnClick + BollyMovieReviewz),
  BollyBourse, MovieMint (reports GROSS incl. GST → estimated India Net
  ÷ 1.18), Filmibeat (**secondary** — re-reports Sacnilk, confirmation
  not an independent vote). Tenvow + VaranasiBoxOffice readers NOT built.
- Per movie+day: **mean across sources** (2dp); single source = that
  figure; no source = row absent, never invented. Scope: **India Net
  day-wise only.** Day-wise limited to 30 days, then only the TOTAL.
- **Tavily gap-filler** (08:00 / 18:00 UTC = 13:00 / 23:00 PKT):
  fills missing yesterday rows from search. Early-morning IST rule +
  yesterday gap-fill fallback. First real run 2026-10-28 13:00 PKT:
  `no-new-data` (no film missing yesterday's row) — a legitimate
  outcome, not a failure. `tavily.json` has never held a figure yet.
- Day 1 is anchored to the trade sites' theatrical date, NOT the TMDB
  date (Street Fighter / Clayface quirk — known, separate fix).

## 9. Titles (seeder) + OTT

- **Seeder** (`scripts/title-seed.py`, 23:00 PKT): 7 sources (now_playing
  + upcoming pages 1–2, Bollywood discover, India window ±7d). Fresh
  titles (released last 7 days / releasing next 7 days) ALL added;
  backfill max 4/day, newest first, strict sequence; safety ceiling
  20/day. No fixed daily limit (owner order).
- **Festival-only titles** (release dates across ALL regions are
  exclusively festival/premiere): stay in Coming Soon/upcoming, NEVER in
  released/Spotlight, until a real theatrical/digital date exists.
- **OTT = streaming-only** (flatrate only; rent/buy declined).
  Providers from TMDB watch/providers (IN flatrate first, US fallback).
  92/99 titles have NO providers on TMDB — thin OTT is data reality,
  backfilled daily at 07:00 PKT as titles reach streaming.
- **Metadata refresh** (weekly, Sunday 23:00 PKT): re-fetches TMDB
  metadata for published titles. Editorial fields are never touched.

## 10. Why a step did NOT run (the reason map)

| Reason in the record | Meaning | Watchdog action |
|---|---|---|
| `gate` | Not its gate hour yet (checked, correctly skipped) | THEEK. Say when it runs next. |
| `cap` | DAILY_CAP 40/40 reached | THEEK (by design). Say it resumes 05:00 PKT. NEVER re-run. |
| `no-new-data` | Checked, nothing new to write | THEEK. |
| `429` / quota | All Gemini keys refused | Report; skip cleanly; NEVER retry into the quota. |
| source error (per-source) | That source's feed failed (HTTP/DNS/bot-wall) | Report the count + names. DNS-dead = auto-fix candidate (see §12). Bot-walled = known, owner's call. |
| `failed` | The step itself errored | URGENT. Read the failed step's log tail (§11), diagnose, auto-fix only per §12. |
| no record at all | Step never recorded (unseeded / new step) | Say so plainly; do NOT invent a last-run time. |

**"Skip" reads as dead to the owner.** Every verdict must carry the
gate time + next run time, so a skip is understood, never feared.

### Core checklist — the owner's 5 failure modes (check EVERY hour)

These five are the owner's real complaint. Every verdict must say which
of them apply — WHAT happened, WHY (gate / cap / 429 / commit-fail /
deploy-fail / source-error, with evidence), and the FIX (auto-fix or
report). The watchdog must REASON like Muse: not just the status, but
the reason + the fix.

| # | Failure mode | How the watchdog detects it | If true, the verdict says |
|---|---|---|---|
| (a) | **Run hua hi nahi** | No hourly-pipeline run started in the last ~70 min (step-runs `updated_at` age, dispatcher decision) | What hour is missing, why (dispatcher skipped? GitHub schedule missed? run failed at setup?), fix: confirm the dispatcher's :50 retry; still missing → URGENT report. |
| (b) | **Run hua lekin updates nahi aaye** | Run succeeded but today's counts did not move (fetch_new / drafts / published_today flat vs yesterday, apply_auto +0, publish +0) | Which output is flat and why (cap? no-new-data? queue empty? gate?), fix: wait / re-run the failed step / report. |
| (c) | **Gemini nahi chala** | `gemini_batch` last real run old, or reason `cap` / 429, or 0 drafts today | Why (cap 40/40? all keys 429? no new data?), fix: NEVER re-run (cap); 429 → report; no-new-data → theek. |
| (d) | **GitHub nahi chala** | The run itself failed (checkout/commit/save step, rebase conflict, push failure) | Which step, what error (log tail, §11), fix: commit-retry / re-run the idempotent step / report. |
| (e) | **Website update nahi hui** | Deploy step failed/skipped, or the live files do not match the pushed commit | Deploy conclusion + live hash check, fix: re-deploy / report. |

A verdict with NONE of the five applying is `theek`. A verdict that
applies one of the five but the cause is by-design (gate / cap /
no-new-data) says so plainly — that is not a failure, it is the
process working.

## 11. What the watchdog reads (compact — never raw logs)

Per hourly run the monitor builds ONE compact state summary (small
enough for one Gemini call):

- `out/step-runs.json` — every step: last check (PKT 24h), last REAL
  run (PKT 24h), status, reason, detail. File keeps 24 records/step.
- `out/daily-history.json` — per day: fetch_new, gemini_drafts,
  published_today, posts_total, per-category fetch. (History starts
  27 Oct 2026 — ranges with fewer days than asked must say so.)
- `out/report.json` — this run's fetch: sources ok/error/unchanged,
  per-source errors (name + HTTP/DNS note), per-category new counts,
  dropped counts, queue_total (this run's new stories).
- `out/gemini-batch.json` — this run's batch: count, generated,
  ranked, unprocessed. Cap state comes from the gemini_batch step
  record (`cap` reason).
- `js/published-titles.js` — total published titles + newest
  `published_at` per industry (date-only granularity).
- `js/daywise-data.js` — titles with day-wise rows + newest row date.
  A title whose last row is days old is usually a film that left
  cinemas — verify, never assert broken.
- `out/boxoffice-staging/tavily.json` — Tavily figures ({} = none yet).
- **Failed step's log tail ONLY:** if a step failed THIS run, the
  monitor fetches that run's job steps from the GitHub API
  (same-repo `GITHUB_TOKEN`, `GITHUB_RUN_ID`) and includes the failed
  step's last ~40 log lines, truncated to ~2 KB. Full raw logs are
  NEVER sent to Gemini (free-tier quota + token cost). If the log
  cannot be fetched, record "log nahi mila" and continue.
- **Panel queue total** lives panel-side (Flickposts `data/queue.json`,
  ~4,829 items). The site pipeline cannot read it; the panel section
  shows it from its own queue data.

## 12. Auto-fix rules (ONLY these — safe, mechanical, reversible)

1. **Missed/failed hour — confirm only.** The dispatcher retries a
   failed hour at :50. The monitor CONFIRMS the retry happened and
   logs it. If the hour is STILL missing after the retry → report as
   URGENT. The monitor NEVER dispatches a workflow itself.
2. **Failed idempotent cap-free step — re-run once.** Via
   `workflow_dispatch` on the step's own standalone workflow, ONLY for
   steps whose re-run is idempotent and cap-free: fetch, box-office
   readers, stats. **NEVER re-run `gemini_batch`** (double cap spend),
   never re-run episode summaries (double token spend).
3. **DNS-dead source — prune.** Only a source verified dead (DNS
   NXDOMAIN / domain gone across 48h + a direct check now — the check
   counts the host dead when it does not resolve to any PUBLIC address,
   so a captive resolver cannot fake "alive"). First sighting only
   logs a proposal in `report_only`; after 48h in the ledger it is
   removed from the SITE registry (`scripts/registry.json`). The
   Flickposts registry is a different repo the site pipeline cannot
   write — that removal is REPORTED in `report_only`, the parent/agent
   does it. Bot-walled-but-alive sources are NEVER pruned by the
   watchdog (owner's call).
4. **Everything else = diagnose + prepare, report only.** A code bug
   gets a diagnosis + a ready fix written up; the parent/agent deploys
   it. The watchdog NEVER edits code, NEVER deletes published data,
   NEVER changes caps, NEVER touches keys/secrets, NEVER edits site
   content.
5. **Every auto-fix is logged** in `out/ai-watch.json` (what / why /
   when PKT / run id). An auto-fix that fails is logged as failed, and
   the item moves to report-only.

## 13. Access model (security — do not break)

- The watchdog runs as **its own workflow** (`.github/workflows/watchdog.yml`),
  where `GITHUB_TOKEN` + Gemini keys already exist as secrets (same
  repo, same secrets as the pipeline — nothing new). It does NOT need
  `CLOUDFLARE_API_TOKEN` (it never deploys). The pipeline job's
  permission is `actions: write` (only so its last step can dispatch
  this workflow); the watchdog job's permissions are `contents: write`
  (commit the verdict) + `actions: write` (dispatch the pipeline for
  recovery + read run lists for the guards). Same repo only.
- **Token decisions are the parent agent's / Muse's, NEVER the owner's.**
  The owner does not know which token to give and must never be asked to
  decide. If some job needs a token that does not exist, the watchdog
  writes it in the report with EXACT details (which token, for what job,
  why it is needed) and the parent decides whether to create it.
- The **panel frontend (browser) NEVER receives a token.** The panel
  only renders `out/ai-watch.json` via the Worker's session-protected
  `GET /api/ai-watch` (same pattern as `/api/step-runs`).
- **No new token is ever created by the watchdog.** If some job needs a
  token that does not exist, the watchdog writes it in the report and
  the parent creates it.
- The watchdog **never fails its own run**: 429/quota → skip with
  reason; missing state files → skip with reason; any exception →
  write a minimal `ai-watch.json` with `status: "check-failed"` + the
  reason, exit 0.

### Kill switches — Ghar toggles (Automation / AI Watchdog / Fetching)

- The panel Ghar page has **3 toggle buttons: Automation, AI Watchdog,
  Fetching — all ON by default, each can be turned OFF** (owner order
  2026-10-28).
- **Flag file (fixed):** `data/automation-state.json` in the
  flickatlas-site repo, key `ai_watch`. **File missing → DEFAULT ON.**
- The watchdog workflow reads this file at the START of every run. If
  `ai_watch` is `false` → the run SKIPS (writes `ai-watch.json` with
  status `"skipped"` + reason `"AI watchdog off"`, exit 0). If `true`
  or the file is missing → runs normally.
- **The watchdog only READS this file — it NEVER writes it.** The
  audit agent builds the toggles + the Worker endpoint + the
  dispatcher/fetch enforcement; the flag file is created by that round.
  (The `automation` and `fetching` toggles are enforced by the
  dispatcher / fetch workflow, not by this step.)

## 14. Output: out/ai-watch.json

```json
{
  "checked_at": "2026-10-28 13:42 PKT",
  "pipeline_hour": "2026-10-28T08:00:00Z",
  "mode": "primary | backup",
  "overall": "theek | dhyaan-do",
  "verdicts": [
    {"id": "fetch", "kind": "step", "name_ur": "Fetch",
     "status": "theek | khaali | purana | update-chahiye",
     "modes": ["a" | "b" | "c" | "d" | "e"],   // which of the 5 failure modes apply (empty = none)
     "evidence_ur": "one line, exact numbers + PKT times",
     "fix": "search | dobara-chalao | intezaar | source | koi-nahi",
     "auto_fixable": true | false, "note_ur": "one line, optional"}
  ],
  "autofixes": [{"what_ur": "...", "why_ur": "...", "run_id": "..."}],
  "report_only": ["one line each, things needing a human decision"],
  "redispatch": null | {"dispatched": true, "hour": "2026-10-28T08:00:00Z",
    "at_pkt": "2026-10-28 14:25 PKT",
    "reason": "Is ghante ki pipeline nahi chali thi — ek dafa dobara dispatch ki gayi."},
  "history": [{"pipeline_hour": "...", "status": "ok | skipped | check-failed",
    "overall": "theek | dhyaan-do", "mode": "primary | backup",
    "at_pkt": "2026-10-28 14:05 PKT"}]   // last 6 hours
}
```

- One verdict per step (18) + per category (11) + titles + daywise +
  tavily = 32 verdicts. Verdict text in Roman Urdu, Latin script.
- The panel Ghar section **"AI ki nazar"** renders this file: plain
  list (theek / khaali / purana / update chahiye + kya karna hai) +
  auto-fix log + last check time (PKT 24h) + the re-dispatch record
  (when the watchdog re-ran the pipeline) + which hour the verdict
  covers + primary/backup. Honest empty state until the first run
  writes the file: "abhi tak koi check nahi hua".

## 15. Cost (hourly, free tier)

- One small Gemini call per PRIMARY run (24/day); the backup run
  makes NO call when the verdict already exists (the normal case), so
  the usual total stays 24/day, worst case 48/day (a missing verdict
  every hour). ~7 KB state + ~5 KB spec in, ~10 KB verdict JSON out.
  Roughly 3–4k tokens/call, ~80k tokens/day —
  a fraction of the drafting budget. The call uses the same
  `GEMINI_API_KEY_1..6` rotation as the batch (429 → next key → skip).
  It NEVER spends drafting budget (no articles, no cap).

## 16. Self-waking (owner rule 2026-10-28: "watchdog bhi so na jaye")

The watchdog must never need waking up by hand. It has TWO triggers
and never depends on the system it watches:

| Trigger | When | What it does |
|---|---|---|
| PRIMARY (dispatch) | The hourly pipeline's LAST step, AFTER the deploy | The pipeline dispatches `watchdog.yml` with its run id. The watchdog checks out main (with the pipeline's just-committed state), builds the verdict for the UTC hour that pipeline run was created in, and commits `out/ai-watch.json`. A primary run ALWAYS writes a fresh verdict (it may replace a backup recovery verdict with the real one). |
| BACKUP (schedule) | Own cron `:25 * * * *` UTC, previous hour only | Checks whether a verdict for the previous hour already exists. **Yes → SKIP** (no Gemini call, no write, no commit). **No → verdict from the (stale) state + recovery** (below). |

**Why :25 and not :10:** a dispatcher-dispatched pipeline starts at
:50 and finishes as late as :20 (16–30 min runs). A :10 backup would
see "no verdict yet" on a pipeline that is still running and wrongly
re-dispatch it. By :25 every start path (:35 schedule → done by :05,
:50 dispatcher → done by :20) has had time to land its verdict.

**Backup guards (in this order, all in `scripts/ai_watch.py`):**
1. **Idempotency** — `out/ai-watch.json` already has `pipeline_hour`
   == target hour and `status` in (`ok`, `skipped`) → skip, exit 0.
   (`check-failed` does NOT count — a failed check is retried.)
2. **Pipeline in flight** — any `hourly-pipeline.yml` run
   `in_progress`/`queued` started within 45 min → skip (the verdict
   is pending, not missing).
3. **Watchdog in flight** — any other `watchdog.yml` run
   `in_progress`/`queued` started within 30 min → skip (the primary
   is on its way).
4. **Recovery** (only when 1–3 all say "genuinely missing"):
   re-dispatch the hourly pipeline ONCE, and record it in the verdict
   (`redispatch: {dispatched, hour, at_pkt, reason}`). Guards:
   - **Max 1/hour** — a `redispatch` record for this hour already in
     `ai-watch.json` → no dispatch.
   - **2 consecutive failures → NO dispatch** — the last 2 completed
     pipeline runs both `failure` → write "2 ghante se fail — code/human
     fix chahiye" and stop (an infinite dispatch loop would just burn
     runs on a broken pipeline).
   - A failed dispatch call itself is recorded, not retried in-run.

**What the backup does NOT do:** it never replaces the dispatcher
(the dispatcher at :50 is still the first net for a missed hour; the
watchdog backup is the second net). It never re-runs `gemini_batch`,
never deletes data, never changes caps, never touches keys.

**Ordering (every hour):** fetch → Gemini batch → publish/commit
(updates) → Cloudflare deploy → watchdog check. The watchdog check
always runs AFTER the deploy, never before. The backup only ever
checks the PREVIOUS hour — it never chases the current hour's
pipeline.

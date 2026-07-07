# Job-Matching Harness

Two systems for finding Salesforce jobs that match Patrick's resume, both writing into the same Neon `job_postings` table so they share one dashboard. This doc covers both — see [README.md](README.md) for the base company-scraping pipeline and [NEON-DASHBOARD.md](NEON-DASHBOARD.md) for the dashboard API.

---

## 1. Neon match-harness — live, producing results

Scores every job the scraper/import pipeline finds against Patrick's actual resume, not just title/location.

```
company career pages (direct-scraper.cjs)  ─┐
legacy JSON backlog (import-legacy-jobs.cjs)─┼─► job_postings (Neon)
                                              │
                          triage.cjs (Haiku, title+location filter)
                                              │
                        fetch-jd.cjs (full JD text for triage='yes')
                                              │
                match-score.cjs (Sonnet, resume-vs-JD, 0-100 + reasoning)
                                              │
                          neon-dashboard-server.cjs (localhost:3002)
```

**Files:** `src/backend/{triage,fetch-jd,match-score,match-harness}.cjs`, `scripts/import-legacy-jobs.cjs`, `db/migrate.cjs` (schema).

**Schedule:** `src/backend/neon-scheduler.cjs`, started at logon via `start-dashboard.cmd` — scrapes at 7am/2pm ET weekdays, match-harness runs 30 min after each.

**Status as of 2026-07-02:** 521 jobs in the database, 347 passed triage, 58 scored, **5 strong matches (≥70)**. Working end-to-end.

**Manual run:** `npm run neon:match` (or `neon:match:dry` for a dry run).

---

## 2. Claude search agent — built, not yet producing results

A `/schedule` cloud routine (`career-future-claude-job-search`) that actively searches the open web for Salesforce Administrator postings — remote or Greenville SC — that aren't on major job boards. Unlike the scraper, it isn't limited to a fixed company list.

```
/schedule routine (weekdays 8:12am ET)
  → WebSearch (≤6 queries) + WebFetch (≤15 candidates)
  → checks claude/search-results branch history first (skip already-seen URLs)
  → commits findings to claude/search-results branch (git push — no DB creds needed)
        ↓
scripts/pull-claude-results.cjs (run locally, where .env already works)
  → scripts/ingest-claude-job.cjs (blocklist backstop, upsert into job_postings)
  → src/backend/match-score.cjs (score anything new)
```

**Files:** `scripts/{ingest-claude-job,pull-claude-results}.cjs`, `src/backend/blocked-domains.cjs`.

**Why the git round-trip instead of direct DB writes:** Claude Code cloud routine sessions don't reliably receive environment variables/secrets configured on the "Default" environment — confirmed by repeated live testing, not documented anywhere. The routine can't hold `CAREER_NEON_URL` or `ANTHROPIC_API_KEY`, so it reports findings via a git branch (git push access is default/free) and a local script — which already has working credentials — does the actual database write.

**Status as of 2026-07-02:** Mechanically proven (git push/pull cycle works, blocklist backstop works, seen-URL dedup works) but **zero verified jobs delivered**. Every live run hit a different platform-level wall: missing committed code, a renamed GitHub repo, no propagated secrets, and finally `WebFetch` returning 403 on every call in the environment. That last one is unresolved — looks like a genuine reliability issue with the cloud sandbox's web-fetch tool, not something either side misconfigured.

**Manual run:** `node scripts/pull-claude-results.cjs` after a routine firing, to check for and ingest any new results.

---

## 3. Company discovery — live, scheduled weekly

Finds new companies to feed into the pipeline above, from two different angles, before either one relies on a company already having posted a job:

```
discover-companies.cjs          discover-press-releases.cjs
(Serper: company career pages   (Serper: county economic-dev
 mentioning Salesforce)          announcements — new/expanding
        │                        companies, no Salesforce
        │                        mention needed — that's found
        │                        later once they post a job)
        └──────────┬──────────────────┘
                    │  both: Firecrawl scrape → Haiku validate
                    │  → discovery_seen ledger (shared dedup,
                    │    30-day rescan window)
                    ▼
         companies (Neon, scrape_status='pending_review')
                    │
                    ▼
         enrich-careers-url.cjs
         (press-release finds land with careers_url=NULL —
          this Serper+Firecrawl+Haiku pass finds and confirms
          each company's real careers page, promotes to 'active'
          on a confident match, leaves the rest for manual lookup)
                    │
                    ▼
         direct-scraper.cjs (existing pipeline, section 1)
```

**Files:** `discover-companies.cjs`, `discover-press-releases.cjs`, `enrich-careers-url.cjs`, `src/backend/discovery-shared.cjs` (shared Serper/Firecrawl/ledger/email helpers — extracted so the three scripts don't duplicate ~70% of the same code).

**Schedule:** wired into `src/backend/neon-scheduler.cjs` — **Sunday 9:00 PM ET**, weekly, all three scripts in sequence. Deliberately weekly (not daily, like the scrape/match jobs) since company signals don't turn over as fast as job postings, and deliberately clear of the weekday 7/7:30/2/2:30 ET slots so discovery never competes with the scrape/match pipeline for the same Anthropic rate-limit budget at the same time. (Note: "off-peak" here is about not overlapping your *own* other scheduled jobs — Anthropic's rate limits are account-tier based, not time-of-day based, so running at night doesn't reduce risk the way it would for, say, avoiding server congestion.)

Each script runs as its own **child process** (`execFile`, not `require()`) from the scheduler, specifically because all three call `process.exit()` on error — required in-process, that would kill the whole long-running scheduler daemon instead of just that one failed script.

**Manual run:** `npm run neon:discovery` (or `node src/backend/neon-scheduler.cjs --discovery`) to trigger the full sequence immediately, outside the schedule. Each script also runs standalone (`node discover-companies.cjs --dry-run --queries 1`, etc. — see each file's header comment for flags).

**Crash-safety (rate limits):** each per-candidate Haiku call is wrapped in try/catch — one API failure (e.g. rate limit exhausted after the SDK's built-in retries) logs and skips just that candidate instead of killing the whole run. This matters because of how results are persisted: every accept/reject decision writes to Neon (`discovery_seen` + `companies`) **immediately**, one candidate at a time — never batched. So a crash or rate-limit hit mid-run only costs the unprocessed remainder; everything already found stays found. (Considered batching writes into groups for efficiency — rejected: the DB write is single-digit milliseconds against a per-candidate cost of seconds for the Firecrawl scrape + Haiku call, so batching saves almost nothing while reintroducing the exact data-loss risk this design avoids.)

**Status as of 2026-07-06:** First live runs found 23 companies via press releases (Isuzu $280M/700 jobs, Bosch, Siemens $165M, a $3B TigerDC data center, and more across Greenville/Spartanburg/Anderson counties) and enriched 14 of them with a confirmed careers URL automatically. Caught and corrected two automated false-matches during testing (a 404 page that Haiku initially misjudged as valid, and a genuine name-collision between "TTi"/Techtronic Industries and an unrelated Fort Worth company called TTI Inc — the duplicate row was deleted rather than left to keep re-matching wrong).

**Related fix — dashboard approve button:** discovered (2026-07-05) that `neon-dashboard-server.cjs`'s `/api/approve/:id` only ever set `scrape_status='active'`, never `enabled=true` — but `direct-scraper.cjs` requires **both** to actually scrape a company. This silently affected the whole pipeline, not just today's discoveries: 113 companies repo-wide were stuck `active`+`enabled=false` (76 legacy `weekly` imports, 21 press-release finds, 16 earlier Serper-discovery finds). Bulk-fixed the existing 113 and patched the route so future approvals set both fields.

---

## 4. Dashboard uptime — watchdog + auto-start

`neon-dashboard-server.cjs` (localhost:3002) now has basic self-healing, separate from the discovery/scoring pipeline above:

- **`scripts/dashboard-watchdog.ps1`** — checks if port 3002 is listening; if not, starts `neon-dashboard-server.cjs` and logs the outcome to `logs/watchdog.log`.
- **At logon:** a Startup-folder shortcut (`CF-DashboardWatchdog.lnk`) runs the watchdog silently every time you log in. (Windows Task Scheduler's `ONLOGON` trigger needed admin rights on this machine — the Startup folder is the non-admin equivalent.)
- **Every 24 hours:** a scheduled task (`CF-DashboardWatchdog-Daily`, `schtasks`) re-runs the same check daily at 4:00 AM, independent of logon/logoff cycles.

Test manually: `powershell -ExecutionPolicy Bypass -File scripts\dashboard-watchdog.ps1`.

---

## Cost so far

**Cloud routine (5 firings):** Unknown. `RemoteTrigger`'s API exposes trigger config only, not token/cost data — that lives in your claude.ai usage/billing view, not anywhere queryable from here. Routine firings draw down your normal Claude usage rather than metering separately.

**Local API calls (Haiku triage + Sonnet match-score):** `triage.cjs` still doesn't log actual token usage, so its line below remains a reasoned estimate. `match-score.cjs` now prompt-caches the resume + scoring rubric (identical on every call) as a `cache_control` system block and logs real `usage` totals per run — confirmed live: a 4-job test batch showed one 3,560-token cache write followed by three 3,560-token cache reads (~10% of input price each), and a same-window re-run showed 0 cache writes / all reads, since the cache was still warm from the prior call within its 5-minute TTL.

| Step | Model | Calls | Est. tokens/call (in / out) | Est. cost |
|---|---|---|---|---|
| Triage | Haiku 4.5 ($1/$5 per MTok) | 517 | ~470 / ~25 | ~$0.31 |
| Match-score | Sonnet 5 ($2/$10 per MTok, intro pricing through 2026-08-31) | 60 | ~2,980 / ~200 (pre-caching backfill; resume sent uncached every call) | ~$0.48 |
| **Total (backfill)** | | | | **~$0.79** |

Ongoing cost going forward: each scheduled match-harness run only scores *new* jobs (`match_scored_at IS NULL`), so the table above was a one-time backfill cost, not a recurring one at this scale. With caching, only the first match-score call after a >5-minute gap pays full price for the resume+rubric block (~3,560 tokens); every call after that in the same run — or within 5 minutes of the last one — reads it back at ~10% of input price instead.

**Company discovery (weekly, section 3):** Serper dominates this cost, not Haiku — each script prints its own estimate at the end of every run (`Estimated cost:` block), and it also goes out in the digest email. Observed so far: `discover-press-releases.cjs`'s first full 6-query run cost ~$0.065 Haiku + $0.60 Serper (65,958 in / 3,081 out tokens, 12 Serper calls); `enrich-careers-url.cjs` costs ~2 Serper calls per company checked (~$0.60-0.90 per run depending on backlog size). Cost naturally drops on repeat runs since the shared `discovery_seen` ledger skips anything already checked within 30 days — only genuinely new candidates get re-scraped/re-classified each week.

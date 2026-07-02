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

## Cost so far

**Cloud routine (5 firings):** Unknown. `RemoteTrigger`'s API exposes trigger config only, not token/cost data — that lives in your claude.ai usage/billing view, not anywhere queryable from here. Routine firings draw down your normal Claude usage rather than metering separately.

**Local API calls (Haiku triage + Sonnet match-score):** `triage.cjs` still doesn't log actual token usage, so its line below remains a reasoned estimate. `match-score.cjs` now prompt-caches the resume + scoring rubric (identical on every call) as a `cache_control` system block and logs real `usage` totals per run — confirmed live: a 4-job test batch showed one 3,560-token cache write followed by three 3,560-token cache reads (~10% of input price each), and a same-window re-run showed 0 cache writes / all reads, since the cache was still warm from the prior call within its 5-minute TTL.

| Step | Model | Calls | Est. tokens/call (in / out) | Est. cost |
|---|---|---|---|---|
| Triage | Haiku 4.5 ($1/$5 per MTok) | 517 | ~470 / ~25 | ~$0.31 |
| Match-score | Sonnet 5 ($2/$10 per MTok, intro pricing through 2026-08-31) | 60 | ~2,980 / ~200 (pre-caching backfill; resume sent uncached every call) | ~$0.48 |
| **Total (backfill)** | | | | **~$0.79** |

Ongoing cost going forward: each scheduled match-harness run only scores *new* jobs (`match_scored_at IS NULL`), so the table above was a one-time backfill cost, not a recurring one at this scale. With caching, only the first match-score call after a >5-minute gap pays full price for the resume+rubric block (~3,560 tokens); every call after that in the same run — or within 5 minutes of the last one — reads it back at ~10% of input price instead.

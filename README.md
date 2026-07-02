# career-future

Automated job search pipeline backed by Neon PostgreSQL. Discovers company career pages, scrapes job listings, triages them with Claude, and surfaces results on a local dashboard.

Dashboard runs at **http://localhost:3002**

---

## Architecture

```
discover-companies.cjs          ← Serper (Google) + Firecrawl + Claude Haiku
       ↓ inserts as pending_review
  Neon companies table
       ↓ approve via dashboard
  scrape_status = active
       ↓
  direct-scraper.cjs / playwright_selector_discovery.cjs
       ↓ inserts job postings
  Neon job_postings table
       ↓
  neon-dashboard-server.cjs     ← http://localhost:3002
```

Manual ingest path (Apollo CSV export):

```
Apollo export → enrich-companies.js → companies-weekly.csv → db/migrate.cjs → Neon
```

---

## Required env vars (.env)

| Variable | Purpose |
|---|---|
| `CAREER_NEON_URL` | Neon PostgreSQL connection string |
| `SERPER_API_KEY` | Google search API (serper.dev) — used by discover-companies.cjs |
| `FIRECRAWL_API_KEY` | Firecrawl page renderer — used by discover-companies.cjs |
| `ANTHROPIC_API_KEY` | Claude Haiku validation — used by discover-companies.cjs |

---

## Scripts

### 1. Discover new companies (automated)

```powershell
node discover-companies.cjs                  # full run (~8 query groups, Firecrawl + Haiku)
node discover-companies.cjs --dry-run        # validate without writing to Neon
node discover-companies.cjs --queries 3      # run only first 3 query groups (cost control)
node discover-companies.cjs --sample 5       # only scrape 5 URLs per query group
```

Finds company career pages via Serper Google searches, renders them with Firecrawl, validates EST timezone + Salesforce relevance with Claude Haiku, and inserts confirmed companies into Neon as `pending_review`. ATS platforms (Greenhouse, Lever, Workday, etc.) are excluded via `-site:` operators.

### 2. Dashboard (always-on)

```powershell
node neon-dashboard-server.cjs
node neon-dashboard-server.cjs --port 3003   # override port
```

Launched automatically at Windows logon via Task Scheduler (`CareerFutureDashboard`).

| Page | URL |
|---|---|
| Job postings | http://localhost:3002/ |
| Pending review | http://localhost:3002/pending-review |
| ATS blocked | http://localhost:3002/ats-blocked |
| Scrape status | http://localhost:3002/scrape-status |

### 3. Database setup / reimport

```powershell
node db/migrate.cjs             # create tables, import both CSVs (safe to re-run)
node db/migrate.cjs --reset     # drop all tables and reimport from scratch
node db/migrate.cjs --dry-run   # preview counts without writing
```

Imports `data/companies.csv` (curated) and `data/companies-weekly.csv` (Apollo/enriched).

### 4. Enrich Apollo CSV export (manual ingest)

```powershell
node scripts/enrich-companies.js
```

Takes an Apollo company export, enriches with Firecrawl, filters for EST-timezone companies, and outputs `data/companies-weekly.csv` for migration. Run before `db/migrate.cjs --reset` or to add a batch of new companies.

### 5. Selector discovery (for approved companies)

```powershell
node playwright_selector_discovery.cjs
```

Runs Playwright against companies with `scrape_status = active` that have no selectors yet. Discovers `job_card_selector`, `title_selector`, `location_selector` for each.

---

## Pending review workflow

1. Run `discover-companies.cjs` (or enrich + migrate) — companies land as `pending_review`
2. Visit http://localhost:3002/pending-review
3. Click **Approve** → sets `scrape_status = active`, company will be scraped next run
4. Click **Skip** → sets `scrape_status = disabled`

Companies from `discover-companies.cjs` show a green state badge (e.g. `NC`, `OH`) and `source = serper_discovery`.

---

## Neon table quick reference

**companies** — one row per company career page

| Column | Values |
|---|---|
| `scrape_status` | `active`, `pending_review`, `ats_blocked`, `disabled`, `out_of_region`, `js_required`, `no_careers_page` |
| `source` | `curated`, `weekly`, `serper_discovery` |
| `hq_state` | 2-letter state abbreviation (e.g. `SC`, `OH`) — populated by discovery |
| `enabled` | Boolean; `FALSE` for pending/disabled |

**job_postings** — one row per job listing

| Column | Values |
|---|---|
| `triage_result` | `yes`, `no`, `pending` |
| `applied` | Boolean; toggle via dashboard |

---

## Other docs

- [NEON-DASHBOARD.md](NEON-DASHBOARD.md) — dashboard API reference
- [SELECTOR_DISCOVERY.md](SELECTOR_DISCOVERY.md) — selector agent details
- [SCRAPING_OPTIONS.md](SCRAPING_OPTIONS.md) — scraping approach notes

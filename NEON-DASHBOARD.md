# Neon Job Dashboard

Express server backed by Neon PostgreSQL. Runs on **port 3002**.

## Start

```bash
node neon-dashboard-server.cjs
node neon-dashboard-server.cjs --port 3003   # override port
```

Logs to `logs/neon-dashboard.log` when launched via the startup task.

## Env vars required

| Variable | Purpose |
|---|---|
| `CAREER_NEON_URL` | Neon PostgreSQL connection string (preferred) |
| `DATABASE_URL` | Fallback connection string |

## Pages

| URL | Description |
|---|---|
| `http://localhost:3002/` | Job postings — filterable by triage result, source, and date range |
| `http://localhost:3002/pending-review` | Companies awaiting selector verification (paginated, 25/page) |
| `http://localhost:3002/ats-blocked` | ATS blocklist grouped by platform |
| `http://localhost:3002/scrape-status` | Company scrape status breakdown + recently scraped |

## API

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/stats` | JSON counts for companies and job postings |
| `GET` | `/api/scraper-status` | `{ running: bool }` |
| `POST` | `/api/approve/:id` | Set company `scrape_status = 'active'` |
| `POST` | `/api/skip/:id` | Set company `scrape_status = 'disabled'` |
| `POST` | `/api/mark-applied/:id` | Toggle `applied` on a job posting |
| `POST` | `/api/run-scraper` | Trigger `direct-scraper.cjs` manually (one at a time) |

## Views

EJS templates in `views/`:
- `neon-jobs.ejs` — main job board
- `neon-pending.ejs` — pending review queue
- `neon-ats.ejs` — ATS blocked list
- `neon-status.ejs` — scrape status overview

## Startup

Launched automatically at Windows logon via Task Scheduler (`CareerFutureDashboard` task), alongside `dashboard.js` on port 3000. See `start-dashboard.cmd`.

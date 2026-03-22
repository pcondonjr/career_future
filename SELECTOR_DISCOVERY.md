# Selector Discovery System

Automated CSS selector discovery for disabled companies using Oxylabs + Claude, backed by Neon PostgreSQL for parallel-safe processing.

## Architecture

```
companies-weekly.csv
        │
        ▼
  setup_neon.cjs          ← Import CSV into Neon 'companies' table
        │
        ▼
  ┌─────────────────────────────────────────────┐
  │            Neon PostgreSQL                   │
  │  companies table (with row locking)          │
  │  status: pending → processing → done/failed  │
  └─────────────────────────────────────────────┘
        │                    ▲
        ▼                    │
  oxylabs_selector_discovery.cjs (x N agents)
  1. Claims a pending row (SELECT ... FOR UPDATE SKIP LOCKED)
  2. Fetches careers page via Oxylabs Web Scraper API
  3. Sends HTML to Claude for CSS selector extraction
  4. Writes results back to Neon
        │
        ▼
  export_neon.cjs          ← Export Neon back to companies-weekly.csv
```

## Scripts

### setup_neon.cjs — Import CSV into Neon
```bash
node setup_neon.cjs            # Import (skips if table has data)
node setup_neon.cjs --reset    # Drop and reimport
```

### oxylabs_selector_discovery.cjs — Process disabled companies
```bash
node oxylabs_selector_discovery.cjs                      # Process all pending
node oxylabs_selector_discovery.cjs --sample 5           # Test with 5 companies
node oxylabs_selector_discovery.cjs --agent-id agent-1   # Named agent (for parallel)
```

### run-agents.bat — Launch 4 parallel agents
```bash
run-agents.bat
```
Launches 4 minimized windows, each running an independent agent. Logs to `agent-1.log` through `agent-4.log`.

### export_neon.cjs — Export Neon back to CSV
```bash
node export_neon.cjs                                    # Overwrite companies-weekly.csv
node export_neon.cjs --output data/companies-backup.csv # Custom output path
```

### dashboard_server.cjs — Live progress dashboard
```bash
node dashboard_server.cjs           # http://localhost:3001
node dashboard_server.cjs --port 3002
```
Auto-refreshes every 5 seconds. Shows counts, active agents, progress bar, recent activity.

## Database Schema (Neon)

Table: `companies`

| Column | Type | Notes |
|---|---|---|
| id | SERIAL | Primary key |
| company_name | TEXT | Unique, from CSV |
| careers_url | TEXT | From CSV, updated if ATS URL discovered |
| job_card_selector | TEXT | CSS selector for job card container |
| title_selector | TEXT | CSS selector for job title |
| location_selector | TEXT | CSS selector for location |
| link_selector | TEXT | CSS selector for job link |
| enabled | TEXT | 'true'/'false', auto-enabled on high/medium confidence |
| notes | TEXT | From CSV + discovery notes |
| status | TEXT | pending / processing / done / failed |
| agent_id | TEXT | Which agent claimed this row |
| started_at | TIMESTAMPTZ | When processing began |
| completed_at | TIMESTAMPTZ | When processing finished |
| selector_confidence | TEXT | high / medium / low / failed |
| selector_notes | TEXT | Claude's notes about the page |

## Multi-Agent Setup (Step-by-Step)

### Step 1: Install dependencies
```bash
cd C:\Users\pcond\vs-code-projects\career-future
npm install pg @anthropic-ai/sdk dotenv csv-parse csv-stringify
```

### Step 2: Configure .env
```env
DATABASE_URL=postgresql://neondb_owner:PASSWORD@ep-xxx-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require
OXYLABS_USERNAME=your_username
OXYLABS_PASSWORD=your_password
ANTHROPIC_API_KEY=sk-ant-...
```

### Step 3: Import CSV into Neon
```bash
node setup_neon.cjs            # First time — creates table + imports
node setup_neon.cjs --reset    # If you need to wipe and reimport
```

### Step 4: Test with a small sample
```bash
node oxylabs_selector_discovery.cjs --sample 3
```

### Step 5: Start the dashboard
```bash
node dashboard_server.cjs
# Open http://localhost:3001 in your browser
```

### Step 6: Launch parallel agents
**Option A — Use the batch file:**
```bash
run-agents.bat
# Launches 4 agents in minimized windows with logs
```

**Option B — Manual (open 4 separate terminals):**
```bash
# Terminal 1
node oxylabs_selector_discovery.cjs --agent-id agent-1

# Terminal 2
node oxylabs_selector_discovery.cjs --agent-id agent-2

# Terminal 3
node oxylabs_selector_discovery.cjs --agent-id agent-3

# Terminal 4
node oxylabs_selector_discovery.cjs --agent-id agent-4
```

### Step 7: Monitor progress
```bash
# Dashboard (auto-refreshes every 5s)
http://localhost:3001

# Quick CLI check
curl http://localhost:3001/api/stats

# Check agent logs
type agent-1.log
type agent-2.log
```

### Step 8: Export results back to CSV
```bash
node export_neon.cjs                                    # Overwrites companies-weekly.csv
node export_neon.cjs --output data/companies-backup.csv # Or save a backup first
```

## How Parallel Safety Works

The key is PostgreSQL `FOR UPDATE SKIP LOCKED` in `claimNextCompany()`:

```javascript
// Each agent runs this same query — Neon handles the coordination
await client.query('BEGIN');

const { rows } = await client.query(`
  UPDATE companies
  SET status = 'processing', agent_id = $1, started_at = NOW()
  WHERE id = (
    SELECT id FROM companies
    WHERE status = 'pending'
      AND LOWER(enabled) IN ('false', '0', 'disabled', 'no', '')
    ORDER BY id
    FOR UPDATE SKIP LOCKED   -- <-- this is the magic
    LIMIT 1
  )
  RETURNING *
`, [AGENT_ID]);

await client.query('COMMIT');
```

**What `FOR UPDATE SKIP LOCKED` does:**
1. Agent-1 grabs row #100, locks it within a transaction
2. Agent-2 tries row #100, sees it's locked, **skips it**, grabs row #101
3. Agent-3 skips both, grabs row #102
4. No conflicts, no duplicates, no waiting

**Status flow per row:**
```
pending → processing (claimed by agent) → done (selectors found)
                                        → failed (no careers page / error)
```

**If an agent crashes mid-processing:**
- The row stays as `status = 'processing'` with its `agent_id`
- Other agents skip it (they only claim `pending` rows)
- You can manually reset stuck rows:
  ```bash
  node -e "
    require('dotenv').config();
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
    pool.query(\"UPDATE companies SET status='pending', agent_id=NULL WHERE status='processing' AND started_at < NOW() - INTERVAL '1 hour'\")
      .then(r => { console.log('Reset', r.rowCount, 'stale rows'); return pool.end(); });
  "
  ```

## Environment Variables (.env)

```
DATABASE_URL=postgresql://...@neon.tech/neondb?sslmode=require
OXYLABS_USERNAME=...
OXYLABS_PASSWORD=...
ANTHROPIC_API_KEY=sk-ant-...
```

# Apify & Apollo Company Discovery Pipeline

This guide documents the company discovery and enrichment pipeline used to find and qualify companies in target geographic areas. The pipeline runs independently from the main Career Future application and can be extracted into a separate repository or run in GitHub Codespaces.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Prerequisites](#2-prerequisites)
3. [Pipeline Architecture](#3-pipeline-architecture)
4. [Step 1: Apify Google Maps Scraper](#4-step-1-apify-google-maps-scraper)
5. [Step 2: Apollo.io Enrichment](#5-step-2-apolloio-enrichment)
6. [Step 3: Manual Review & Import](#6-step-3-manual-review--import)
7. [Utility Scripts](#7-utility-scripts)
8. [File Reference](#8-file-reference)
9. [Extracting to a Separate Process](#9-extracting-to-a-separate-process)
10. [Running in GitHub Codespaces](#10-running-in-github-codespaces)

---

## 1. Overview

The pipeline discovers companies in a target area (e.g., Greenville, SC) and filters them by employee count to find mid-size companies (200-5,000 employees) likely to have active job postings. The workflow is:

```
Apify Google Maps Actor  -->  Apollo.io Enrichment  -->  Manual Review  -->  companies-weekly.csv
     (discover)                 (filter/qualify)          (verify)            (Career Future input)
```

**Why this exists:** Career Future searches company career pages for jobs, but first you need a list of companies. This pipeline automates finding those companies in bulk rather than manually searching Google Maps one by one.

---

## 2. Prerequisites

### Accounts & API Keys

| Service | Free Tier | Sign Up | Key Location |
|---------|-----------|---------|--------------|
| **Apify** | 49 Actor runs/month, $5 free credit | [console.apify.com](https://console.apify.com/) | Settings > Integrations > API Tokens |
| **Apollo.io** | 60 enrichments/hour, 120/day | [app.apollo.io](https://app.apollo.io/) | [developer.apollo.io/keys](https://developer.apollo.io/keys/) |

### Environment Setup

Add these keys to the project root `.env` file:

```env
APIFY_API_TOKEN=your_apify_token_here
APOLLO_API_KEY=your_apollo_key_here
```

### Dependencies

The scripts use these npm packages (already in the project's `package.json`):

- `apify-client` - Apify API client for managing runs and KV stores
- `csv-parser` - CSV file parsing
- `dotenv` - Environment variable loading

Install if needed:

```bash
npm install apify-client csv-parser dotenv
```

---

## 3. Pipeline Architecture

### Data Flow

```
                                     Apify KV Store
                                  "scraped-companies-master-list"
                                     (deduplication DB)
                                           |
                                           v
 Google Maps  ---[Apify Actor]--->  apify-results.csv  ---[enrich-with-apollo.js]--->  enriched-companies.csv
  (raw data)     (scrape & dedup)    (new companies)       (Apollo API lookup)          (qualified companies)
                                                                                              |
                                                                                              v
                                                                                     Manual review &
                                                                                     add to companies-weekly.csv
```

### Key Concepts

- **Deduplication**: The Apify KV store tracks every company ever scraped. On subsequent runs, companies already in the store are skipped, so you only get new results.
- **Employee filtering**: Apollo enrichment filters companies to 200-5,000 employees. Companies outside this range are logged but excluded from output.
- **Two lookup methods**: Apollo first tries domain-based enrichment (more accurate), then falls back to name + location search.

---

## 4. Step 1: Apify Google Maps Scraper

### What It Does

Uses the [Apify Google Maps Scraper](https://apify.com/compass/crawler-google-places) actor to search Google Maps for companies in a target area and export their details (name, website, address, phone, categories).

### Running via Apify Console (Recommended)

1. Go to [console.apify.com](https://console.apify.com/)
2. Navigate to **Actors** > search for "Google Maps Scraper" by Compass
3. Click **Start** to create a new run
4. Configure the input (see below)
5. Click **Start** to run
6. When finished, go to **Storage** > **Dataset** > **Export** > download as CSV
7. Save the CSV to `files_apify/apify-results.csv`

### Actor Configuration

Use `files_apify/apify-actor-config.json` as your input configuration:

```json
{
    "locationQuery": "Greenville, South Carolina, USA",
    "maxCrawledPlacesPerSearch": 50,
    "searchStringsArray": [
        "Software companies near Greenville SC",
        "Technology companies near Greenville SC",
        "Healthcare companies near Greenville SC"
    ],
    "website": "withWebsite",
    "zoom": 12,
    "language": "en",
    "maxImages": 0,
    "scrapeContacts": false,
    "scrapePlaceDetailPage": false
}
```

**Key settings:**

| Setting | Purpose |
|---------|---------|
| `locationQuery` | Geographic center of search |
| `searchStringsArray` | Google Maps search queries — add more for different industries |
| `maxCrawledPlacesPerSearch` | Results per search query (50 is usually enough) |
| `website` | `"withWebsite"` only returns companies that have a website listed |
| `zoom` | Map zoom level (12 = city-level, lower = wider area) |

### Custom Deduplication Function

The `extendOutputFunction` in `apify-actor-config.json` is critical. It connects to the Apify Key Value Store named `scraped-companies-master-list` and:

1. Checks if the company was already scraped (by Place ID or name)
2. If duplicate, returns `null` to skip it
3. If new, saves it to the KV store and outputs it to the dataset
4. Backfills Place IDs for companies that were seeded by name only
5. Logs each run to a `_run_log` key for migration tracking

**To use it:** Copy the `extendOutputFunction` value from `apify-actor-config.json` and paste it into the actor's "Extend output function" field in the Apify console.

### Customizing Search Queries

Edit the `searchStringsArray` to target different industries or areas:

```json
"searchStringsArray": [
    "Software companies near Greenville SC",
    "Technology companies near Greenville SC",
    "Healthcare companies near Greenville SC",
    "Manufacturing companies near Greenville SC",
    "Financial services companies near Greenville SC",
    "Engineering firms near Greenville SC"
]
```

### Output Format

The actor produces a CSV with these columns:

| Column | Example |
|--------|---------|
| `title` | Designli |
| `website` | https://designli.co/ |
| `street` | 141 Traction St |
| `city` | Greenville |
| `state` | South Carolina |
| `phone` | (864) 532-2514 |
| `categories/0` | Software company |
| `url` | Google Maps URL |
| `categoryName` | Software company |

---

## 5. Step 2: Apollo.io Enrichment

### What It Does

Takes the Apify CSV output and enriches each company with employee count, industry, revenue, LinkedIn URL, founding year, and description from Apollo.io. Filters results to only include companies with 200-5,000 employees.

### Running the Script

```bash
cd files_apify
node enrich-with-apollo.js [input-file] [output-file]
```

**Defaults:**
- Input: `./apify-results.csv`
- Output: `./enriched-companies.csv`

**Examples:**

```bash
# Use defaults
node enrich-with-apollo.js

# Custom input/output
node enrich-with-apollo.js ./apify_78.csv ./enriched-78.csv

# JSON input also works
node enrich-with-apollo.js ./apify-export.json ./enriched.csv
```

### How It Works

For each company in the input file:

1. **Domain lookup** (primary): Extracts the domain from the website URL and calls Apollo's `/api/v1/organizations/enrich` endpoint
2. **Name search** (fallback): If no website or domain lookup fails, searches by company name + "South Carolina" location via `/api/v1/organizations/search`
3. **Employee filter**: If employee count is found:
   - 200-5,000 employees: included in output
   - Outside range: logged but excluded
   - No data: included with `UNKNOWN` employee count
4. **Rate limiting**: 300ms delay between requests (~3-4 requests/sec) to stay within free tier limits

### Apollo API Limits (Free Tier)

| Limit | Value |
|-------|-------|
| Enrichments per hour | 60 |
| Enrichments per day | 120 |
| Results per search | 1 (we only need the top match) |

If you have more than ~120 companies to enrich, you'll need to split across multiple days or upgrade your Apollo plan.

### Employee Count Range

The default range is defined at the top of `enrich-with-apollo.js`:

```javascript
const MIN_EMPLOYEES = 200;
const MAX_EMPLOYEES = 5000;
```

Adjust these constants to target different company sizes.

### Output Format

The enriched CSV contains:

| Column | Source | Example |
|--------|--------|---------|
| `name` | Apify | Infor |
| `website` | Apify | http://www.infor.com/ |
| `address` | Apify | 200 Executive Center Dr, Greenville SC |
| `phone` | Apify | (678) 319-8000 |
| `placeId` | Apify | ChIJCZDJJ... |
| `employeeCount` | Apollo | 16700 |
| `industry` | Apollo | computer software |
| `revenue` | Apollo | $3.2B |
| `linkedinUrl` | Apollo | https://linkedin.com/company/infor |
| `founded` | Apollo | 2002 |
| `description` | Apollo | Infor is a global leader... |

### Console Output

```
📂 Reading: ./apify-results.csv
   Found 78 companies to enrich

[1/78] Designli... ⏭️  12 employees (outside 200-5000)
[2/78] Merit Technologies... ❓ No employee data found
[3/78] Infor... ✅ 16700 employees
...

==================================================
📊 Enrichment Results:
   ✅ In range (200-5000):  8
   ⏭️  Filtered out:         15
   ❓ No employee data:      55
   📄 Output: ./enriched-companies.csv
==================================================
```

---

## 6. Step 3: Manual Review & Import

After enrichment, review the results and add qualifying companies to Career Future:

1. Open `files_apify/enriched-companies.csv` in Excel or Google Sheets
2. Review each company:
   - Does it have a careers page? Check their website.
   - Is it relevant to your job search (industry, size)?
   - Find the actual careers URL (e.g., `https://company.com/careers`)
3. Add qualifying companies to `data/companies-weekly.csv` with the format:

```csv
company_name,careers_url,enabled,last_checked,last_results,check_count,notes,industry
Infor,https://careers.infor.com/,true,,,,computer software,
```

4. Optionally run the seed script to update the Apify KV store for deduplication (see below)

---

## 7. Utility Scripts

### seed-apify-store.js

**Purpose:** Pre-seeds the Apify KV store with companies from your `companies-weekly.csv` so that the Google Maps actor skips them on future runs (prevents re-discovering companies you already know about).

```bash
cd files_apify
node seed-apify-store.js [path-to-csv]
```

**Default CSV:** `./data/companies-weekly.csv`

**When to use:**
- After adding new companies to `companies-weekly.csv` manually
- Before running a new Apify scrape to avoid duplicates
- When setting up the pipeline for the first time

**Options:**
- `--list` flag shows current store contents: `node seed-apify-store.js --list`

### migrate-existing-stores.js

**Purpose:** Migrates companies from unnamed Apify KV stores (created by individual actor runs) into the central `scraped-companies-master-list` named store.

```bash
cd files_apify

# Auto mode: reads _run_log to find stores needing migration
node migrate-existing-stores.js

# Manual mode: specify store IDs directly
node migrate-existing-stores.js STORE_ID_1 STORE_ID_2

# List mode: show run log and migration status
node migrate-existing-stores.js --list
```

**When to use:**
- If you ran the Apify actor before the deduplication function was configured
- To consolidate data from multiple past runs
- Migration log is saved to `files_apify/migration-log.txt`

---

## 8. File Reference

| File | Purpose |
|------|---------|
| `files_apify/apify-actor-config.json` | Apify actor input configuration (search queries, location, dedup function) |
| `files_apify/apify-results.csv` | Raw output from Google Maps actor (most recent run, 59 companies) |
| `files_apify/apify_78.csv` | Archived output from a previous larger run (78 companies) |
| `files_apify/enrich-with-apollo.js` | Apollo.io enrichment script (main pipeline step 2) |
| `files_apify/enriched-companies.csv` | Output of Apollo enrichment (79 rows, mostly UNKNOWN due to small local companies) |
| `files_apify/seed-apify-store.js` | Seeds Apify KV store from companies-weekly.csv for deduplication |
| `files_apify/migrate-existing-stores.js` | Migrates data from old unnamed KV stores to the master store |
| `files_apify/migration-log.txt` | Log of migration operations |

---

## 9. Extracting to a Separate Process

The `files_apify/` directory is designed to run independently. Here's how to extract it into its own repository:

### Step 1: Create a New Repository

```bash
mkdir company-discovery
cd company-discovery
git init
```

### Step 2: Copy Files

```
company-discovery/
  enrich-with-apollo.js
  seed-apify-store.js
  migrate-existing-stores.js
  apify-actor-config.json
  .env                    # API keys
  .gitignore              # exclude .env, *.csv output files
  package.json
  README.md
```

### Step 3: Create package.json

```json
{
  "name": "company-discovery",
  "version": "1.0.0",
  "type": "module",
  "description": "Discover and qualify companies using Apify + Apollo.io",
  "scripts": {
    "enrich": "node enrich-with-apollo.js",
    "seed": "node seed-apify-store.js",
    "migrate": "node migrate-existing-stores.js"
  },
  "dependencies": {
    "apify-client": "^2.22.1",
    "csv-parser": "^3.2.0",
    "dotenv": "^16.4.7"
  }
}
```

### Step 4: Update dotenv Path

In each script, change the dotenv config path from `'../.env'` to `'./.env'`:

```javascript
// Before (references parent directory)
dotenv.config({ path: '../.env' });

// After (standalone)
dotenv.config();
```

### Step 5: Update CSV Path Defaults

In `seed-apify-store.js`, update the default CSV path:

```javascript
// Before (references parent project)
const CSV_PATH = process.argv[2] || './data/companies-weekly.csv';

// After (expects CSV in current directory)
const CSV_PATH = process.argv[2] || './companies-weekly.csv';
```

---

## 10. Running in GitHub Codespaces

GitHub Codespaces provides a cloud development environment that's ideal for running this pipeline — no local setup needed, and it keeps API keys out of your local machine.

### Step 1: Create the Repository

Push the extracted `company-discovery` repo to GitHub (see Section 9).

### Step 2: Launch a Codespace

1. Go to your `company-discovery` repository on GitHub
2. Click the green **Code** button > **Codespaces** tab > **Create codespace on main**
3. Wait for the environment to build (takes ~1 minute)

### Step 3: Configure Secrets

**Do not put API keys in the repository.** Use GitHub Codespaces secrets:

1. Go to GitHub > **Settings** > **Codespaces** > **Secrets**
2. Add these repository secrets:
   - `APIFY_API_TOKEN` - Your Apify token
   - `APOLLO_API_KEY` - Your Apollo API key
3. These are automatically available as environment variables in the Codespace

Update the scripts to read directly from environment variables (they already do via `dotenv`, but in Codespaces the secrets are injected as env vars automatically):

```javascript
const APOLLO_API_KEY = process.env.APOLLO_API_KEY;
const APIFY_TOKEN = process.env.APIFY_API_TOKEN;
```

### Step 4: Install and Run

In the Codespace terminal:

```bash
npm install

# Run Apify actor from console first, then download results:
# (Or use the Apify client to trigger runs programmatically)

# Enrich with Apollo
node enrich-with-apollo.js apify-results.csv enriched.csv

# Seed the dedup store
node seed-apify-store.js companies-weekly.csv
```

### Step 5: Download Results

After enrichment, download the output CSV:

1. In the Codespace file explorer, right-click `enriched.csv`
2. Click **Download**
3. Review in Excel/Sheets and import qualifying companies into `data/companies-weekly.csv` in the Career Future project

### Codespace Cost

- **Free tier:** 120 core-hours/month (plenty for this pipeline)
- **Machine type:** 2-core is sufficient (the work is API-bound, not CPU-bound)
- **Auto-shutdown:** Codespaces stop after 30 minutes of inactivity

### Optional: devcontainer.json

Add a `.devcontainer/devcontainer.json` to auto-configure the Codespace:

```json
{
  "name": "Company Discovery",
  "image": "mcr.microsoft.com/devcontainers/javascript-node:20",
  "postCreateCommand": "npm install",
  "secrets": {
    "APIFY_API_TOKEN": {
      "description": "Apify API token from console.apify.com"
    },
    "APOLLO_API_KEY": {
      "description": "Apollo.io API key from developer.apollo.io"
    }
  }
}
```

---

## Typical Workflow Summary

1. **Configure search queries** in `apify-actor-config.json` (location, industries)
2. **Seed the Apify KV store** with existing companies: `node seed-apify-store.js`
3. **Run Apify Google Maps actor** from console.apify.com with the config
4. **Download results** as CSV to `apify-results.csv`
5. **Enrich with Apollo**: `node enrich-with-apollo.js`
6. **Review** `enriched-companies.csv` — check employee counts, find career URLs
7. **Add qualifying companies** to `data/companies-weekly.csv` in Career Future
8. **Repeat** periodically with different search queries to discover new companies

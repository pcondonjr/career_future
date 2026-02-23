# Company Discovery

Discover and qualify companies using Apify Google Maps + Apollo.io enrichment.

## Pipeline

```
Apify Google Maps Actor  →  Apollo.io Enrichment  →  Manual Review  →  companies-weekly.csv
     (discover)                (filter/qualify)         (verify)          (Career Future input)
```

## Setup

1. Copy `.env.example` to `.env` and add your API keys:
   ```
   APIFY_API_TOKEN=your_apify_token
   APOLLO_API_KEY=your_apollo_key
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

## Usage

### Enrich companies with Apollo.io
```bash
node enrich-with-apollo.js [input.csv] [output.csv]
```
- Default input: `./apify-results.csv`
- Default output: `./enriched-companies.csv`
- Filters companies to 200-5,000 employees

### Seed Apify dedup store
```bash
node seed-apify-store.js [companies.csv]
```
- Default input: `./companies-weekly.csv`
- Pre-seeds the KV store so the Maps actor skips known companies
- Use `--list` flag to view current store contents

### Migrate old KV stores
```bash
node migrate-existing-stores.js              # auto from run log
node migrate-existing-stores.js ID1 ID2      # manual store IDs
node migrate-existing-stores.js --list       # show run log
```

### Apify actor config
`apify-actor-config.json` contains the Google Maps actor input configuration. Paste it into the Apify console when starting a run.

## Workflow

1. **Seed** the Apify KV store with existing companies: `npm run seed`
2. **Run** the Apify Google Maps actor from [console.apify.com](https://console.apify.com/) using `apify-actor-config.json`
3. **Download** results CSV and save as `apify-results.csv`
4. **Enrich** with Apollo: `npm run enrich`
5. **Review** `enriched-companies.csv` — check employee counts, find career URLs
6. **Import** qualifying companies into `data/companies-weekly.csv` in Career Future

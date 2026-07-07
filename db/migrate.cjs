/**
 * db/migrate.cjs
 *
 * Run this ONCE against your new Neon project to create all tables.
 * Seeds both companies.csv (source='curated') and companies-weekly.csv (source='weekly').
 *
 * Usage:
 *   node db/migrate.cjs            -- creates tables, imports CSVs
 *   node db/migrate.cjs --reset    -- drops all tables first, then reimports
 *   node db/migrate.cjs --dry-run  -- shows counts without writing anything
 *
 * Requires in .env:
 *   CAREER_NEON_URL=postgresql://user:pass@host/dbname?sslmode=require
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { Pool }  = require('pg');

// ── Config ────────────────────────────────────────────────────────────────────

const CURATED_CSV = path.join(__dirname, '..', 'data', 'companies.csv');
const WEEKLY_CSV  = path.join(__dirname, '..', 'data', 'companies-weekly.csv');
const RESET       = process.argv.includes('--reset');
const DRY_RUN     = process.argv.includes('--dry-run');
const BATCH_SIZE  = 50;

// Use a separate env var so this never accidentally hits the CRM database
const connString = process.env.CAREER_NEON_URL || process.env.DATABASE_URL;
if (!connString) {
  console.error('ERROR: CAREER_NEON_URL not set in .env');
  process.exit(1);
}

const pool = new Pool({
  connectionString: connString,
  ssl: { rejectUnauthorized: false },
});

// ── ATS detection ─────────────────────────────────────────────────────────────

const ATS_URL_PATTERN = /greenhouse\.io|lever\.co|workday\.com|myworkdayjobs\.com|ashby\.com|apply\.workable\.com|boards\.greenhouse|job-boards\.greenhouse|icims\.com|taleo\.net|smartrecruiters\.com|bamboohr\.com|jazz\.co/i;
const ATS_NOTES_PATTERN = /Workday|Greenhouse|Lever|Ashby|Workable|iCIMS|Taleo|SmartRecruiters|BambooHR/i;

function detectAtsPlatform(url = '', notes = '') {
  const src = `${url} ${notes}`.toLowerCase();
  if (src.includes('greenhouse'))     return 'greenhouse';
  if (src.includes('lever'))         return 'lever';
  if (src.includes('workday') || src.includes('myworkdayjobs')) return 'workday';
  if (src.includes('workable'))      return 'workable';
  if (src.includes('ashby'))         return 'ashby';
  if (src.includes('icims'))         return 'icims';
  if (src.includes('taleo'))         return 'taleo';
  if (src.includes('smartrecruiters')) return 'smartrecruiters';
  if (src.includes('bamboohr'))      return 'bamboohr';
  if (src.includes('jazz.co'))       return 'jazz';
  return 'unknown';
}

function isAtsBlocked(url = '', notes = '') {
  return ATS_URL_PATTERN.test(url) || ATS_NOTES_PATTERN.test(notes);
}

// ── Determine scrape_status from CSV data ─────────────────────────────────────

function deriveScrapeStatus(row) {
  const url   = row.careers_url || '';
  const notes = row.notes || '';

  if (isAtsBlocked(url, notes))                              return 'ats_blocked';
  if (/No careers page found/i.test(notes))                  return 'no_careers_page';
  if (/International/i.test(notes))                          return 'out_of_region';
  if (/Needs AI extraction|AI extraction recommended/i.test(notes)) return 'js_required';
  if (/Needs manual review|needs verification/i.test(notes)) return 'pending_review';
  if (row.enabled === 'false' || row.enabled === false)       return 'disabled';
  return 'active';
}

// ── DDL ───────────────────────────────────────────────────────────────────────

const DDL = `
  CREATE TABLE IF NOT EXISTS companies (
    id                   SERIAL PRIMARY KEY,
    company_name         TEXT NOT NULL,
    careers_url          TEXT,
    job_card_selector    TEXT,
    title_selector       TEXT,
    location_selector    TEXT,
    link_selector        TEXT,
    enabled              BOOLEAN DEFAULT TRUE,
    notes                TEXT,
    source               TEXT NOT NULL DEFAULT 'weekly',   -- 'curated' | 'weekly'
    scrape_status        TEXT NOT NULL DEFAULT 'active',   -- see deriveScrapeStatus()
    ats_platform         TEXT,                             -- populated when ats_blocked
    last_scraped         TIMESTAMPTZ,
    last_job_found       TIMESTAMPTZ,
    selector_confidence  TEXT,
    selector_notes       TEXT,
    agent_id             TEXT,
    hq_state             TEXT,                             -- 2-letter state from discovery (e.g. NC, OH)
    created_at           TIMESTAMPTZ DEFAULT NOW(),
    updated_at           TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(company_name)
  );

  CREATE TABLE IF NOT EXISTS job_postings (
    id             SERIAL PRIMARY KEY,
    company_name   TEXT NOT NULL,
    job_title      TEXT NOT NULL,
    location       TEXT,
    job_url        TEXT,
    first_seen     TIMESTAMPTZ DEFAULT NOW(),
    last_seen      TIMESTAMPTZ DEFAULT NOW(),
    triage_result  TEXT,    -- 'yes' | 'no' | 'pending'
    triage_reason  TEXT,
    full_jd_text   TEXT,
    applied        BOOLEAN DEFAULT FALSE,
    UNIQUE(company_name, job_url)
  );

  ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS origin               TEXT DEFAULT 'company_scrape';
  ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS match_score          INTEGER;
  ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS match_tier           TEXT;   -- 'strong' | 'possible' | 'weak'
  ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS match_reasoning      TEXT;
  ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS match_skills_matched TEXT;   -- comma-joined
  ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS match_skills_missing TEXT;   -- comma-joined
  ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS match_scored_at      TIMESTAMPTZ;

  CREATE TABLE IF NOT EXISTS claude_search_seen (
    url         TEXT PRIMARY KEY,
    checked_at  TIMESTAMPTZ DEFAULT NOW(),
    verdict     TEXT NOT NULL,  -- 'verified' | 'rejected_blocked_domain' | 'rejected_not_open' | 'rejected_wrong_role' | 'rejected_wrong_location' | 'rejected_other'
    reason      TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_claude_search_seen_checked ON claude_search_seen(checked_at);

  CREATE TABLE IF NOT EXISTS discovery_seen (
    domain      TEXT PRIMARY KEY,
    checked_at  TIMESTAMPTZ DEFAULT NOW(),
    verdict     TEXT NOT NULL,  -- 'inserted' | 'rejected_not_est' | 'rejected_not_salesforce' | 'rejected_not_new_expansion' | 'rejected_scrape_failed' | 'rejected_parse_failed' | 'rejected_duplicate_name' | 'rejected_api_error'
    reason      TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_discovery_seen_checked ON discovery_seen(checked_at);

  CREATE TABLE IF NOT EXISTS ats_blocked (
    id            SERIAL PRIMARY KEY,
    company_name  TEXT NOT NULL UNIQUE,
    careers_url   TEXT,
    ats_platform  TEXT,
    date_flagged  TIMESTAMPTZ DEFAULT NOW(),
    source        TEXT DEFAULT 'csv_import'  -- 'csv_import' | 'auto_detected' | 'manual'
  );

  CREATE INDEX IF NOT EXISTS idx_companies_scrape_status ON companies(scrape_status);
  CREATE INDEX IF NOT EXISTS idx_companies_source        ON companies(source);
  CREATE INDEX IF NOT EXISTS idx_companies_last_scraped  ON companies(last_scraped NULLS FIRST);
  CREATE INDEX IF NOT EXISTS idx_job_postings_triage     ON job_postings(triage_result);
  CREATE INDEX IF NOT EXISTS idx_job_postings_company    ON job_postings(company_name);
  CREATE INDEX IF NOT EXISTS idx_job_postings_match_score ON job_postings(match_score DESC NULLS LAST);
`;

// ── Import helpers ────────────────────────────────────────────────────────────

async function importCsv(client, csvPath, source) {
  if (!fs.existsSync(csvPath)) {
    console.warn(`  WARNING: CSV not found at ${csvPath} — skipping`);
    return 0;
  }

  const raw  = fs.readFileSync(csvPath, 'utf8');
  const rows = parse(raw, { columns: true, skip_empty_lines: true });
  console.log(`  ${rows.length} rows from ${path.basename(csvPath)}`);

  if (DRY_RUN) {
    // Just report what would happen
    const statuses = {};
    rows.forEach(r => {
      const s = deriveScrapeStatus(r);
      statuses[s] = (statuses[s] || 0) + 1;
    });
    console.log('  Dry-run status breakdown:', statuses);
    return rows.length;
  }

  let imported = 0;
  let atsCount = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch  = rows.slice(i, i + BATCH_SIZE);
    const values = [];
    const params = [];

    batch.forEach((r, idx) => {
      const offset      = idx * 12;
      const scrapeStatus = deriveScrapeStatus(r);
      const atsPlatform  = scrapeStatus === 'ats_blocked'
        ? detectAtsPlatform(r.careers_url, r.notes)
        : null;
      const enabledBool  = String(r.enabled).toLowerCase() !== 'false';

      if (scrapeStatus === 'ats_blocked') atsCount++;

      values.push(
        `($${offset+1},$${offset+2},$${offset+3},$${offset+4},$${offset+5},` +
        ` $${offset+6},$${offset+7},$${offset+8},$${offset+9},$${offset+10},` +
        ` $${offset+11},$${offset+12})`
      );
      params.push(
        r.company_name       || '',
        r.careers_url        || '',
        r.job_card_selector  || '',
        r.title_selector     || '',
        r.location_selector  || '',
        r.link_selector      || '',
        enabledBool,
        r.notes              || '',
        source,
        scrapeStatus,
        atsPlatform,
        r.selector_confidence || null
      );
    });

    await client.query(`
      INSERT INTO companies (
        company_name, careers_url, job_card_selector, title_selector,
        location_selector, link_selector, enabled, notes, source,
        scrape_status, ats_platform, selector_confidence
      ) VALUES ${values.join(', ')}
      ON CONFLICT (company_name) DO UPDATE SET
        source        = EXCLUDED.source,
        scrape_status = EXCLUDED.scrape_status,
        ats_platform  = EXCLUDED.ats_platform,
        updated_at    = NOW()
    `, params);

    imported += batch.length;
    process.stdout.write(`\r    ${imported}/${rows.length} imported...`);
  }

  console.log(`\r    ${imported} rows written (${atsCount} marked ats_blocked)    `);

  // Populate ats_blocked table for anything flagged
  const atsRows = rows.filter(r => isAtsBlocked(r.careers_url, r.notes));
  if (atsRows.length > 0) {
    console.log(`  Populating ats_blocked table with ${atsRows.length} entries...`);
    for (let i = 0; i < atsRows.length; i += BATCH_SIZE) {
      const batch  = atsRows.slice(i, i + BATCH_SIZE);
      const values = batch.map((_, idx) => {
        const o = idx * 4;
        return `($${o+1},$${o+2},$${o+3},$${o+4})`;
      });
      const params = [];
      batch.forEach(r => {
        params.push(
          r.company_name || '',
          r.careers_url  || '',
          detectAtsPlatform(r.careers_url, r.notes),
          'csv_import'
        );
      });
      await client.query(`
        INSERT INTO ats_blocked (company_name, careers_url, ats_platform, source)
        VALUES ${values.join(', ')}
        ON CONFLICT (company_name) DO NOTHING
      `, params);
    }
  }

  return imported;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('career-future DB migration');
  console.log('Connection:', connString.replace(/:[^@]+@/, ':***@'));
  if (DRY_RUN) console.log('DRY RUN — no writes will occur\n');

  const client = await pool.connect();

  try {
    if (RESET && !DRY_RUN) {
      console.log('Dropping existing tables...');
      await client.query(`
        DROP TABLE IF EXISTS job_postings;
        DROP TABLE IF EXISTS ats_blocked;
        DROP TABLE IF EXISTS companies;
      `);
      console.log('Tables dropped.\n');
    }

    if (!DRY_RUN) {
      console.log('Creating tables and indexes...');
      await client.query(DDL);
      console.log('Schema ready.\n');
    }

    // Check if already seeded
    if (!DRY_RUN && !RESET) {
      const { rows: [{ count }] } = await client.query(
        'SELECT COUNT(*) AS count FROM companies'
      );
      if (parseInt(count) > 0) {
        console.log(`companies table already has ${count} rows.`);
        console.log('Use --reset to wipe and reimport, or --dry-run to preview.\n');

        // Still show current status breakdown
        const { rows: stats } = await client.query(`
          SELECT scrape_status, COUNT(*) as count
          FROM companies GROUP BY scrape_status ORDER BY count DESC
        `);
        console.log('Current status breakdown:');
        stats.forEach(r => console.log(`  ${r.scrape_status.padEnd(20)} ${r.count}`));
        return;
      }
    }

    // Import both CSVs
    console.log('Importing curated companies (companies.csv)...');
    const curatedCount = await importCsv(client, CURATED_CSV, 'curated');

    console.log('\nImporting weekly companies (companies-weekly.csv)...');
    const weeklyCount = await importCsv(client, WEEKLY_CSV, 'weekly');

    if (!DRY_RUN) {
      // Final summary from DB
      const { rows: stats } = await client.query(`
        SELECT scrape_status, source, COUNT(*) as count
        FROM companies
        GROUP BY scrape_status, source
        ORDER BY scrape_status, source
      `);

      console.log('\n── Final DB breakdown ──────────────────────────────');
      let lastStatus = '';
      stats.forEach(r => {
        if (r.scrape_status !== lastStatus) {
          console.log(`\n  ${r.scrape_status}`);
          lastStatus = r.scrape_status;
        }
        console.log(`    ${r.source.padEnd(10)} ${r.count}`);
      });

      const { rows: [{ total }] } = await client.query(
        'SELECT COUNT(*) AS total FROM companies'
      );
      const { rows: [{ ats_total }] } = await client.query(
        'SELECT COUNT(*) AS ats_total FROM ats_blocked'
      );

      console.log(`\n  Total companies : ${total}`);
      console.log(`  ATS blocked     : ${ats_total}`);
      console.log('\nMigration complete.');
    } else {
      console.log(`\nDry run complete. Would import ~${curatedCount + weeklyCount} rows.`);
    }

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});

/**
 * setup_neon.cjs
 *
 * Creates the 'companies' table in Neon PostgreSQL and imports
 * data/companies-weekly.csv into it.
 *
 * Usage:
 *   node setup_neon.cjs
 *   node setup_neon.cjs --reset   (drops and recreates the table)
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { Pool } = require('pg');

const CSV_PATH = path.join(__dirname, 'data', 'companies-weekly.csv');
const RESET = process.argv.includes('--reset');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  const client = await pool.connect();

  try {
    if (RESET) {
      console.log('Dropping existing companies table...');
      await client.query('DROP TABLE IF EXISTS companies');
    }

    // Create table
    await client.query(`
      CREATE TABLE IF NOT EXISTS companies (
        id              SERIAL PRIMARY KEY,
        company_name    TEXT NOT NULL,
        careers_url     TEXT,
        job_card_selector   TEXT,
        title_selector      TEXT,
        location_selector   TEXT,
        link_selector       TEXT,
        enabled         TEXT,
        notes           TEXT,
        status          TEXT DEFAULT 'pending',
        agent_id        TEXT,
        started_at      TIMESTAMPTZ,
        completed_at    TIMESTAMPTZ,
        selector_confidence TEXT,
        selector_notes  TEXT,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(company_name)
      )
    `);
    console.log('Table "companies" ready.');

    // Check existing row count
    const { rows: [{ count }] } = await client.query('SELECT COUNT(*) AS count FROM companies');
    if (parseInt(count) > 0 && !RESET) {
      console.log(`Table already has ${count} rows. Use --reset to reimport.`);
      return;
    }

    // Load CSV
    if (!fs.existsSync(CSV_PATH)) {
      console.error(`CSV not found: ${CSV_PATH}`);
      process.exit(1);
    }
    const raw = fs.readFileSync(CSV_PATH, 'utf8');
    const rows = parse(raw, { columns: true, skip_empty_lines: true });
    console.log(`Importing ${rows.length} companies from CSV...`);

    // Batch insert
    let imported = 0;
    const BATCH = 50;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const values = [];
      const params = [];
      batch.forEach((r, idx) => {
        const offset = idx * 8;
        values.push(`($${offset+1}, $${offset+2}, $${offset+3}, $${offset+4}, $${offset+5}, $${offset+6}, $${offset+7}, $${offset+8})`);
        params.push(
          r.company_name || '',
          r.careers_url || '',
          r.job_card_selector || '',
          r.title_selector || '',
          r.location_selector || '',
          r.link_selector || '',
          r.enabled || '',
          r.notes || ''
        );
      });

      await client.query(`
        INSERT INTO companies (company_name, careers_url, job_card_selector, title_selector, location_selector, link_selector, enabled, notes)
        VALUES ${values.join(', ')}
        ON CONFLICT (company_name) DO NOTHING
      `, params);

      imported += batch.length;
      process.stdout.write(`\r  Imported ${imported}/${rows.length}`);
    }

    console.log(`\nDone! ${imported} companies imported into Neon.`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});

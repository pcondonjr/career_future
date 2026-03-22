/**
 * export_neon.cjs
 *
 * Exports the Neon 'companies' table back to data/companies-weekly.csv.
 *
 * Usage:
 *   node export_neon.cjs
 *   node export_neon.cjs --output data/companies-weekly-backup.csv
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { stringify } = require('csv-stringify/sync');
const { Pool } = require('pg');

const DEFAULT_OUTPUT = path.join(__dirname, 'data', 'companies-weekly.csv');
const outputIdx = process.argv.indexOf('--output');
const OUTPUT_PATH = outputIdx !== -1 ? process.argv[outputIdx + 1] : DEFAULT_OUTPUT;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  const client = await pool.connect();

  try {
    const { rows } = await client.query(`
      SELECT company_name, careers_url, job_card_selector, title_selector,
             location_selector, link_selector, enabled, notes
      FROM companies
      ORDER BY company_name
    `);

    if (rows.length === 0) {
      console.log('No rows in companies table.');
      return;
    }

    const csv = stringify(rows, {
      header: true,
      columns: ['company_name', 'careers_url', 'job_card_selector', 'title_selector',
                 'location_selector', 'link_selector', 'enabled', 'notes'],
    });

    fs.writeFileSync(OUTPUT_PATH, csv, 'utf8');
    console.log(`Exported ${rows.length} companies to ${OUTPUT_PATH}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});

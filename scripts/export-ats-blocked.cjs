/**
 * scripts/export-ats-blocked.cjs
 *
 * One-time utility. Reads the ats_blocked table from Neon and writes
 * data/ats-blocked-export.json for your review.
 *
 * Run AFTER db/migrate.cjs completes:
 *   node scripts/export-ats-blocked.cjs
 *
 * The JSON groups companies by ATS platform so you can quickly scan
 * for anything that was mis-classified before it gets permanently
 * excluded from scraping.
 *
 * To manually rescue a company back to active:
 *   node scripts/export-ats-blocked.cjs --rescue "Company Name"
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');

const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'ats-blocked-export.json');
const RESCUE_IDX  = process.argv.indexOf('--rescue');
const RESCUE_NAME = RESCUE_IDX > -1 ? process.argv[RESCUE_IDX + 1] : null;

const pool = new Pool({
  connectionString: process.env.CAREER_NEON_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function main() {
  const client = await pool.connect();

  try {
    // ── Rescue mode ──────────────────────────────────────────────────────────
    if (RESCUE_NAME) {
      console.log(`Rescuing "${RESCUE_NAME}" from ATS blocklist...`);

      const { rowCount: deleted } = await client.query(
        `DELETE FROM ats_blocked WHERE company_name ILIKE $1`,
        [RESCUE_NAME]
      );
      const { rowCount: updated } = await client.query(
        `UPDATE companies SET scrape_status = 'active', ats_platform = NULL, updated_at = NOW()
         WHERE company_name ILIKE $1`,
        [RESCUE_NAME]
      );

      if (deleted === 0 && updated === 0) {
        console.log(`  No match found for "${RESCUE_NAME}".`);
      } else {
        console.log(`  Removed from ats_blocked: ${deleted} row(s)`);
        console.log(`  Updated companies status: ${updated} row(s)`);
        console.log(`  "${RESCUE_NAME}" is now scrape_status = 'active'`);
      }
      return;
    }

    // ── Export mode ──────────────────────────────────────────────────────────
    const { rows } = await client.query(`
      SELECT
        ab.company_name,
        ab.careers_url,
        ab.ats_platform,
        ab.date_flagged,
        ab.source,
        c.notes
      FROM ats_blocked ab
      LEFT JOIN companies c ON c.company_name = ab.company_name
      ORDER BY ab.ats_platform, ab.company_name
    `);

    console.log(`Found ${rows.length} ATS-blocked companies.`);

    // Group by platform
    const grouped = {};
    rows.forEach(r => {
      const platform = r.ats_platform || 'unknown';
      if (!grouped[platform]) grouped[platform] = [];
      grouped[platform].push({
        company_name: r.company_name,
        careers_url:  r.careers_url,
        notes:        r.notes,
        date_flagged: r.date_flagged,
        source:       r.source,
      });
    });

    // Summary
    console.log('\nBreakdown by platform:');
    Object.entries(grouped)
      .sort((a, b) => b[1].length - a[1].length)
      .forEach(([platform, companies]) => {
        console.log(`  ${platform.padEnd(20)} ${companies.length}`);
      });

    const output = {
      exported_at:    new Date().toISOString(),
      total:          rows.length,
      note:           'To rescue a company: node scripts/export-ats-blocked.cjs --rescue "Company Name"',
      by_platform:    grouped,
    };

    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));
    console.log(`\nExported to: ${OUTPUT_PATH}`);
    console.log('Review the file, then use --rescue for any mis-classified companies.');

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});

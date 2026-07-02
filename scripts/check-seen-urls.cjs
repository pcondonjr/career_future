/**
 * scripts/check-seen-urls.cjs
 *
 * Filters a list of candidate URLs against claude_search_seen so the search
 * agent doesn't burn its WebFetch budget re-checking pages it already
 * evaluated (and rejected) in a prior firing. Call this right after
 * WebSearch, before WebFetching any candidate.
 *
 * Usage:
 *   node scripts/check-seen-urls.cjs '["https://...","https://..."]'
 *   node scripts/check-seen-urls.cjs '[...]' --max-age-days 21   -- re-check anything older (default 21)
 *
 * Prints JSON to stdout: { "new": [...urls worth fetching...], "seen": [{url, verdict, checked_at}, ...] }
 */

'use strict';

require('dotenv').config();
const { Pool } = require('pg');

const MAX_AGE_IDX = process.argv.indexOf('--max-age-days');
const MAX_AGE_DAYS = MAX_AGE_IDX > -1 ? parseInt(process.argv[MAX_AGE_IDX + 1]) : 21;

const pool = new Pool({
  connectionString: process.env.CAREER_NEON_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function run() {
  const raw = process.argv.slice(2).find(a => !a.startsWith('--') && a !== String(MAX_AGE_DAYS));
  if (!raw) {
    console.error('Usage: node scripts/check-seen-urls.cjs \'["url1","url2"]\'');
    process.exit(1);
  }

  const urls = JSON.parse(raw);
  const client = await pool.connect();

  try {
    const { rows } = await client.query(`
      SELECT url, verdict, checked_at
      FROM claude_search_seen
      WHERE url = ANY($1::text[])
        AND checked_at > NOW() - INTERVAL '1 day' * $2
    `, [urls, MAX_AGE_DAYS]);

    const seenUrls = new Set(rows.map(r => r.url));
    const fresh = urls.filter(u => !seenUrls.has(u));

    console.log(JSON.stringify({ new: fresh, seen: rows }, null, 2));
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => {
  console.error('check-seen-urls failed:', err.message);
  process.exit(1);
});

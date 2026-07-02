/**
 * src/backend/fetch-jd.cjs
 *
 * Fetches full job-description text for job_postings that have already
 * cleared triage (triage_result = 'yes') but don't have full_jd_text yet.
 * cheerio-scraper.cjs never visits individual job detail pages — only
 * the careers listing page — so this is a separate per-job HTTP request.
 *
 * Usage:
 *   node src/backend/fetch-jd.cjs                  -- fetch batch of 30
 *   node src/backend/fetch-jd.cjs --batch 10
 *   node src/backend/fetch-jd.cjs --dry-run
 */

'use strict';

require('dotenv').config();
const cheerio  = require('cheerio');
const { Pool } = require('pg');

// ── Config ────────────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 12_000;
const FETCH_CONCURRENCY = 3;
const MAX_JD_CHARS = 8_000;   // bounds Sonnet input cost in the match-scoring step

const BATCH_SIZE = parseInt(process.argv.find(a => a.startsWith('--batch='))?.split('=')[1]
                     || (process.argv.indexOf('--batch') > -1
                         ? process.argv[process.argv.indexOf('--batch') + 1]
                         : '30')) || 30;

const DRY_RUN = process.argv.includes('--dry-run');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const pool = new Pool({
  connectionString: process.env.CAREER_NEON_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ── Fetch + extract ───────────────────────────────────────────────────────────

async function fetchJdText(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':      UA,
        'Accept':          'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });

    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };

    const html = await res.text();
    const $ = cheerio.load(html);
    $('nav, header, footer, script, style, noscript').remove();

    const text = $('body').text().replace(/\s+/g, ' ').trim();
    if (text.length < 200) return { ok: false, reason: 'extracted text too short' };

    return { ok: true, text: text.slice(0, MAX_JD_CHARS) };
  } catch (err) {
    if (err.name === 'AbortError') return { ok: false, reason: 'timeout' };
    return { ok: false, reason: err.message };
  } finally {
    clearTimeout(timer);
  }
}

// ── DB ────────────────────────────────────────────────────────────────────────

async function getPendingJobs(client, limit) {
  const { rows } = await client.query(`
    SELECT id, job_url
    FROM job_postings
    WHERE triage_result = 'yes'
      AND full_jd_text IS NULL
      AND job_url IS NOT NULL AND job_url != ''
    ORDER BY first_seen DESC
    LIMIT $1
  `, [limit]);
  return rows;
}

async function saveJdText(client, id, text) {
  if (DRY_RUN) return;
  await client.query(`UPDATE job_postings SET full_jd_text = $1 WHERE id = $2`, [text, id]);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log(`JD fetch${DRY_RUN ? ' (DRY RUN)' : ''} — batch ${BATCH_SIZE}`);

  const client = await pool.connect();
  let fetched = 0, failed = 0;

  try {
    const jobs = await getPendingJobs(client, BATCH_SIZE);
    console.log(`${jobs.length} jobs pending JD fetch`);

    for (let i = 0; i < jobs.length; i += FETCH_CONCURRENCY) {
      const chunk = jobs.slice(i, i + FETCH_CONCURRENCY);
      await Promise.all(chunk.map(async job => {
        const result = await fetchJdText(job.job_url);
        if (result.ok) {
          await saveJdText(client, job.id, result.text);
          fetched++;
        } else {
          failed++;
          console.log(`  [skip] id=${job.id} ${job.job_url} — ${result.reason}`);
        }
      }));
    }

    console.log(`Done. Fetched: ${fetched}, Failed/skipped: ${failed}`);
    return { fetched, failed };
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  run().catch(err => {
    console.error('JD fetch failed:', err.message);
    process.exit(1);
  });
}

module.exports = { run, fetchJdText };

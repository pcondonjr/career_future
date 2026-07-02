/**
 * scripts/ingest-claude-job.cjs
 *
 * Writes job postings discovered by the Claude search agent (running as a
 * /schedule cloud routine) directly into job_postings. The agent has already
 * read and verified the page itself, so triage_result is set to 'yes'
 * immediately and full_jd_text comes from what the agent already fetched —
 * no re-triage, no re-fetch.
 *
 * Hard-rejects any URL on the shared ATS/job-board blocklist regardless of
 * what the caller claims, as a backstop independent of the agent's own
 * judgment.
 *
 * Every candidate — accepted OR rejected — gets recorded in
 * claude_search_seen, so a future firing can skip URLs already evaluated
 * (see scripts/check-seen-urls.cjs) instead of re-spending WebFetch budget
 * on the same dead ends every run.
 *
 * Usage:
 *   node scripts/ingest-claude-job.cjs '{"title":"...","company":"...","location":"...","url":"...","full_text":"..."}'
 *   node scripts/ingest-claude-job.cjs '[{...}, {...}]'                -- batch (array)
 *   node scripts/ingest-claude-job.cjs --file jobs.json                -- batch from file
 *   node scripts/ingest-claude-job.cjs --dry-run '{...}'               -- validate only, no DB write
 *
 * To record a candidate you evaluated and REJECTED (so it's skipped next
 * time), pass `verdict` + `url` instead of the full job shape:
 *   {"url":"...","verdict":"rejected_wrong_role","reason":"Consultant, not Administrator"}
 * Valid rejected verdicts: rejected_not_open | rejected_wrong_role |
 * rejected_wrong_location | rejected_other (rejected_blocked_domain and
 * rejected_missing_fields are set automatically by this script).
 *
 * Optional per-job field `company_careers_url`: if present, also upserts the
 * company into `companies` (source='claude_discovery', ON CONFLICT DO NOTHING)
 * so the existing local scraper picks up future openings from that company.
 */

'use strict';

require('dotenv').config();
const fs   = require('fs');
const { Pool } = require('pg');
const { isBlockedUrl } = require('../src/backend/blocked-domains.cjs');

// ── Config ────────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes('--dry-run');
const FILE_IDX = process.argv.indexOf('--file');

const pool = new Pool({
  connectionString: process.env.CAREER_NEON_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ── Input parsing ─────────────────────────────────────────────────────────────

function loadJobs() {
  let raw;
  if (FILE_IDX > -1) {
    raw = fs.readFileSync(process.argv[FILE_IDX + 1], 'utf8');
  } else {
    raw = process.argv.slice(2).find(a => !a.startsWith('--'));
    if (!raw) {
      console.error('Usage: node scripts/ingest-claude-job.cjs \'{"title":...}\' | --file jobs.json');
      process.exit(1);
    }
  }
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

// ── DB write ──────────────────────────────────────────────────────────────────

async function upsertJob(client, job) {
  await client.query(`
    INSERT INTO job_postings (
      company_name, job_title, location, job_url,
      triage_result, triage_reason, full_jd_text, first_seen, last_seen, origin
    ) VALUES ($1, $2, $3, $4, 'yes', 'Verified live by Claude search agent', $5, NOW(), NOW(), 'claude_search')
    ON CONFLICT (company_name, job_url) DO UPDATE SET
      last_seen     = NOW(),
      full_jd_text  = COALESCE(job_postings.full_jd_text, EXCLUDED.full_jd_text)
  `, [job.company, job.title, job.location || '', job.url, job.full_text || null]);
}

async function upsertCompany(client, job) {
  if (!job.company_careers_url) return;
  await client.query(`
    INSERT INTO companies (company_name, careers_url, source, scrape_status)
    VALUES ($1, $2, 'claude_discovery', 'active')
    ON CONFLICT (company_name) DO NOTHING
  `, [job.company, job.company_careers_url]);
}

async function markSeen(client, url, verdict, reason) {
  if (DRY_RUN) return;
  await client.query(`
    INSERT INTO claude_search_seen (url, checked_at, verdict, reason)
    VALUES ($1, NOW(), $2, $3)
    ON CONFLICT (url) DO UPDATE SET checked_at = NOW(), verdict = EXCLUDED.verdict, reason = EXCLUDED.reason
  `, [url, verdict, reason || null]);
}

const REJECTED_VERDICTS = new Set([
  'rejected_not_open', 'rejected_wrong_role', 'rejected_wrong_location', 'rejected_other',
]);

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  const jobs = loadJobs();
  console.log(`Ingesting ${jobs.length} job(s)${DRY_RUN ? ' (DRY RUN)' : ''}`);

  const client = await pool.connect();
  let inserted = 0, rejected = 0;

  try {
    for (const job of jobs) {
      if (!job.url) {
        rejected++;
        console.log(`  [reject] missing url: ${JSON.stringify(job).slice(0, 100)}`);
        continue;
      }

      // Explicit rejection report (agent evaluated and passed) — just record as seen.
      if (job.verdict && REJECTED_VERDICTS.has(job.verdict)) {
        await markSeen(client, job.url, job.verdict, job.reason);
        rejected++;
        console.log(`  [seen:${job.verdict}] ${job.url}`);
        continue;
      }

      if (!job.title || !job.company) {
        await markSeen(client, job.url, 'rejected_other', 'missing title/company');
        rejected++;
        console.log(`  [reject] missing required field (title/company): ${JSON.stringify(job).slice(0, 100)}`);
        continue;
      }
      if (isBlockedUrl(job.url)) {
        await markSeen(client, job.url, 'rejected_blocked_domain', null);
        rejected++;
        console.log(`  [reject] blocked domain: ${job.url}`);
        continue;
      }

      if (!DRY_RUN) {
        await upsertJob(client, job);
        await upsertCompany(client, job);
        await markSeen(client, job.url, 'verified', null);
      }
      inserted++;
      console.log(`  [ok] ${job.title} @ ${job.company}`);
    }

    console.log(`Done. Inserted: ${inserted}, Rejected: ${rejected}`);
    return { inserted, rejected };
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  run().catch(err => {
    console.error('Ingest failed:', err.message);
    process.exit(1);
  });
}

module.exports = { run };

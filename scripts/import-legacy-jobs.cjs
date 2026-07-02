/**
 * scripts/import-legacy-jobs.cjs
 *
 * Imports jobs from the legacy flat-JSON databases (jobs_database.json,
 * jobs_database_weekly.json, jobs_database_dorks.json) into the Neon
 * `job_postings` table, so match-scoring has one unified data source
 * instead of two disconnected pipelines.
 *
 * Idempotent — safe to re-run on a schedule, since index.js keeps writing
 * new entries to these JSON files independently of this script.
 *
 * Usage:
 *   node scripts/import-legacy-jobs.cjs              -- import all three sources
 *   node scripts/import-legacy-jobs.cjs --dry-run     -- preview counts, no API/DB calls
 *   node scripts/import-legacy-jobs.cjs --limit 20    -- cap per-source import (testing)
 */

'use strict';

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { triageBatch } = require('../src/backend/triage.cjs');

// ── Config ────────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT_IDX = process.argv.indexOf('--limit');
const LIMIT = LIMIT_IDX > -1 ? parseInt(process.argv[LIMIT_IDX + 1]) : Infinity;
const TRIAGE_CONCURRENCY = 5;

const SOURCES = [
  { file: path.join(__dirname, '..', 'jobs_database.json'),         origin: 'legacy_daily' },
  { file: path.join(__dirname, '..', 'jobs_database_weekly.json'),  origin: 'legacy_weekly' },
  { file: path.join(__dirname, '..', 'jobs_database_dorks.json'),   origin: 'legacy_dorks' },
];

const pool = new Pool({
  connectionString: process.env.CAREER_NEON_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ── Load ──────────────────────────────────────────────────────────────────────

function loadSource({ file, origin }) {
  if (!fs.existsSync(file)) {
    console.warn(`  WARNING: ${file} not found — skipping`);
    return [];
  }

  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entries = Object.values(parsed).slice(0, LIMIT);

  return entries
    .filter(job => job.url && job.title)
    .map(job => ({
      company_name: job.company || 'Unknown',
      job_title:    job.title,
      location:     job.location || '',
      job_url:      job.url,
      first_seen:   job.firstSeen ? new Date(job.firstSeen) : new Date(),
      last_seen:    job.lastSeen  ? new Date(job.lastSeen)  : new Date(),
      origin,
    }));
}

// ── DB write ──────────────────────────────────────────────────────────────────

async function upsertJob(client, job) {
  if (DRY_RUN) return;

  await client.query(`
    INSERT INTO job_postings (
      company_name, job_title, location, job_url,
      triage_result, triage_reason, first_seen, last_seen, origin
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    ON CONFLICT (company_name, job_url) DO UPDATE SET
      last_seen     = GREATEST(job_postings.last_seen, EXCLUDED.last_seen),
      triage_result = EXCLUDED.triage_result,
      triage_reason = EXCLUDED.triage_reason
  `, [
    job.company_name, job.job_title, job.location, job.job_url,
    job.triage_result, job.triage_reason, job.first_seen, job.last_seen, job.origin,
  ]);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  console.log(`Legacy job import${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log('═'.repeat(50));

  const client = await pool.connect();

  try {
    for (const source of SOURCES) {
      const jobs = loadSource(source);
      console.log(`\n${source.origin}: ${jobs.length} entries loaded from ${path.basename(source.file)}`);

      if (jobs.length === 0) continue;

      if (DRY_RUN) {
        console.log(`  (dry-run: skipping triage + DB writes)`);
        continue;
      }

      let yesCount = 0, noCount = 0, errCount = 0;

      const triaged = await triageBatch(
        jobs.map(j => ({ title: j.job_title, location: j.location })),
        { concurrency: TRIAGE_CONCURRENCY }
      );

      for (let i = 0; i < jobs.length; i++) {
        const t = triaged[i];
        jobs[i].triage_result = t.relevant ? 'yes' : 'no';
        jobs[i].triage_reason = t.reason;
        if (t.relevant) yesCount++; else noCount++;

        try {
          await upsertJob(client, jobs[i]);
        } catch (err) {
          errCount++;
          console.error(`  ERROR upserting "${jobs[i].job_title}": ${err.message}`);
        }
      }

      console.log(`  Triaged: ${yesCount} yes, ${noCount} no, ${errCount} errors`);
    }

    console.log('\n' + '═'.repeat(50));
    console.log('Import complete.');
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  run().catch(err => {
    console.error('Import failed:', err.message);
    process.exit(1);
  });
}

module.exports = { run };

/**
 * src/backend/match-harness.cjs
 *
 * Orchestrates the full match pipeline: pull in new legacy jobs, fetch JD
 * text for triage-passed jobs, then score matches against the resume.
 * Called on a schedule by neon-scheduler.cjs, or run manually.
 *
 * Usage:
 *   node src/backend/match-harness.cjs                -- run all three steps
 *   node src/backend/match-harness.cjs --batch 10      -- cap each step's batch size
 *   node src/backend/match-harness.cjs --dry-run
 */

'use strict';

const importLegacyJobs = require('../../scripts/import-legacy-jobs.cjs');
const fetchJd           = require('./fetch-jd.cjs');
const matchScore        = require('./match-score.cjs');

async function run() {
  console.log('\n' + '═'.repeat(60));
  console.log(`Match harness run — ${new Date().toLocaleString()}`);
  console.log('═'.repeat(60));

  console.log('\n[1/3] Importing legacy jobs...');
  await importLegacyJobs.run();

  console.log('\n[2/3] Fetching JD text...');
  await fetchJd.run();

  console.log('\n[3/3] Scoring matches...');
  await matchScore.run();

  console.log('\n' + '═'.repeat(60));
  console.log('Match harness run complete');
  console.log('═'.repeat(60) + '\n');
}

if (require.main === module) {
  run().catch(err => {
    console.error('Match harness failed:', err.message);
    process.exit(1);
  });
}

module.exports = { run };

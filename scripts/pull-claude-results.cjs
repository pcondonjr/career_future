/**
 * scripts/pull-claude-results.cjs
 *
 * Pulls job-search results reported by the Claude search agent (a /schedule
 * cloud routine) from the `claude/search-results` git branch and ingests
 * them locally, where CAREER_NEON_URL/ANTHROPIC_API_KEY already work.
 *
 * The cloud routine has no database credentials (Claude Code cloud
 * environments don't reliably propagate secrets to routine sessions — see
 * commit history) — instead it commits a JSON file per run to that branch
 * via its default git push access. This script reads those files via git
 * plumbing (no working-tree checkout, safe to run alongside the live
 * dashboard/scheduler processes) and feeds each one through the existing
 * scripts/ingest-claude-job.cjs, then scores anything new.
 *
 * Usage:
 *   node scripts/pull-claude-results.cjs
 *   node scripts/pull-claude-results.cjs --dry-run   -- list what would be ingested, no writes
 */

'use strict';

const { execFileSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const DRY_RUN = process.argv.includes('--dry-run');
const REPO_ROOT = path.join(__dirname, '..');
const RESULTS_DIR = 'data/claude-search-results';
const BRANCH = 'claude/search-results';
const PROCESSED_MARKER = path.join(REPO_ROOT, '.claude-results-processed.json');

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
}

function loadProcessed() {
  if (!fs.existsSync(PROCESSED_MARKER)) return new Set();
  return new Set(JSON.parse(fs.readFileSync(PROCESSED_MARKER, 'utf8')));
}

function saveProcessed(set) {
  fs.writeFileSync(PROCESSED_MARKER, JSON.stringify([...set], null, 2));
}

function run() {
  console.log(`Pulling Claude search results${DRY_RUN ? ' (DRY RUN)' : ''}`);

  // Does the results branch exist on the remote yet?
  let remoteExists;
  try {
    remoteExists = git(['ls-remote', '--exit-code', 'origin', BRANCH]).trim().length > 0;
  } catch (_) {
    remoteExists = false;
  }
  if (!remoteExists) {
    console.log(`No ${BRANCH} branch on origin yet — nothing to pull (routine hasn't reported anything).`);
    return { ingested: 0 };
  }

  git(['fetch', 'origin', `${BRANCH}:refs/remotes/origin/${BRANCH}`]);

  let files;
  try {
    files = git(['ls-tree', '-r', '--name-only', `origin/${BRANCH}`, '--', RESULTS_DIR])
      .split('\n').map(f => f.trim()).filter(Boolean);
  } catch (_) {
    files = [];
  }

  const processed = loadProcessed();
  const newFiles = files.filter(f => !processed.has(f));

  console.log(`${files.length} result file(s) on ${BRANCH}, ${newFiles.length} new`);
  if (newFiles.length === 0) return { ingested: 0 };

  let ingested = 0;

  for (const file of newFiles) {
    console.log(`\n--- ${file} ---`);
    const content = git(['show', `origin/${BRANCH}:${file}`]);

    const tmpFile = path.join(os.tmpdir(), `claude-results-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, content);

    try {
      const args = ['scripts/ingest-claude-job.cjs', '--file', tmpFile];
      if (DRY_RUN) args.push('--dry-run');
      const out = execFileSync('node', args, { cwd: REPO_ROOT, encoding: 'utf8' });
      console.log(out);
      ingested++;
    } finally {
      fs.unlinkSync(tmpFile);
    }

    processed.add(file);
  }

  if (!DRY_RUN) {
    saveProcessed(processed);

    if (ingested > 0) {
      console.log('\nScoring newly ingested jobs...');
      execFileSync('node', ['src/backend/match-score.cjs'], { cwd: REPO_ROOT, stdio: 'inherit' });
    }
  }

  console.log(`\nDone. Processed ${ingested} result file(s).`);
  return { ingested };
}

if (require.main === module) {
  run();
}

module.exports = { run };

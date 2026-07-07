/**
 * src/backend/neon-scheduler.cjs
 *
 * Standalone cron scheduler for the Neon-backed direct scraper.
 * Runs SEPARATELY from the existing Electron scheduler (scheduler.js).
 * Does not modify any existing files.
 *
 * Schedule (Eastern Time):
 *   Weekdays 7:00 AM  — batch of 50 companies
 *   Weekdays 2:00 PM  — batch of 50 companies
 *   Sunday   9:00 PM  — company discovery (career pages + press releases + careers-url enrichment)
 *
 * At this rate: 100 companies/day × 5 days = 500/week.
 * Full ~540 active companies cycle completes in ~5 days.
 *
 * Usage:
 *   node src/backend/neon-scheduler.cjs             -- start scheduler (blocks)
 *   node src/backend/neon-scheduler.cjs --now       -- run scrape once immediately, then exit
 *   node src/backend/neon-scheduler.cjs --discovery -- run discovery pipeline once immediately, then exit
 *   node src/backend/neon-scheduler.cjs --status    -- show next scheduled runs
 *
 * To run as a background process on Windows:
 *   Start-Process -WindowStyle Hidden node -ArgumentList "src/backend/neon-scheduler.cjs"
 *
 * Or add to package.json scripts:
 *   "neon:scheduler": "node src/backend/neon-scheduler.cjs",
 *   "neon:run": "node src/backend/neon-scheduler.cjs --now",
 *   "neon:dashboard": "node neon-dashboard-server.cjs"
 */

'use strict';

require('dotenv').config();
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const cron = require('node-cron');
const { run } = require('./direct-scraper.cjs');
const { run: runMatchHarness } = require('./match-harness.cjs');

const REPO_ROOT = path.join(__dirname, '..', '..');

// ── Config ────────────────────────────────────────────────────────────────────

const RUN_NOW    = process.argv.includes('--now');
const RUN_DISCOVERY_NOW = process.argv.includes('--discovery');
const STATUS     = process.argv.includes('--status');
const BATCH_OVERRIDE = parseInt(
  process.argv.find(a => a.startsWith('--batch'))?.split('=')[1]
  || (process.argv.indexOf('--batch') > -1
      ? process.argv[process.argv.indexOf('--batch') + 1]
      : '0')
) || 0;

// Cron expressions — Eastern Time
// '0 7 * * 1-5'  = 7:00 AM Monday–Friday
// '0 14 * * 1-5' = 2:00 PM Monday–Friday
const MORNING_CRON   = '0 7  * * 1-5';
const AFTERNOON_CRON = '0 14 * * 1-5';

// Match harness runs 30 min after each scrape, mirroring index.js's dork-search offset pattern
const MATCH_MORNING_CRON   = '30 7  * * 1-5';
const MATCH_AFTERNOON_CRON = '30 14 * * 1-5';

// New-company discovery — Sunday 9pm ET. Weekly (not daily) because company
// signals don't turn over as fast as job postings, which keeps Serper/
// Firecrawl cost down. Deliberately clear of the weekday 7/7:30/14/14:30 ET
// slots above so this never competes with those jobs for the same Anthropic
// account's rate-limit budget at the same time — that's the real efficiency
// gain here, not "off-peak" in the traditional low-server-load sense (the
// Anthropic API's own rate limits are tier-based, not time-of-day based).
const DISCOVERY_CRON = '0 21 * * 0';

const TIMEZONE       = 'America/New_York';

// ── Run wrapper ───────────────────────────────────────────────────────────────

let isRunning = false;

async function runWithGuard(label) {
  if (isRunning) {
    console.log(`[neon-scheduler] ${label} — skipped, previous run still in progress`);
    return;
  }

  isRunning = true;
  console.log(`\n[neon-scheduler] Starting ${label} run — ${new Date().toLocaleString('en-US', { timeZone: TIMEZONE })} ET`);

  try {
    // If BATCH_OVERRIDE set on CLI, pass it via env so direct-scraper picks it up
    if (BATCH_OVERRIDE) process.env.NEON_BATCH_OVERRIDE = String(BATCH_OVERRIDE);
    await run();
  } catch (err) {
    console.error(`[neon-scheduler] ${label} run failed:`, err.message);
  } finally {
    isRunning = false;
    delete process.env.NEON_BATCH_OVERRIDE;
    console.log(`[neon-scheduler] ${label} run complete — ${new Date().toLocaleString('en-US', { timeZone: TIMEZONE })} ET\n`);
  }
}

let isMatchRunning = false;

async function runMatchWithGuard(label) {
  if (isMatchRunning) {
    console.log(`[neon-scheduler] ${label} — skipped, previous match run still in progress`);
    return;
  }

  isMatchRunning = true;
  console.log(`\n[neon-scheduler] Starting ${label} — ${new Date().toLocaleString('en-US', { timeZone: TIMEZONE })} ET`);

  try {
    await runMatchHarness();
  } catch (err) {
    console.error(`[neon-scheduler] ${label} failed:`, err.message);
  } finally {
    isMatchRunning = false;
    console.log(`[neon-scheduler] ${label} complete — ${new Date().toLocaleString('en-US', { timeZone: TIMEZONE })} ET\n`);
  }
}

let isDiscoveryRunning = false;

// Each discovery script runs as its own child process (not required
// in-process like direct-scraper.cjs/match-harness.cjs above) because all
// three call process.exit() on error — in-process that would kill this
// whole long-running scheduler daemon, not just the one failed script.
async function runDiscoveryScript(scriptName) {
  const scriptPath = path.join(REPO_ROOT, scriptName);
  try {
    const { stdout } = await execFileAsync('node', [scriptPath], { cwd: REPO_ROOT, maxBuffer: 1024 * 1024 * 20 });
    console.log(`[neon-scheduler] ${scriptName}:\n${stdout}`);
  } catch (err) {
    console.error(`[neon-scheduler] ${scriptName} failed: ${err.message}`);
    if (err.stdout) console.log(`[neon-scheduler] ${scriptName} stdout before failure:\n${err.stdout}`);
  }
}

async function runDiscoveryWithGuard(label) {
  if (isDiscoveryRunning) {
    console.log(`[neon-scheduler] ${label} — skipped, previous discovery run still in progress`);
    return;
  }

  isDiscoveryRunning = true;
  console.log(`\n[neon-scheduler] Starting ${label} — ${new Date().toLocaleString('en-US', { timeZone: TIMEZONE })} ET`);

  try {
    // Sequential, not parallel: enrich-careers-url.cjs depends on whatever
    // discover-press-releases.cjs just inserted (null careers_url rows), and
    // running one at a time keeps Anthropic/Serper/Firecrawl load spread out
    // rather than tripling up on rate-limit usage at once. A failure in any
    // one script (caught inside runDiscoveryScript) doesn't stop the next
    // from running — each already writes its own results incrementally, so
    // there's nothing to lose by continuing.
    await runDiscoveryScript('discover-companies.cjs');
    await runDiscoveryScript('discover-press-releases.cjs');
    await runDiscoveryScript('enrich-careers-url.cjs');
  } finally {
    isDiscoveryRunning = false;
    console.log(`[neon-scheduler] ${label} complete — ${new Date().toLocaleString('en-US', { timeZone: TIMEZONE })} ET\n`);
  }
}

// ── Status mode ───────────────────────────────────────────────────────────────

function showStatus() {
  const now = new Date();
  console.log('\nNeon Scheduler Status');
  console.log('═'.repeat(40));
  console.log(`Current time : ${now.toLocaleString('en-US', { timeZone: TIMEZONE })} ET`);
  console.log(`Morning cron : ${MORNING_CRON}   (7:00 AM ET, Mon–Fri)`);
  console.log(`Afternoon    : ${AFTERNOON_CRON}  (2:00 PM ET, Mon–Fri)`);
  console.log(`Batch size   : ${BATCH_OVERRIDE || 50} companies per run`);
  console.log(`Scraper      : src/backend/direct-scraper.cjs`);
  console.log(`Match cron   : ${MATCH_MORNING_CRON} / ${MATCH_AFTERNOON_CRON}  (30 min after each scrape)`);
  console.log(`Match harness: src/backend/match-harness.cjs`);
  console.log(`Discovery    : ${DISCOVERY_CRON}  (Sunday 9:00 PM ET, weekly)`);
  console.log(`Discovery run: discover-companies.cjs -> discover-press-releases.cjs -> enrich-careers-url.cjs`);
  console.log('═'.repeat(40) + '\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

if (STATUS) {
  showStatus();
  process.exit(0);
}

if (RUN_NOW) {
  // Run once immediately and exit
  runWithGuard('manual --now').then(() => process.exit(0));

} else if (RUN_DISCOVERY_NOW) {
  // Run the discovery pipeline once immediately and exit
  runDiscoveryWithGuard('manual --discovery').then(() => process.exit(0));

} else {
  // Start scheduler
  showStatus();
  console.log('Scheduler starting. Press Ctrl+C to stop.\n');

  const morningTask = cron.schedule(MORNING_CRON, () => {
    runWithGuard('morning (7:00 AM ET)');
  }, { timezone: TIMEZONE });

  const afternoonTask = cron.schedule(AFTERNOON_CRON, () => {
    runWithGuard('afternoon (2:00 PM ET)');
  }, { timezone: TIMEZONE });

  const matchMorningTask = cron.schedule(MATCH_MORNING_CRON, () => {
    runMatchWithGuard('match harness — morning (7:30 AM ET)');
  }, { timezone: TIMEZONE });

  const matchAfternoonTask = cron.schedule(MATCH_AFTERNOON_CRON, () => {
    runMatchWithGuard('match harness — afternoon (2:30 PM ET)');
  }, { timezone: TIMEZONE });

  const discoveryTask = cron.schedule(DISCOVERY_CRON, () => {
    runDiscoveryWithGuard('company discovery (Sunday 9:00 PM ET)');
  }, { timezone: TIMEZONE });

  console.log('✅ Scheduled:');
  console.log('   7:00 AM ET  Mon–Fri  (morning scrape batch)');
  console.log('   2:00 PM ET  Mon–Fri  (afternoon scrape batch)');
  console.log('   7:30 AM ET  Mon–Fri  (morning match harness)');
  console.log('   2:30 PM ET  Mon–Fri  (afternoon match harness)');
  console.log('   9:00 PM ET  Sunday   (company discovery: career pages + press releases + careers-url enrichment)\n');

  // Graceful shutdown
  const stopAll = () => { morningTask.stop(); afternoonTask.stop(); matchMorningTask.stop(); matchAfternoonTask.stop(); discoveryTask.stop(); };
  process.on('SIGINT',  () => { stopAll(); console.log('\nScheduler stopped.'); process.exit(0); });
  process.on('SIGTERM', () => { stopAll(); process.exit(0); });
}

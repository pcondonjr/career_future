/**
 * src/backend/direct-scraper.cjs
 *
 * Orchestrator for the Neon-backed career site scraper.
 * Queries companies from Neon, runs Cheerio scraper, triages with Haiku,
 * writes results back to Neon. No Firecrawl. No job boards.
 *
 * Usage:
 *   node src/backend/direct-scraper.cjs              -- runs batch of 50
 *   node src/backend/direct-scraper.cjs --batch 20   -- smaller batch
 *   node src/backend/direct-scraper.cjs --dry-run    -- scrape but don't write to DB
 *   node src/backend/direct-scraper.cjs --company "ACS Technologies"  -- single company
 *
 * Called by: src/backend/neon-scheduler.cjs (cron)
 * Or run manually any time.
 */

'use strict';

require('dotenv').config();
const { Pool }          = require('pg');
const { scrapeCompany } = require('./cheerio-scraper.cjs');
const { triageBatch }   = require('./triage.cjs');

// ── Config ────────────────────────────────────────────────────────────────────

const BATCH_SIZE   = parseInt(process.argv.find(a => a.startsWith('--batch'))
                       ?.split('=')[1]
                     || (process.argv.indexOf('--batch') > -1
                         ? process.argv[process.argv.indexOf('--batch') + 1]
                         : '50')) || 50;

const DRY_RUN      = process.argv.includes('--dry-run');
const SINGLE_CO_IDX = process.argv.indexOf('--company');
const SINGLE_CO    = SINGLE_CO_IDX > -1 ? process.argv[SINGLE_CO_IDX + 1] : null;
const SCRAPE_CONCURRENCY  = 3;   // parallel Cheerio fetches
const TRIAGE_CONCURRENCY  = 5;   // parallel Haiku calls

const pool = new Pool({
  connectionString: process.env.CAREER_NEON_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ── URL helpers ───────────────────────────────────────────────────────────────

/**
 * Resolve relative URLs that don't start with '/' (e.g. job-detail.php?link=13)
 * These were missed by the Cheerio scraper's basic resolver.
 */
function resolveJobUrl(href, careersUrl) {
  if (!href) return '';
  if (href.startsWith('http://') || href.startsWith('https://')) return href;

  try {
    const base = new URL(careersUrl);
    if (href.startsWith('/')) {
      return `${base.protocol}//${base.host}${href}`;
    }
    // Relative path — resolve against the careers page directory
    const basePath = base.pathname.endsWith('/')
      ? base.pathname
      : base.pathname.slice(0, base.pathname.lastIndexOf('/') + 1);
    return `${base.protocol}//${base.host}${basePath}${href}`;
  } catch (_) {
    return href;
  }
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async function getCompaniesToScrape(client) {
  if (SINGLE_CO) {
    const { rows } = await client.query(
      `SELECT * FROM companies WHERE company_name ILIKE $1 LIMIT 1`,
      [SINGLE_CO]
    );
    return rows;
  }

  const { rows } = await client.query(`
    SELECT *
    FROM companies
    WHERE scrape_status = 'active'
      AND enabled = true
    ORDER BY last_scraped ASC NULLS FIRST
    LIMIT $1
  `, [BATCH_SIZE]);

  return rows;
}

async function markAtsBlocked(client, company, atsPlatform, reason) {
  if (DRY_RUN) return;

  await client.query(`
    UPDATE companies
    SET scrape_status = 'ats_blocked',
        ats_platform  = $2,
        last_scraped  = NOW(),
        updated_at    = NOW()
    WHERE company_name = $1
  `, [company.company_name, atsPlatform]);

  await client.query(`
    INSERT INTO ats_blocked (company_name, careers_url, ats_platform, source)
    VALUES ($1, $2, $3, 'auto_detected')
    ON CONFLICT (company_name) DO NOTHING
  `, [company.company_name, company.careers_url, atsPlatform]);
}

async function markScrapeComplete(client, company, status, jobCount) {
  if (DRY_RUN) return;

  await client.query(`
    UPDATE companies
    SET last_scraped   = NOW(),
        last_job_found = CASE WHEN $3 > 0 THEN NOW() ELSE last_job_found END,
        scrape_status  = CASE
          WHEN $2 = 'js_required' THEN 'js_required'
          WHEN $2 = 'no_careers'  THEN 'no_careers'
          ELSE scrape_status
        END,
        updated_at     = NOW()
    WHERE company_name = $1
  `, [company.company_name, status, jobCount]);
}

async function saveJobPostings(client, company, triageResults) {
  if (DRY_RUN) return 0;

  let saved = 0;
  for (const job of triageResults) {
    const resolvedUrl = resolveJobUrl(job.url, company.careers_url);

    await client.query(`
      INSERT INTO job_postings (
        company_name, job_title, location, job_url,
        triage_result, triage_reason, first_seen, last_seen
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
      ON CONFLICT (company_name, job_url) DO UPDATE SET
        last_seen      = NOW(),
        triage_result  = EXCLUDED.triage_result,
        triage_reason  = EXCLUDED.triage_reason
    `, [
      company.company_name,
      job.title,
      job.location,
      resolvedUrl,
      job.relevant ? 'yes' : 'no',
      job.reason,
    ]);
    saved++;
  }
  return saved;
}

// ── Run summary ───────────────────────────────────────────────────────────────

function printSummary(stats, elapsed) {
  const mins = Math.floor(elapsed / 60000);
  const secs = Math.floor((elapsed % 60000) / 1000);

  console.log('\n' + '═'.repeat(55));
  console.log('  Direct Scraper Run Complete');
  console.log('═'.repeat(55));
  console.log(`  Companies attempted : ${stats.attempted}`);
  console.log(`  OK (jobs found)     : ${stats.ok_with_jobs}`);
  console.log(`  OK (no openings)    : ${stats.ok_empty}`);
  console.log(`  ATS blocked (new)   : ${stats.ats_blocked}`);
  console.log(`  JS required         : ${stats.js_required}`);
  console.log(`  Dead URLs           : ${stats.no_careers}`);
  console.log(`  Errors              : ${stats.errors}`);
  console.log('─'.repeat(55));
  console.log(`  Jobs scraped        : ${stats.jobs_scraped}`);
  console.log(`  Jobs YES (relevant) : ${stats.jobs_relevant}`);
  console.log(`  Jobs NO (filtered)  : ${stats.jobs_filtered}`);
  console.log(`  Jobs saved to DB    : ${stats.jobs_saved}`);
  console.log('─'.repeat(55));
  console.log(`  Elapsed             : ${mins}m ${secs}s`);
  if (DRY_RUN) console.log('  ⚠️  DRY RUN — nothing written to DB');
  console.log('═'.repeat(55) + '\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  const startTime = Date.now();

  console.log('\n' + '═'.repeat(55));
  console.log('  Career Future — Direct Scraper');
  console.log(`  ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET`);
  if (DRY_RUN)   console.log('  MODE: DRY RUN');
  if (SINGLE_CO) console.log(`  MODE: Single company — "${SINGLE_CO}"`);
  else           console.log(`  MODE: Batch of ${BATCH_SIZE}`);
  console.log('═'.repeat(55) + '\n');

  const stats = {
    attempted: 0, ok_with_jobs: 0, ok_empty: 0,
    ats_blocked: 0, js_required: 0, no_careers: 0, errors: 0,
    jobs_scraped: 0, jobs_relevant: 0, jobs_filtered: 0, jobs_saved: 0,
  };

  const client = await pool.connect();

  try {
    const companies = await getCompaniesToScrape(client);

    if (companies.length === 0) {
      console.log('No companies to scrape. All active companies have been recently scraped,');
      console.log('or there are no active companies in the DB.\n');
      console.log('Check scrape_status distribution:');
      const { rows } = await client.query(`
        SELECT scrape_status, COUNT(*) as count
        FROM companies GROUP BY scrape_status ORDER BY count DESC
      `);
      rows.forEach(r => console.log(`  ${r.scrape_status.padEnd(20)} ${r.count}`));
      return;
    }

    console.log(`Scraping ${companies.length} companies...\n`);

    // ── Scrape in concurrent batches ──────────────────────────────────────────
    for (let i = 0; i < companies.length; i += SCRAPE_CONCURRENCY) {
      const chunk = companies.slice(i, i + SCRAPE_CONCURRENCY);

      const results = await Promise.all(chunk.map(company => scrapeCompany(company)));

      for (let j = 0; j < chunk.length; j++) {
        const company = chunk[j];
        const result  = results[j];
        stats.attempted++;

        const prefix = `[${stats.attempted}/${companies.length}] ${company.company_name}`;

        // ── Handle each status ────────────────────────────────────────────────
        if (result.status === 'ats_blocked') {
          console.log(`  ${prefix} → ats_blocked (${result.ats_platform})`);
          await markAtsBlocked(client, company, result.ats_platform, result.reason);
          stats.ats_blocked++;
          continue;
        }

        if (result.status === 'error') {
          console.log(`  ${prefix} → error: ${result.reason}`);
          await markScrapeComplete(client, company, 'error', 0);
          stats.errors++;
          continue;
        }

        if (result.status === 'no_careers') {
          console.log(`  ${prefix} → no_careers: ${result.reason}`);
          await markScrapeComplete(client, company, 'no_careers', 0);
          stats.no_careers++;
          continue;
        }

        if (result.status === 'js_required') {
          console.log(`  ${prefix} → js_required (will need Puppeteer)`);
          await markScrapeComplete(client, company, 'js_required', 0);
          stats.js_required++;
          continue;
        }

        // status === 'ok'
        if (result.jobs.length === 0) {
          console.log(`  ${prefix} → ok, no openings`);
          await markScrapeComplete(client, company, 'ok', 0);
          stats.ok_empty++;
          continue;
        }

        console.log(`  ${prefix} → ok, ${result.jobs.length} jobs found — triaging...`);
        stats.jobs_scraped += result.jobs.length;

        // ── Triage ────────────────────────────────────────────────────────────
        const triageResults = await triageBatch(result.jobs, {
          concurrency: TRIAGE_CONCURRENCY,
        });

        const relevant = triageResults.filter(j => j.relevant);
        const filtered = triageResults.filter(j => !j.relevant);
        stats.jobs_relevant += relevant.length;
        stats.jobs_filtered += filtered.length;

        if (relevant.length > 0) {
          console.log(`    ✅ ${relevant.length} relevant:`);
          relevant.forEach(j =>
            console.log(`       • ${j.title} | ${j.location}`)
          );
        }
        if (filtered.length > 0) {
          console.log(`    ⬜ ${filtered.length} filtered out`);
        }

        // ── Save to DB ────────────────────────────────────────────────────────
        const saved = await saveJobPostings(client, company, triageResults);
        stats.jobs_saved += saved;
        await markScrapeComplete(client, company, 'ok', relevant.length);
        stats.ok_with_jobs++;
      }
    }

  } finally {
    client.release();
    await pool.end();
    printSummary(stats, Date.now() - startTime);

    // Write last_run.json to match existing project pattern
    if (!DRY_RUN) {
      const fs = require('fs');
      const runData = {
        timestamp:    new Date().toISOString(),
        ...stats,
        elapsed_ms:   Date.now() - startTime,
      };
      fs.writeFileSync(
        require('path').join(__dirname, '..', '..', 'last_run_direct.json'),
        JSON.stringify(runData, null, 2)
      );
    }
  }
}

// Export for use by scheduler
module.exports = { run };

// Run directly if called from CLI
if (require.main === module) {
  run().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}

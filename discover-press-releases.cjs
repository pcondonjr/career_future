/**
 * discover-press-releases.cjs
 *
 * A second, earlier-signal discovery worker alongside discover-companies.cjs.
 * Instead of finding companies already showing Salesforce hiring signals,
 * this one finds companies BEFORE they hire — via economic-development
 * press releases ("X Corp announces 200 new jobs in Greenville County").
 * Confirmed new/expanding companies go into the same Neon `companies` table
 * as scrape_status='pending_review', so direct-scraper.cjs starts watching
 * their career page from day one.
 *
 * Pipeline (mirrors discover-companies.cjs, shares its helpers):
 *   1. Serper queries targeting county economic-development announcements
 *   2. Firecrawl renders each candidate article
 *   3. Claude Haiku validates: is this a genuine new/expanding company (not
 *      generic county news)? Deliberately does NOT ask about Salesforce
 *      relevance — that's unknowable from a press release and is instead
 *      left to the normal triage.cjs step once/if the company posts a job.
 *   4. Confirmed companies inserted into Neon as scrape_status='pending_review'
 *
 * Shares the discovery_seen ledger with discover-companies.cjs — a domain
 * either worker has already checked recently won't get re-scraped by the
 * other one either.
 *
 * Usage:
 *   node discover-press-releases.cjs                # run all query groups
 *   node discover-press-releases.cjs --dry-run       # preview only, no DB writes
 *   node discover-press-releases.cjs --sample 5      # stop after 5 validated inserts
 *   node discover-press-releases.cjs --queries 2     # use first N query groups only
 *   node discover-press-releases.cjs --rescan-days 30 # re-check domains older than N days (default 30)
 *   node discover-press-releases.cjs --no-email      # skip the end-of-run digest email
 *
 * Env: CAREER_NEON_URL (or DATABASE_URL), SERPER_API_KEY, FIRECRAWL_API_KEY, ANTHROPIC_API_KEY
 */

'use strict';

require('dotenv').config();
const { Pool }      = require('pg');
const { Firecrawl } = require('@mendable/firecrawl-js');
const Anthropic     = require('@anthropic-ai/sdk');
const {
  EST_STATES, sleep, extractDomain, searchSerper, scrapeWithFirecrawl,
  loadExistingNames, loadExistingDomains, loadSeenDomains, markDomainSeen, insertCompany,
  sendDigestEmail,
} = require('./src/backend/discovery-shared.cjs');

// ─── CLI args ────────────────────────────────────────────────────────────────

function getArg(name) {
  const eq  = process.argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=')[1];
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return null;
}

const DRY_RUN     = process.argv.includes('--dry-run');
const NO_EMAIL    = process.argv.includes('--no-email');
const SAMPLE      = parseInt(getArg('sample')  || '0') || 0;
const MAX_QUERIES = parseInt(getArg('queries') || '0') || 0;
const RESCAN_DAYS = parseInt(getArg('rescan-days') || '0') || 30;

const DELAY_MS           = 2500;  // between Firecrawl calls
const SERPER_DELAY_MS    = 1500;  // between Serper pages
const MAX_MARKDOWN_CHARS = 8000;
const HAIKU_MODEL        = 'claude-haiku-4-5-20251001';

// ─── Discovery query groups — county economic-development announcements ─────
// Target region: Greenville + Spartanburg + Anderson County, SC.

const DISCOVERY_QUERIES = [
  {
    id: 'greenville-ed',
    query: `"Greenville County" (economic development OR EDC) (announces OR "new jobs" OR expansion OR "to create")`,
  },
  {
    id: 'greenville-ed-2',
    query: `"Greenville County" (announces OR "to invest") ("new facility" OR "new jobs" OR relocating OR relocate) South Carolina`,
  },
  {
    id: 'spartanburg-ed',
    query: `"Spartanburg County" (economic development OR EDC) (announces OR "new jobs" OR expansion)`,
  },
  {
    id: 'spartanburg-ed-2',
    query: `"Spartanburg County" (announces OR "to invest") ("new facility" OR "new jobs" OR relocating OR relocate) South Carolina`,
  },
  {
    id: 'anderson-ed',
    query: `"Anderson County" South Carolina (economic development OR EDC) (announces OR expansion OR "new jobs")`,
  },
  {
    id: 'anderson-ed-2',
    query: `"Anderson County" South Carolina (announces OR "to invest") ("new facility" OR relocating OR relocate)`,
  },
];

// ─── Neon DB ─────────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.CAREER_NEON_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Press-release URLs are articles, not career pages — scrape the URL as-is
// (no /careers guess-and-fallback like discover-companies.cjs does).

// ─── Firecrawl / Haiku clients ────────────────────────────────────────────────

const firecrawl = new Firecrawl({ apiKey: process.env.FIRECRAWL_API_KEY });
const claude    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Haiku validation ────────────────────────────────────────────────────────
// Deliberately does NOT ask about Salesforce relevance — unknowable from a
// press release. This worker's only job: is this a real, growing company in
// the target region?

async function validatePressRelease(markdown, sourceUrl) {
  const prompt = `Analyze this news/press-release content and return JSON.

Source URL: ${sourceUrl}

Page content (may be truncated):
${markdown}

Return ONLY valid JSON — no explanation outside the braces:
{
  "company_name": "official company name being written about, or null if unclear",
  "hq_city": "city where the new/expanded facility or office is located, or null",
  "hq_state": "2-letter US state abbreviation (e.g. SC), or null if unknown",
  "is_new_or_expanding": true or false,
  "confidence": "high | medium | low | failed",
  "reason": "one sentence: what the company is doing (opening/expanding/relocating) and where"
}

Rules:
- is_new_or_expanding=true ONLY if this specific article announces a company creating jobs, opening a new facility/office, expanding operations, or relocating into the area. Generic county economic-development news with no specific company named does NOT count.
- hq_state: 2-letter abbreviation only. null if unknown.
- confidence=failed if: page is a login wall, blank, 404, a list/index page with no single article, or completely unrelated content.
- Do NOT infer state from timezone alone — require an explicit city or state mention.`;

  const response = await claude.messages.create({
    model:      HAIKU_MODEL,
    max_tokens: 250,
    messages:   [{ role: 'user', content: prompt }],
  });

  const text = response.content[0]?.text?.trim() || '';

  inputTokensEstimate  += Math.ceil((prompt.length + 100) / 4);
  outputTokensEstimate += Math.ceil(text.length / 4);

  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('no JSON object');
    return JSON.parse(match[0]);
  } catch {
    return {
      company_name: null, hq_city: null, hq_state: null,
      is_new_or_expanding: false, confidence: 'failed',
      reason: `Parse error: ${text.slice(0, 80)}`,
    };
  }
}

// ─── Cost tracking ────────────────────────────────────────────────────────────

let inputTokensEstimate  = 0;
let outputTokensEstimate = 0;

function printCostEstimate() {
  const haiku = (inputTokensEstimate / 1e6) * 0.80 + (outputTokensEstimate / 1e6) * 4.00;
  const serperCalls = Math.min(DISCOVERY_QUERIES.length, MAX_QUERIES || DISCOVERY_QUERIES.length) * 2;
  const serper = (serperCalls / 1000) * 50;
  console.log(`\n  Estimated cost:`);
  console.log(`    Haiku   ~$${haiku.toFixed(4)}  (${inputTokensEstimate.toLocaleString()} in / ${outputTokensEstimate.toLocaleString()} out tokens)`);
  console.log(`    Serper  ~$${serper.toFixed(4)}  (${serperCalls} API calls)`);
  console.log(`    Firecrawl — depends on subscription plan`);
  return { haiku, serper };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const missing = ['SERPER_API_KEY', 'FIRECRAWL_API_KEY', 'ANTHROPIC_API_KEY'].filter(k => !process.env[k]);
  if (missing.length) { console.error(`\nMissing env vars: ${missing.join(', ')}\n`); process.exit(1); }
  if (!process.env.CAREER_NEON_URL && !process.env.DATABASE_URL) {
    console.error('\nMissing CAREER_NEON_URL or DATABASE_URL\n'); process.exit(1);
  }

  const queries = MAX_QUERIES ? DISCOVERY_QUERIES.slice(0, MAX_QUERIES) : DISCOVERY_QUERIES;

  console.log(`\n${'='.repeat(55)}`);
  console.log(`Press-Release Discovery  —  Serper → Firecrawl → Haiku → Neon`);
  console.log(`${'='.repeat(55)}`);
  console.log(`Mode:    ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}`);
  console.log(`Sample:  ${SAMPLE || 'unlimited'} inserts`);
  console.log(`Queries: ${queries.length} of ${DISCOVERY_QUERIES.length}\n`);

  const existingNames   = await loadExistingNames(pool);
  const existingDomains = await loadExistingDomains(pool);
  const discoverySeen   = await loadSeenDomains(pool, RESCAN_DAYS);
  console.log(`Existing DB: ${existingNames.size} companies, ${existingDomains.size} unique domains`);
  console.log(`Discovery ledger: ${discoverySeen.size} domains checked within the last ${RESCAN_DAYS} days\n`);

  const seenDomains = new Set(existingDomains);

  // ── Phase 1: Serper — collect candidate articles ──────────────────────────

  console.log(`${'─'.repeat(55)}`);
  console.log(`Phase 1: Serper search (${queries.length} queries)`);
  console.log(`${'─'.repeat(55)}\n`);

  const candidates = []; // { link, domain, queryId, snippet }
  let totalLedgerSkipped = 0;

  for (const q of queries) {
    console.log(`[${q.id}]`);
    const results = await searchSerper(q.query, process.env.SERPER_API_KEY, { delayMs: SERPER_DELAY_MS });
    console.log(`  ${results.length} results from Serper`);

    let added = 0, ledgerSkipped = 0;

    for (const item of results) {
      const link = item.link;
      if (!link) continue;

      const domain = extractDomain(link);
      if (!domain || seenDomains.has(domain)) continue;

      if (discoverySeen.has(domain)) { ledgerSkipped++; continue; }

      seenDomains.add(domain);
      candidates.push({ link, domain, queryId: q.id, snippet: item.snippet || '' });
      added++;
    }

    totalLedgerSkipped += ledgerSkipped;
    console.log(`  → ${added} new candidate articles (${ledgerSkipped} already checked recently)`);
    await sleep(SERPER_DELAY_MS);
  }

  console.log(`\n${candidates.length} total candidates to validate\n`);

  // ── Phase 2: Firecrawl + Haiku — validate each candidate ─────────────────

  console.log(`${'─'.repeat(55)}`);
  console.log(`Phase 2: Validate via Firecrawl + Haiku`);
  console.log(`${'─'.repeat(55)}\n`);

  let inserted = 0, skippedNotEST = 0, skippedNotExpanding = 0, scrapeFailures = 0, parseFailures = 0, apiFailures = 0;
  const insertedNames = [];

  for (const { link, domain, queryId } of candidates) {
    if (SAMPLE && inserted >= SAMPLE) {
      console.log(`\nSample limit reached (${SAMPLE} inserts). Stopping.`);
      break;
    }

    console.log(`\n[${domain}]  (${queryId})`);
    console.log(`  Scraping: ${link}`);

    let markdown;
    try {
      markdown = await scrapeWithFirecrawl(firecrawl, link, MAX_MARKDOWN_CHARS);
    } catch (err) {
      console.log(`  SKIP (scrape failed): ${err.message.slice(0, 70)}`);
      scrapeFailures++;
      await markDomainSeen(pool, domain, 'rejected_scrape_failed', err.message.slice(0, 200), DRY_RUN);
      await sleep(DELAY_MS);
      continue;
    }

    // A single candidate's API failure must not kill the whole run —
    // everything already written stays written; skip this one and continue.
    let result;
    try {
      result = await validatePressRelease(markdown, link);
    } catch (err) {
      console.log(`  SKIP (Haiku call failed): ${err.message.slice(0, 100)}`);
      apiFailures++;
      await markDomainSeen(pool, domain, 'rejected_api_error', err.message.slice(0, 200), DRY_RUN);
      await sleep(DELAY_MS);
      continue;
    }

    const stateLabel = result.hq_state || '?';
    const expLabel    = result.is_new_or_expanding ? 'NEW/EXPANDING✓' : 'NOT-EXPANDING✗';
    console.log(`  → ${result.company_name || 'unknown'} | ${result.hq_city || '?'}, ${stateLabel} | ${expLabel} | ${result.confidence}`);
    console.log(`    ${result.reason}`);

    if (result.confidence === 'failed') {
      parseFailures++;
      await markDomainSeen(pool, domain, 'rejected_parse_failed', result.reason, DRY_RUN);
      await sleep(DELAY_MS);
      continue;
    }

    if (!result.is_new_or_expanding) {
      skippedNotExpanding++;
      await markDomainSeen(pool, domain, 'rejected_not_new_expansion', result.reason, DRY_RUN);
      await sleep(DELAY_MS);
      continue;
    }

    if (!result.hq_state || !EST_STATES.has(result.hq_state.toLowerCase())) {
      console.log(`  SKIP (not EST: ${stateLabel})`);
      skippedNotEST++;
      await markDomainSeen(pool, domain, 'rejected_not_est', `hq_state=${stateLabel}`, DRY_RUN);
      await sleep(DELAY_MS);
      continue;
    }

    if (!result.company_name) {
      console.log(`  SKIP (company name unknown)`);
      parseFailures++;
      await markDomainSeen(pool, domain, 'rejected_parse_failed', 'company name unknown', DRY_RUN);
      await sleep(DELAY_MS);
      continue;
    }

    if (existingNames.has(result.company_name.toLowerCase())) {
      console.log(`  SKIP (already in DB as "${result.company_name}")`);
      await markDomainSeen(pool, domain, 'rejected_duplicate_name', `matches existing "${result.company_name}"`, DRY_RUN);
      await sleep(DELAY_MS);
      continue;
    }

    // No careers_url yet — press release doesn't give us one. direct-scraper.cjs
    // / a future enrichment pass can fill it in once promoted from pending_review.
    const ok = await insertCompany(pool, {
      company_name: result.company_name,
      careers_url:  null,
      hq_city:      result.hq_city,
      hq_state:     result.hq_state,
      source:       'press_release_discovery',
      sourceLabel:  `Press release: ${link}`,
      dryRun:       DRY_RUN,
    });

    if (ok) {
      console.log(`  ✅ ADDED: ${result.company_name} (${result.hq_city || '?'}, ${result.hq_state})`);
      existingNames.add(result.company_name.toLowerCase());
      insertedNames.push(result.company_name);
      inserted++;
      await markDomainSeen(pool, domain, 'inserted', result.company_name, DRY_RUN);
    } else {
      console.log(`  ⚠️  Duplicate (ON CONFLICT DO NOTHING)`);
      await markDomainSeen(pool, domain, 'rejected_duplicate_name', `ON CONFLICT: "${result.company_name}"`, DRY_RUN);
    }

    await sleep(DELAY_MS);
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log(`\n${'='.repeat(55)}`);
  console.log(`Discovery complete`);
  console.log(`  Candidates from Serper:     ${candidates.length}`);
  console.log(`  Added to Neon:              ${inserted}${DRY_RUN ? '  (DRY RUN — nothing written)' : ''}`);
  console.log(`  Skipped (not EST):          ${skippedNotEST}`);
  console.log(`  Skipped (not expanding):    ${skippedNotExpanding}`);
  console.log(`  Scrape failures:            ${scrapeFailures}`);
  console.log(`  Parse/confidence fails:     ${parseFailures}`);
  console.log(`  API call failures:          ${apiFailures}`);
  console.log(`  Skipped (seen <${RESCAN_DAYS}d ago):    ${totalLedgerSkipped}`);
  const cost = printCostEstimate();
  console.log(`${'='.repeat(55)}\n`);

  if (!DRY_RUN && !NO_EMAIL) {
    const lines = [
      `Press-Release Discovery — ${new Date().toLocaleString()}`,
      '',
      `TRIED: ${queries.length} query group(s), ${candidates.length} candidates from Serper, ${totalLedgerSkipped} skipped as already-checked.`,
      '',
      `ACCOMPLISHED: ${inserted} companies added${insertedNames.length ? ':' : '.'}`,
      ...insertedNames.map(n => `  - ${n}`),
      '',
      'MISSED (rejection breakdown):',
      `  - Not EST:              ${skippedNotEST}`,
      `  - Not new/expanding:    ${skippedNotExpanding}`,
      `  - Scrape failures:      ${scrapeFailures}`,
      `  - Parse/confidence:     ${parseFailures}`,
      `  - API call failures:    ${apiFailures}`,
      '',
      `Est. cost: Haiku ~$${cost.haiku.toFixed(4)}, Serper ~$${cost.serper.toFixed(4)}`,
    ];
    await sendDigestEmail(`Press-Release Discovery: ${inserted} added, ${candidates.length} checked`, lines);
  }

  await pool.end();
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});

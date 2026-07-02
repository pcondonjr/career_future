/**
 * discover-companies.cjs
 *
 * Discovers new companies likely to hire Salesforce talent by:
 *   1. Running Serper queries targeting company-owned career pages (no ATS)
 *   2. Using Firecrawl to render each candidate page
 *   3. Using Claude Haiku to validate: EST timezone + Salesforce relevance
 *   4. Inserting confirmed companies into Neon as scrape_status='pending_review'
 *
 * Intentionally skips ATS-hosted boards (Greenhouse, Lever, Workday, etc.) —
 * the goal is "hidden" postings on company-owned career pages only.
 *
 * Usage:
 *   node discover-companies.cjs              # run all 8 query groups
 *   node discover-companies.cjs --dry-run    # preview only, no DB writes
 *   node discover-companies.cjs --sample 5  # stop after 5 validated inserts
 *   node discover-companies.cjs --queries 3 # use first N query groups only
 *
 * Env: CAREER_NEON_URL (or DATABASE_URL), SERPER_API_KEY, FIRECRAWL_API_KEY, ANTHROPIC_API_KEY
 */

'use strict';

require('dotenv').config();
const { Pool }      = require('pg');
const { Firecrawl } = require('@mendable/firecrawl-js');
const Anthropic     = require('@anthropic-ai/sdk');
const { BLOCKED_DOMAINS } = require('./src/backend/blocked-domains.cjs');

// ─── CLI args ────────────────────────────────────────────────────────────────

function getArg(name) {
  const eq  = process.argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=')[1];
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return null;
}

const DRY_RUN    = process.argv.includes('--dry-run');
const SAMPLE     = parseInt(getArg('sample')  || '0') || 0;
const MAX_QUERIES = parseInt(getArg('queries') || '0') || 0;

const DELAY_MS           = 2500;  // between Firecrawl calls
const SERPER_DELAY_MS    = 1500;  // between Serper pages
const MAX_MARKDOWN_CHARS = 8000;
const HAIKU_MODEL        = 'claude-haiku-4-5-20251001';
const SERPER_API         = 'https://google.serper.dev/search';

// ─── EST States ──────────────────────────────────────────────────────────────

const EST_STATES = new Set([
  'ct', 'connecticut',
  'dc', 'district of columbia',
  'de', 'delaware',
  'fl', 'florida',
  'ga', 'georgia',
  'in', 'indiana',
  'ky', 'kentucky',
  'ma', 'massachusetts',
  'md', 'maryland',
  'me', 'maine',
  'mi', 'michigan',
  'nc', 'north carolina',
  'nh', 'new hampshire',
  'nj', 'new jersey',
  'ny', 'new york',
  'oh', 'ohio',
  'pa', 'pennsylvania',
  'ri', 'rhode island',
  'sc', 'south carolina',
  'tn', 'tennessee',
  'va', 'virginia',
  'vt', 'vermont',
  'wv', 'west virginia',
]);

// ─── ATS & job board domains to exclude ──────────────────────────────────────

const ATS_DOMAINS = BLOCKED_DOMAINS;

// ─── Discovery query groups ──────────────────────────────────────────────────
// Each query targets company-owned career pages mentioning Salesforce.
// ATS platforms and job boards are excluded inline via -site: operators.
// Serper returns up to 20 results per query (2 pages × 10).

const ATS_EXCL = [
  '-site:greenhouse.io', '-site:lever.co', '-site:workday.com',
  '-site:myworkdayjobs.com', '-site:bamboohr.com', '-site:ashby.com',
  '-site:smartrecruiters.com', '-site:icims.com', '-site:taleo.net',
  '-site:linkedin.com', '-site:indeed.com', '-site:glassdoor.com',
  '-site:ziprecruiter.com', '-site:wellfound.com', '-site:builtin.com',
].join(' ');

const DISCOVERY_QUERIES = [
  // Remote-friendly Salesforce roles on company-owned pages
  {
    id: 'sf-remote',
    query: `"salesforce" inurl:careers "remote" ${ATS_EXCL}`,
  },
  // Southeast EST: NC, SC, GA, TN
  {
    id: 'sf-southeast',
    query: `"salesforce" careers ("North Carolina" OR "South Carolina" OR "Georgia" OR "Tennessee") ${ATS_EXCL}`,
  },
  // Mid-Atlantic: VA, MD, DC, DE
  {
    id: 'sf-midatlantic',
    query: `"salesforce" careers ("Virginia" OR "Maryland" OR "Washington DC" OR "Delaware") ${ATS_EXCL}`,
  },
  // Northeast: PA, NJ, NY, CT
  {
    id: 'sf-northeast',
    query: `"salesforce" careers ("Pennsylvania" OR "New Jersey" OR "New York" OR "Connecticut") ${ATS_EXCL}`,
  },
  // New England: MA, RI, NH, VT, ME
  {
    id: 'sf-newengland',
    query: `"salesforce" careers ("Massachusetts" OR "Rhode Island" OR "New Hampshire" OR "Maine") ${ATS_EXCL}`,
  },
  // Midwest EST: OH, MI, IN, KY
  {
    id: 'sf-midwest',
    query: `"salesforce" careers ("Ohio" OR "Michigan" OR "Indiana" OR "Kentucky") ${ATS_EXCL}`,
  },
  // South EST: FL, WV
  {
    id: 'sf-south',
    query: `"salesforce" careers ("Florida" OR "West Virginia") ${ATS_EXCL}`,
  },
  // Role-specific: admin / BA titles on company pages
  {
    id: 'sf-admin-role',
    query: `"salesforce administrator" OR "salesforce admin" ("open positions" OR "current openings" OR "join our team") ${ATS_EXCL}`,
  },
];

// ─── Neon DB ─────────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.CAREER_NEON_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function ensureHqStateColumn() {
  await pool.query(`ALTER TABLE companies ADD COLUMN IF NOT EXISTS hq_state TEXT`);
}

async function loadExistingNames() {
  const { rows } = await pool.query(`SELECT LOWER(company_name) AS name FROM companies`);
  return new Set(rows.map(r => r.name));
}

async function loadExistingDomains() {
  const { rows } = await pool.query(
    `SELECT careers_url FROM companies WHERE careers_url IS NOT NULL AND careers_url != ''`
  );
  const domains = new Set();
  for (const { careers_url } of rows) {
    const d = extractDomain(careers_url);
    if (d) domains.add(d);
  }
  return domains;
}

async function insertCompany({ company_name, careers_url, hq_city, hq_state, reason }) {
  if (DRY_RUN) return false;
  const noteParts = [hq_city, hq_state, 'Serper discovery'].filter(Boolean);
  const notes = noteParts.join(' - ');
  const { rowCount } = await pool.query(`
    INSERT INTO companies (
      company_name, careers_url, enabled, notes, hq_state,
      source, scrape_status
    ) VALUES ($1, $2, FALSE, $3, $4, 'serper_discovery', 'pending_review')
    ON CONFLICT (company_name) DO NOTHING
  `, [company_name, careers_url, notes, hq_state ? hq_state.toUpperCase() : null]);
  return rowCount > 0;
}

// ─── Serper ──────────────────────────────────────────────────────────────────

async function searchSerper(query) {
  const allItems = [];

  for (const page of [1, 2]) {
    let res, data;
    try {
      res  = await fetch(SERPER_API, {
        method:  'POST',
        headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ q: query, num: 10, page }),
      });
      data = await res.json();
    } catch (err) {
      console.warn(`  ⚠️  Serper network error: ${err.message}`);
      break;
    }

    if (res.status === 429 || data.statusCode === 429) {
      console.warn('  ⚠️  Serper quota exceeded — stopping');
      break;
    }
    if (!res.ok) {
      console.warn(`  ⚠️  Serper error ${res.status}: ${data.message || res.statusText}`);
      break;
    }

    const organic = data.organic || [];
    if (organic.length === 0) break;
    allItems.push(...organic);
    await sleep(SERPER_DELAY_MS);
  }

  return allItems;
}

// ─── URL helpers ─────────────────────────────────────────────────────────────

function extractDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

function isATSDomain(url) {
  const domain = extractDomain(url) || '';
  for (const ats of ATS_DOMAINS) {
    if (domain === ats || domain.endsWith('.' + ats)) return true;
  }
  return false;
}

// Return the best URL to scrape: prefer a /careers or /jobs path.
// If the Serper result URL is already a career page, use it.
// Otherwise construct domain + /careers as a first attempt.
function buildCareersUrl(link) {
  if (/\/(careers|jobs|join-us|work-with-us|openings|opportunities|join|hiring)\b/i.test(link)) {
    return link;
  }
  try {
    const { origin } = new URL(link);
    return origin + '/careers';
  } catch {
    return link;
  }
}

// ─── Firecrawl ───────────────────────────────────────────────────────────────

const firecrawl = new Firecrawl({ apiKey: process.env.FIRECRAWL_API_KEY });

async function scrapeWithFirecrawl(url) {
  const result = await firecrawl.v1.scrapeUrl(url, {
    formats: ['markdown'],
    waitFor: 4000,
    timeout: 25000,
  });
  if (!result.success) throw new Error(result.error || 'Firecrawl returned success=false');
  return (result.markdown || '').slice(0, MAX_MARKDOWN_CHARS);
}

// ─── Haiku validation ────────────────────────────────────────────────────────

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function validateWithHaiku(markdown, sourceUrl) {
  const prompt = `Analyze this content from a company's website and return JSON.

Source URL: ${sourceUrl}

Page content (may be truncated):
${markdown}

Return ONLY valid JSON — no explanation outside the braces:
{
  "company_name": "official company name, or null if unclear",
  "hq_city": "headquarters city, or null",
  "hq_state": "2-letter US state abbreviation (e.g. NC, OH), or null if international or unknown",
  "salesforce_relevant": true or false,
  "confidence": "high | medium | low | failed",
  "reason": "one sentence: where the company is based and why salesforce_relevant is true/false"
}

Rules:
- salesforce_relevant=true if: the page shows Salesforce admin/BA/analyst/consultant job listings, OR mentions Salesforce as part of their tech stack
- hq_state: 2-letter abbreviation only. null if the company is outside the US or location is truly unknown
- confidence=failed if: page is a login wall, blank, 404, or completely unrelated to the company's careers
- Do NOT infer state from timezone alone — require an explicit city or state mention`;

  const response = await claude.messages.create({
    model:      HAIKU_MODEL,
    max_tokens: 250,
    messages:   [{ role: 'user', content: prompt }],
  });

  const text = response.content[0]?.text?.trim() || '';

  // Track tokens for cost estimate
  inputTokensEstimate  += Math.ceil((prompt.length + 100) / 4);
  outputTokensEstimate += Math.ceil(text.length / 4);

  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('no JSON object');
    return JSON.parse(match[0]);
  } catch {
    return {
      company_name: null, hq_city: null, hq_state: null,
      salesforce_relevant: false, confidence: 'failed',
      reason: `Parse error: ${text.slice(0, 80)}`,
    };
  }
}

// ─── Cost tracking ────────────────────────────────────────────────────────────

let inputTokensEstimate  = 0;
let outputTokensEstimate = 0;

function printCostEstimate(candidateCount) {
  const haiku = (inputTokensEstimate / 1e6) * 0.80 + (outputTokensEstimate / 1e6) * 4.00;
  // Serper: $50 / 1000 queries; each query group = 2 pages = 2 Serper calls
  const serperCalls = Math.min(DISCOVERY_QUERIES.length, MAX_QUERIES || DISCOVERY_QUERIES.length) * 2;
  const serper = (serperCalls / 1000) * 50;
  console.log(`\n  Estimated cost:`);
  console.log(`    Haiku   ~$${haiku.toFixed(4)}  (${inputTokensEstimate.toLocaleString()} in / ${outputTokensEstimate.toLocaleString()} out tokens)`);
  console.log(`    Serper  ~$${serper.toFixed(4)}  (${serperCalls} API calls)`);
  console.log(`    Firecrawl — depends on subscription plan`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  // Validate env
  const missing = ['SERPER_API_KEY', 'FIRECRAWL_API_KEY', 'ANTHROPIC_API_KEY'].filter(k => !process.env[k]);
  if (missing.length) { console.error(`\nMissing env vars: ${missing.join(', ')}\n`); process.exit(1); }
  if (!process.env.CAREER_NEON_URL && !process.env.DATABASE_URL) {
    console.error('\nMissing CAREER_NEON_URL or DATABASE_URL\n'); process.exit(1);
  }

  const queries = MAX_QUERIES ? DISCOVERY_QUERIES.slice(0, MAX_QUERIES) : DISCOVERY_QUERIES;

  console.log(`\n${'='.repeat(55)}`);
  console.log(`Company Discovery  —  Serper → Firecrawl → Haiku → Neon`);
  console.log(`${'='.repeat(55)}`);
  console.log(`Mode:    ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}`);
  console.log(`Sample:  ${SAMPLE || 'unlimited'} inserts`);
  console.log(`Queries: ${queries.length} of ${DISCOVERY_QUERIES.length}\n`);

  // Schema: ensure hq_state column exists
  await ensureHqStateColumn();

  // Load existing data to avoid duplicates
  const existingNames   = await loadExistingNames();
  const existingDomains = await loadExistingDomains();
  console.log(`Existing DB: ${existingNames.size} companies, ${existingDomains.size} unique domains\n`);

  // Shared seen-domains set (existing + discovered this run)
  const seenDomains = new Set(existingDomains);

  // ── Phase 1: Serper — collect candidate domains ───────────────────────────

  console.log(`${'─'.repeat(55)}`);
  console.log(`Phase 1: Serper search (${queries.length} queries)`);
  console.log(`${'─'.repeat(55)}\n`);

  const candidates = []; // { link, domain, queryId, snippet }

  for (const q of queries) {
    console.log(`[${q.id}]`);
    const results = await searchSerper(q.query);
    console.log(`  ${results.length} results from Serper`);

    let added = 0, atsSkipped = 0;

    for (const item of results) {
      const link = item.link;
      if (!link) continue;

      if (isATSDomain(link)) { atsSkipped++; continue; }

      const domain = extractDomain(link);
      if (!domain || seenDomains.has(domain)) continue;

      seenDomains.add(domain);
      candidates.push({ link, domain, queryId: q.id, snippet: item.snippet || '' });
      added++;
    }

    console.log(`  → ${added} new candidate domains (${atsSkipped} ATS/board results skipped)`);
    await sleep(SERPER_DELAY_MS);
  }

  console.log(`\n${candidates.length} total candidates to validate\n`);

  // ── Phase 2: Firecrawl + Haiku — validate each candidate ─────────────────

  console.log(`${'─'.repeat(55)}`);
  console.log(`Phase 2: Validate via Firecrawl + Haiku`);
  console.log(`${'─'.repeat(55)}\n`);

  let inserted = 0, skippedNotEST = 0, skippedNotSF = 0, scrapeFailures = 0, parseFailures = 0;

  for (const { link, domain, queryId, snippet } of candidates) {
    if (SAMPLE && inserted >= SAMPLE) {
      console.log(`\nSample limit reached (${SAMPLE} inserts). Stopping.`);
      break;
    }

    const careersUrl = buildCareersUrl(link);
    console.log(`\n[${domain}]  (${queryId})`);
    console.log(`  Scraping: ${careersUrl}`);

    // Scrape with Firecrawl — fall back to original link if /careers 404s
    let markdown;
    try {
      markdown = await scrapeWithFirecrawl(careersUrl);
    } catch (err) {
      if (careersUrl !== link) {
        console.log(`  Fallback to original: ${link}`);
        try {
          markdown = await scrapeWithFirecrawl(link);
        } catch (err2) {
          console.log(`  SKIP (both URLs failed): ${err2.message.slice(0, 70)}`);
          scrapeFailures++;
          await sleep(DELAY_MS);
          continue;
        }
      } else {
        console.log(`  SKIP (scrape failed): ${err.message.slice(0, 70)}`);
        scrapeFailures++;
        await sleep(DELAY_MS);
        continue;
      }
    }

    // Haiku validation
    const result = await validateWithHaiku(markdown, careersUrl);

    const stateLabel = result.hq_state || '?';
    const sfLabel    = result.salesforce_relevant ? 'SF✓' : 'SF✗';
    console.log(`  → ${result.company_name || 'unknown'} | ${result.hq_city || '?'}, ${stateLabel} | ${sfLabel} | ${result.confidence}`);
    console.log(`    ${result.reason}`);

    // Filter checks
    if (result.confidence === 'failed') {
      parseFailures++;
      await sleep(DELAY_MS);
      continue;
    }

    if (!result.salesforce_relevant) {
      skippedNotSF++;
      await sleep(DELAY_MS);
      continue;
    }

    if (!result.hq_state || !EST_STATES.has(result.hq_state.toLowerCase())) {
      console.log(`  SKIP (not EST: ${stateLabel})`);
      skippedNotEST++;
      await sleep(DELAY_MS);
      continue;
    }

    if (!result.company_name) {
      console.log(`  SKIP (company name unknown)`);
      parseFailures++;
      await sleep(DELAY_MS);
      continue;
    }

    // Name dedup (Haiku may have normalized the name differently from the domain)
    if (existingNames.has(result.company_name.toLowerCase())) {
      console.log(`  SKIP (already in DB as "${result.company_name}")`);
      await sleep(DELAY_MS);
      continue;
    }

    // Insert into Neon
    const ok = await insertCompany({
      company_name: result.company_name,
      careers_url:  careersUrl,
      hq_city:      result.hq_city,
      hq_state:     result.hq_state,
      reason:       result.reason,
    });

    if (ok) {
      console.log(`  ✅ ADDED: ${result.company_name} (${result.hq_city || '?'}, ${result.hq_state})`);
      existingNames.add(result.company_name.toLowerCase());
      inserted++;
    } else {
      console.log(`  ⚠️  Duplicate (ON CONFLICT DO NOTHING)`);
    }

    await sleep(DELAY_MS);
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log(`\n${'='.repeat(55)}`);
  console.log(`Discovery complete`);
  console.log(`  Candidates from Serper:  ${candidates.length}`);
  console.log(`  Added to Neon:           ${inserted}${DRY_RUN ? '  (DRY RUN — nothing written)' : ''}`);
  console.log(`  Skipped (not EST):       ${skippedNotEST}`);
  console.log(`  Skipped (no Salesforce): ${skippedNotSF}`);
  console.log(`  Scrape failures:         ${scrapeFailures}`);
  console.log(`  Parse/confidence fails:  ${parseFailures}`);
  printCostEstimate(candidates.length);
  console.log(`${'='.repeat(55)}\n`);

  await pool.end();
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});

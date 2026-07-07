/**
 * enrich-careers-url.cjs
 *
 * Companies found by discover-press-releases.cjs land with careers_url=NULL
 * (a press release doesn't give you one) — direct-scraper.cjs has nothing to
 * scrape until that's filled in. This script closes that gap:
 *
 *   1. For each companies row with careers_url IS NULL, Serper-search
 *      "<company name> careers"
 *   2. Try the top couple of organic results, applying the same
 *      buildCareersUrl heuristic used by discover-companies.cjs
 *   3. Firecrawl-scrape the candidate, Claude Haiku confirms it's genuinely
 *      that company's own site (not a same-named different company, a
 *      directory listing, etc.)
 *   4. On a confirmed match: UPDATE careers_url and promote scrape_status
 *      to 'active' so direct-scraper.cjs starts watching it on the normal
 *      schedule. No match found: leave as pending_review for manual lookup.
 *
 * Unlike discover-companies.cjs, this does NOT exclude ATS-hosted career
 * pages (Greenhouse/Lever/Workday/etc.) — the discovery-vs-hidden-postings
 * filtering already happened upstream; here we just need to know where the
 * company's real careers page lives, wherever that is.
 *
 * Usage:
 *   node enrich-careers-url.cjs              # process all pending, no careers_url
 *   node enrich-careers-url.cjs --dry-run    # preview only, no DB writes
 *   node enrich-careers-url.cjs --sample 5   # stop after 5 successful matches
 *   node enrich-careers-url.cjs --no-email   # skip the end-of-run digest email
 *
 * Env: CAREER_NEON_URL (or DATABASE_URL), SERPER_API_KEY, FIRECRAWL_API_KEY, ANTHROPIC_API_KEY
 */

'use strict';

require('dotenv').config();
const { Pool }      = require('pg');
const { Firecrawl } = require('@mendable/firecrawl-js');
const Anthropic     = require('@anthropic-ai/sdk');
const {
  sleep, extractDomain, buildCareersUrl, searchSerper, scrapeWithFirecrawl, sendDigestEmail,
} = require('./src/backend/discovery-shared.cjs');

// ─── CLI args ────────────────────────────────────────────────────────────────

function getArg(name) {
  const eq  = process.argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=')[1];
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return null;
}

const DRY_RUN  = process.argv.includes('--dry-run');
const NO_EMAIL = process.argv.includes('--no-email');
const SAMPLE   = parseInt(getArg('sample') || '0') || 0;

const DELAY_MS           = 2500;
const SERPER_DELAY_MS    = 1500;
const MAX_MARKDOWN_CHARS = 8000;
const HAIKU_MODEL        = 'claude-haiku-4-5-20251001';
const MAX_CANDIDATES     = 2; // try up to this many Serper results per company

const pool      = new Pool({
  connectionString: process.env.CAREER_NEON_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
const firecrawl = new Firecrawl({ apiKey: process.env.FIRECRAWL_API_KEY });
const claude    = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── DB ──────────────────────────────────────────────────────────────────────

// Not scoped to scrape_status — a company may already have been manually
// promoted to 'active' in the dashboard before this ever ran, and it still
// needs a careers_url regardless of what stage of review it's in.
async function loadPendingCompanies() {
  const { rows } = await pool.query(`
    SELECT id, company_name, hq_state, scrape_status
    FROM companies
    WHERE careers_url IS NULL
      AND scrape_status IN ('pending_review', 'active')
    ORDER BY id ASC
  `);
  return rows;
}

// Fill in the URL. Only promote pending_review -> active on a confident
// match; if it's already active (manually promoted), leave that as-is.
async function applyCareersUrl(id, careersUrl, currentStatus) {
  if (DRY_RUN) return;
  const nextStatus = currentStatus === 'pending_review' ? 'active' : currentStatus;
  await pool.query(`
    UPDATE companies
    SET careers_url = $1, scrape_status = $2, updated_at = NOW()
    WHERE id = $3
  `, [careersUrl, nextStatus, id]);
}

// ─── Haiku identity check ────────────────────────────────────────────────────

let inputTokensEstimate  = 0;
let outputTokensEstimate = 0;

async function confirmIdentity(companyName, hqState, markdown, sourceUrl) {
  const prompt = `Does this webpage belong to the company "${companyName}"${hqState ? ` (based in ${hqState})` : ''}?

Source URL: ${sourceUrl}

Page content (may be truncated):
${markdown}

Return ONLY valid JSON — no explanation outside the braces:
{
  "is_match": true or false,
  "is_careers_page": true or false,
  "confidence": "high | medium | low | failed",
  "reason": "one sentence explaining the match/mismatch"
}

Rules:
- is_match=true only if this page is clearly this specific company's own site (not a directory listing, a different company with a similar name, a news article about them, or a job-board aggregator page).
- is_careers_page=true ONLY if the actual page CONTENT shows real job listings, a careers/jobs section, or a "join our team" style page right now. Base this strictly on what's in the page content above — never infer it from the URL's structure or domain pattern (e.g. a "myworkdayjobs.com" or "/careers" URL shape is NOT evidence by itself). If the content shows an error, a 404, a blank/placeholder page, or anything other than real careers content, is_careers_page MUST be false even if the URL looks like it should be a careers page.
- confidence=failed if the page is blank, a 404, a login wall, or otherwise unreadable.`;

  const response = await claude.messages.create({
    model:      HAIKU_MODEL,
    max_tokens: 200,
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
    return { is_match: false, is_careers_page: false, confidence: 'failed', reason: `Parse error: ${text.slice(0, 80)}` };
  }
}

function printCostEstimate(serperCalls) {
  const haiku  = (inputTokensEstimate / 1e6) * 0.80 + (outputTokensEstimate / 1e6) * 4.00;
  const serper = (serperCalls / 1000) * 50;
  console.log(`\n  Estimated cost:`);
  console.log(`    Haiku   ~$${haiku.toFixed(4)}  (${inputTokensEstimate.toLocaleString()} in / ${outputTokensEstimate.toLocaleString()} out tokens)`);
  console.log(`    Serper  ~$${serper.toFixed(4)}  (${serperCalls} API calls)`);
  return { haiku, serper };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const missing = ['SERPER_API_KEY', 'FIRECRAWL_API_KEY', 'ANTHROPIC_API_KEY'].filter(k => !process.env[k]);
  if (missing.length) { console.error(`\nMissing env vars: ${missing.join(', ')}\n`); process.exit(1); }
  if (!process.env.CAREER_NEON_URL && !process.env.DATABASE_URL) {
    console.error('\nMissing CAREER_NEON_URL or DATABASE_URL\n'); process.exit(1);
  }

  console.log(`\n${'='.repeat(55)}`);
  console.log(`Careers-URL Enrichment  —  Serper → Firecrawl → Haiku → Neon`);
  console.log(`${'='.repeat(55)}`);
  console.log(`Mode:   ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}`);
  console.log(`Sample: ${SAMPLE || 'unlimited'} matches\n`);

  const pending = await loadPendingCompanies();
  console.log(`${pending.length} companies pending careers_url enrichment\n`);

  let matched = 0, notFound = 0, serperCalls = 0, apiFailures = 0;
  const matchedNames = [], notFoundNames = [];

  for (const company of pending) {
    if (SAMPLE && matched >= SAMPLE) {
      console.log(`\nSample limit reached (${SAMPLE} matches). Stopping.`);
      break;
    }

    console.log(`\n[${company.company_name}]  (id=${company.id})`);
    const results = await searchSerper(`"${company.company_name}" careers`, process.env.SERPER_API_KEY, { delayMs: SERPER_DELAY_MS });
    serperCalls += 2; // searchSerper fetches up to 2 pages internally
    await sleep(SERPER_DELAY_MS);

    const candidates = results
      .map(r => r.link)
      .filter(Boolean)
      .filter(link => extractDomain(link)) // must parse as a real URL
      .slice(0, MAX_CANDIDATES);

    if (candidates.length === 0) {
      console.log(`  No Serper results — leaving for manual lookup.`);
      notFound++;
      notFoundNames.push(company.company_name);
      continue;
    }

    let foundUrl = null;

    for (const link of candidates) {
      const careersUrl = buildCareersUrl(link);
      console.log(`  Trying: ${careersUrl}`);

      let markdown;
      try {
        markdown = await scrapeWithFirecrawl(firecrawl, careersUrl, MAX_MARKDOWN_CHARS);
      } catch (err) {
        console.log(`    scrape failed: ${err.message.slice(0, 70)}`);
        await sleep(DELAY_MS);
        continue;
      }

      // A single candidate's API failure must not kill the whole run —
      // any company already matched/written this run stays that way; just
      // try the next candidate (or fall through to "no confident match").
      let check;
      try {
        check = await confirmIdentity(company.company_name, company.hq_state, markdown, careersUrl);
      } catch (err) {
        console.log(`    Haiku call failed: ${err.message.slice(0, 100)}`);
        apiFailures++;
        await sleep(DELAY_MS);
        continue;
      }
      console.log(`    is_match=${check.is_match} is_careers_page=${check.is_careers_page} confidence=${check.confidence} — ${check.reason}`);

      // Require BOTH: the site is genuinely this company's, AND the specific
      // page actually shows careers content (not a 404/soft-404 that still
      // scraped "successfully" as far as Firecrawl is concerned).
      if (check.is_match && check.is_careers_page && check.confidence !== 'failed') {
        foundUrl = careersUrl;
        break;
      }
      await sleep(DELAY_MS);
    }

    if (foundUrl) {
      console.log(`  ✅ MATCHED: ${foundUrl}`);
      await applyCareersUrl(company.id, foundUrl, company.scrape_status);
      matched++;
      matchedNames.push(`${company.company_name} → ${foundUrl}`);
    } else {
      console.log(`  ⚠️  No confident match — leaving for manual lookup.`);
      notFound++;
      notFoundNames.push(company.company_name);
    }

    await sleep(DELAY_MS);
  }

  console.log(`\n${'='.repeat(55)}`);
  console.log(`Enrichment complete`);
  console.log(`  Companies checked: ${matched + notFound}`);
  console.log(`  Matched & promoted to active: ${matched}${DRY_RUN ? '  (DRY RUN — nothing written)' : ''}`);
  console.log(`  No confident match: ${notFound}`);
  console.log(`  API call failures:  ${apiFailures}`);
  const cost = printCostEstimate(serperCalls);
  console.log(`${'='.repeat(55)}\n`);

  if (!DRY_RUN && !NO_EMAIL) {
    const lines = [
      `Careers-URL Enrichment — ${new Date().toLocaleString()}`,
      '',
      `TRIED: ${matched + notFound} companies checked.`,
      '',
      `ACCOMPLISHED: ${matched} matched and promoted to active${matchedNames.length ? ':' : '.'}`,
      ...matchedNames.map(n => `  - ${n}`),
      '',
      `MISSED: ${notFound} with no confident match (left for manual lookup)${notFoundNames.length ? ':' : '.'}`,
      ...notFoundNames.map(n => `  - ${n}`),
      '',
      `API call failures: ${apiFailures}`,
      `Est. cost: Haiku ~$${cost.haiku.toFixed(4)}, Serper ~$${cost.serper.toFixed(4)}`,
    ];
    await sendDigestEmail(`Careers-URL Enrichment: ${matched} matched, ${notFound} unmatched`, lines);
  }

  await pool.end();
}

main().catch(err => {
  console.error('\nFatal:', err.message);
  process.exit(1);
});

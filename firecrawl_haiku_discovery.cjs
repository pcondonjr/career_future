/**
 * firecrawl_haiku_discovery.cjs
 *
 * Pass 2: Uses Firecrawl (JS-rendered markdown) + Claude Haiku (cheap)
 * to discover CSS selectors for companies that Pass 1 couldn't handle.
 *
 * Cost estimate: ~$1.50 for ~900 companies
 *   - Firecrawl: renders page, returns clean markdown (~5K tokens vs 40K raw HTML)
 *   - Haiku: $0.25/MTok input, $1.25/MTok output
 *
 * Processes companies where:
 *   status='done' AND selector_confidence='failed' AND has a valid URL
 *
 * Usage:
 *   node firecrawl_haiku_discovery.cjs
 *   node firecrawl_haiku_discovery.cjs --sample 10
 *   node firecrawl_haiku_discovery.cjs --agent-id fc-1
 *   node firecrawl_haiku_discovery.cjs --dry-run
 *
 * Env vars: DATABASE_URL, FIRECRAWL_API_KEY, ANTHROPIC_API_KEY
 */

require('dotenv').config();
const { Pool } = require('pg');
const { Firecrawl } = require('@mendable/firecrawl-js');
const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');

// ─── CLI args ────────────────────────────────────────────────────────────────

function getArg(name) {
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=')[1];
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return null;
}

const SAMPLE = parseInt(getArg('sample') || '0') || 0;
const AGENT_ID = getArg('agent-id') || `fc-${crypto.randomBytes(4).toString('hex')}`;
const DRY_RUN = process.argv.includes('--dry-run');
const DELAY_MS = 2000;
const MAX_MARKDOWN_CHARS = 8000; // Keep Haiku input small for cost
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const firecrawl = new Firecrawl({ apiKey: process.env.FIRECRAWL_API_KEY });
const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Retry helper ────────────────────────────────────────────────────────────

async function withRetry(fn, retries = 3, delayMs = 5000) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); } catch (err) {
      if (i === retries - 1) throw err;
      const isTransient = err.code === 'ENOTFOUND' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT'
        || (err.status === 429);
      // Never retry billing/auth errors
      if (err.status === 400 || err.status === 401 || err.status === 403) throw err;
      if (!isTransient) throw err;
      const wait = delayMs * (i + 1); // exponential-ish backoff
      console.log(`  Retrying in ${wait / 1000}s... (${err.code || err.status || 'error'})`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

// ─── Neon DB helpers ─────────────────────────────────────────────────────────

async function claimNextCompany() {
  return withRetry(async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(`
        UPDATE companies
        SET status = 'fc_processing', agent_id = $1, started_at = NOW(), updated_at = NOW()
        WHERE id = (
          SELECT id FROM companies
          WHERE status = 'done'
            AND selector_confidence = 'failed'
            AND (selector_notes IS NULL OR selector_notes NOT LIKE 'Firecrawl%')
            AND (enabled IS NULL OR LOWER(enabled) IN ('false', '0', 'disabled', 'no', ''))
            AND careers_url IS NOT NULL
            AND careers_url != ''
            AND careers_url LIKE 'http%'
          ORDER BY id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        RETURNING *
      `, [AGENT_ID]);
      await client.query('COMMIT');
      return rows[0] || null;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });
}

async function updateCompanyResult(id, updates) {
  if (DRY_RUN) return;
  return withRetry(() => pool.query(`
    UPDATE companies
    SET careers_url = COALESCE($2, careers_url),
        job_card_selector = $3,
        title_selector = $4,
        location_selector = $5,
        link_selector = $6,
        selector_confidence = $7,
        selector_notes = $8,
        enabled = $9,
        notes = $10,
        status = 'done',
        completed_at = NOW(),
        updated_at = NOW()
    WHERE id = $1
  `, [
    id,
    updates.careers_url || null,
    updates.job_card_selector || '',
    updates.title_selector || '',
    updates.location_selector || '',
    updates.link_selector || '',
    updates.selector_confidence || 'failed',
    updates.selector_notes || '',
    updates.enabled || 'false',
    updates.notes || '',
  ]));
}

async function releaseCompany(id) {
  if (DRY_RUN) return;
  await withRetry(() => pool.query(`
    UPDATE companies SET status = 'fc_failed', agent_id = NULL, started_at = NULL, updated_at = NOW()
    WHERE id = $1
  `, [id]));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Firecrawl + Haiku ──────────────────────────────────────────────────────

async function scrapeWithFirecrawl(url) {
  const result = await firecrawl.v1.scrapeUrl(url, {
    formats: ['markdown'],
    waitFor: 5000, // wait for JS rendering
    timeout: 30000,
  });

  if (!result.success) {
    throw new Error(`Firecrawl failed: ${result.error || 'unknown'}`);
  }

  return result.markdown || '';
}

async function extractSelectorsWithHaiku(markdown, careersUrl) {
  const trimmed = markdown.slice(0, MAX_MARKDOWN_CHARS);

  const prompt = `You are a web scraping expert. Analyze this markdown (converted from a careers page) and determine CSS selectors for scraping job listings.

Careers page URL: ${careersUrl}

Page content (markdown, may be truncated):
${trimmed}

Based on the page structure and content, return ONLY valid JSON with:
{
  "job_card_selector": "CSS selector for each job listing wrapper",
  "title_selector": "CSS selector for job title (relative to card)",
  "location_selector": "CSS selector for location (relative to card, empty if none)",
  "link_selector": "CSS selector for the job link (relative to card)",
  "confidence": "high | medium | low | failed",
  "notes": "ATS platform detected, page structure notes",
  "detected_ats": "name of ATS platform if detected, or null",
  "careers_url_suggestion": "better URL if this page redirects to an ATS, or null",
  "job_count": number of visible job listings on the page,
  "sample_titles": ["first 3 job titles you see on the page"]
}

Rules:
- Common ATS selectors: Greenhouse=".opening", Lever=".posting", Workable='[data-ui="job"]', Workday='[data-automation-id="jobItem"]'
- If the page has NO job listings (just marketing copy, "no positions", etc.), set confidence="failed"
- If you detect an ATS URL in the content, include it in careers_url_suggestion
- If the markdown shows actual job titles and locations, mark confidence as "high" or "medium"
- job_count: count of distinct job listings visible on the page (0 if none)
- sample_titles: first 3 job titles visible (empty array if none)
- Be concise in notes`;

  const response = await claude.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 400,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0]?.text?.trim() || '';
  try {
    // Strip markdown fences and any leading/trailing text around the JSON
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON object found');
    const parsed = JSON.parse(jsonMatch[0]);
    // Sanitize careers_url_suggestion — must be a clean URL, not instructions
    if (parsed.careers_url_suggestion) {
      const urlMatch = parsed.careers_url_suggestion.match(/^https?:\/\/[^\s"'),]+/);
      parsed.careers_url_suggestion = urlMatch ? urlMatch[0].replace(/[.,]+$/, '') : null;
    }
    return parsed;
  } catch {
    return {
      job_card_selector: '', title_selector: '', location_selector: '', link_selector: '',
      confidence: 'failed',
      notes: `Haiku returned non-JSON: ${text.slice(0, 80)}`,
    };
  }
}

// ─── Cost tracking ───────────────────────────────────────────────────────────

let totalInputTokens = 0;
let totalOutputTokens = 0;

function trackTokens(markdown) {
  // Rough estimate: 1 token ≈ 4 chars
  const inputTokens = Math.ceil((markdown.length + 500) / 4); // markdown + prompt overhead
  const outputTokens = 100; // ~400 chars response
  totalInputTokens += inputTokens;
  totalOutputTokens += outputTokens;
}

function estimateCost() {
  const inputCost = (totalInputTokens / 1_000_000) * 0.80;   // Haiku input
  const outputCost = (totalOutputTokens / 1_000_000) * 4.00;  // Haiku output
  return { inputCost, outputCost, total: inputCost + outputCost };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.DATABASE_URL) { console.error('Missing DATABASE_URL'); process.exit(1); }
  if (!process.env.FIRECRAWL_API_KEY) { console.error('Missing FIRECRAWL_API_KEY'); process.exit(1); }
  if (!process.env.ANTHROPIC_API_KEY) { console.error('Missing ANTHROPIC_API_KEY'); process.exit(1); }

  const { rows: [{ count: eligibleCount }] } = await pool.query(
    `SELECT COUNT(*) AS count FROM companies
     WHERE status = 'done' AND selector_confidence = 'failed'
       AND (selector_notes IS NULL OR selector_notes NOT LIKE 'Firecrawl%')
       AND (enabled IS NULL OR LOWER(enabled) IN ('false', '0', 'disabled', 'no', ''))
       AND careers_url IS NOT NULL AND careers_url != '' AND careers_url LIKE 'http%'`
  );

  console.log(`Agent: ${AGENT_ID}${DRY_RUN ? ' (DRY RUN)' : ''}`);
  console.log(`Eligible companies: ${eligibleCount}`);
  console.log(`Model: ${HAIKU_MODEL} | Max markdown: ${MAX_MARKDOWN_CHARS} chars\n`);

  let processed = 0, highConf = 0, medConf = 0, lowConf = 0, failed = 0;
  const limit = SAMPLE > 0 ? SAMPLE : Infinity;

  while (processed < limit) {
    const row = await claimNextCompany();
    if (!row) {
      console.log('\nNo more eligible companies.');
      break;
    }

    const name = row.company_name;
    const url = row.careers_url;
    console.log(`[${processed + 1}] ${name} — ${url}`);

    try {
      // Step 1: Firecrawl
      console.log(`  → Firecrawl...`);
      const markdown = await scrapeWithFirecrawl(url);

      if (markdown.length < 100) {
        console.log(`  ✗ Page too short (${markdown.length} chars)`);
        await updateCompanyResult(row.id, {
          ...row, selector_confidence: 'failed',
          selector_notes: `Firecrawl: page too short (${markdown.length} chars)`,
        });
        failed++;
        processed++;
        await sleep(DELAY_MS);
        continue;
      }

      console.log(`  → ${markdown.length} chars markdown → Haiku...`);
      trackTokens(markdown.slice(0, MAX_MARKDOWN_CHARS));

      // Step 2: Haiku — first pass
      let selectors = await extractSelectorsWithHaiku(markdown, url);
      console.log(`  → Confidence: ${selectors.confidence} | ${selectors.notes?.slice(0, 80) || ''}`);

      // Step 3: If failed but Haiku suggested a better URL, follow it
      let betterUrl = selectors.careers_url_suggestion || null;
      // Clean up suggestions that are instructions, not actual URLs
      if (betterUrl && !betterUrl.startsWith('http')) betterUrl = null;

      if (selectors.confidence === 'failed' && betterUrl && betterUrl !== url) {
        console.log(`  → Following suggested URL: ${betterUrl}`);
        try {
          const markdown2 = await scrapeWithFirecrawl(betterUrl);
          if (markdown2.length >= 100) {
            console.log(`  → ${markdown2.length} chars → Haiku (retry)...`);
            trackTokens(markdown2.slice(0, MAX_MARKDOWN_CHARS));
            const selectors2 = await extractSelectorsWithHaiku(markdown2, betterUrl);
            console.log(`  → Retry confidence: ${selectors2.confidence} | ${selectors2.notes?.slice(0, 80) || ''}`);
            // Use the retry result if it's better
            if (selectors2.confidence !== 'failed') {
              selectors = selectors2;
              // Keep the better URL if retry succeeded
              if (!selectors2.careers_url_suggestion?.startsWith('http')) {
                betterUrl = betterUrl; // keep the one that worked
              } else {
                betterUrl = selectors2.careers_url_suggestion;
              }
            }
          }
        } catch (retryErr) {
          console.log(`  → Retry failed: ${retryErr.message?.slice(0, 60) || 'unknown'}`);
        }
      }

      const confidence = selectors.confidence || 'failed';
      const jobCount = selectors.job_count || 0;
      const hasSfJobs = false;
      const sampleTitles = (selectors.sample_titles || []).join(', ');

      // Only auto-enable if: selectors found + actual jobs visible
      const shouldEnable = (confidence === 'high' || confidence === 'medium') && jobCount > 0;
      const newEnabled = shouldEnable ? 'true' : row.enabled;

      const noteParts = [
        `Firecrawl+Haiku`,
        selectors.notes || '',
        selectors.detected_ats ? `(ATS: ${selectors.detected_ats})` : '',
        jobCount > 0 ? `${jobCount} jobs found` : '',
        sampleTitles ? `Samples: ${sampleTitles.slice(0, 100)}` : '',
      ].filter(Boolean).join(' | ');

      console.log(`  → ${jobCount} jobs | SF jobs: ${hasSfJobs} | Enable: ${shouldEnable}`);
      if (sampleTitles) console.log(`  → Titles: ${sampleTitles.slice(0, 100)}`);

      await updateCompanyResult(row.id, {
        careers_url: betterUrl || url,
        job_card_selector: selectors.job_card_selector || '',
        title_selector: selectors.title_selector || '',
        location_selector: selectors.location_selector || '',
        link_selector: selectors.link_selector || '',
        selector_confidence: confidence,
        selector_notes: noteParts,
        enabled: newEnabled,
        notes: row.notes || '',
      });

      if (confidence === 'high') highConf++;
      else if (confidence === 'medium') medConf++;
      else if (confidence === 'low') lowConf++;
      else failed++;

    } catch (err) {
      const msg = err.message || '';
      console.log(`  ✗ Error: ${msg.slice(0, 100)}`);

      // Halt on billing/auth errors — don't waste Firecrawl credits
      if (err.status === 400 && msg.includes('credit balance')) {
        console.error('\n⛔ Anthropic API has no credits. Add funds at https://console.anthropic.com/settings/billing');
        await releaseCompany(row.id).catch(() => {});
        break;
      }
      if (err.status === 401 || err.status === 403) {
        console.error('\n⛔ Anthropic API auth failed. Check ANTHROPIC_API_KEY in .env');
        await releaseCompany(row.id).catch(() => {});
        break;
      }

      await updateCompanyResult(row.id, {
        ...row, selector_confidence: 'failed',
        selector_notes: `Firecrawl+Haiku error: ${msg.slice(0, 100)}`,
      }).catch(() => {});
      failed++;
    }

    processed++;
    if (processed < limit) await sleep(DELAY_MS);

    // Print cost estimate every 50 companies
    if (processed % 50 === 0) {
      const cost = estimateCost();
      console.log(`  [Cost so far: ~$${cost.total.toFixed(3)} | ${totalInputTokens} input tokens]`);
    }
  }

  const cost = estimateCost();
  console.log('\n' + '='.repeat(60));
  console.log('Done!');
  console.log(`  Agent:     ${AGENT_ID}`);
  console.log(`  Processed: ${processed}`);
  console.log(`  High:      ${highConf}`);
  console.log(`  Medium:    ${medConf}`);
  console.log(`  Low:       ${lowConf}`);
  console.log(`  Failed:    ${failed}`);
  console.log(`  Est. cost: $${cost.total.toFixed(3)} (${totalInputTokens} in / ${totalOutputTokens} out tokens)`);
  console.log('='.repeat(60));

  await pool.end();
}

main().catch(async (err) => {
  console.error('Fatal error:', err);
  await pool.end().catch(() => {});
  process.exit(1);
});

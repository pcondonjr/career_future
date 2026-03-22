/**
 * oxylabs_selector_discovery.cjs
 *
 * For each disabled company in Neon DB, uses Oxylabs Web Scraper API
 * to fetch the careers page HTML, then sends it to Claude to identify
 * job_card_selector, title_selector, location_selector, link_selector.
 *
 * Uses Neon row locking so multiple agents can run safely in parallel.
 * Each agent claims rows with status='processing' + its own agent_id.
 *
 * Usage:
 *   node oxylabs_selector_discovery.cjs
 *   node oxylabs_selector_discovery.cjs --sample 10
 *   node oxylabs_selector_discovery.cjs --agent-id agent-1
 *
 * Env vars required (.env):
 *   OXYLABS_USERNAME=your_username
 *   OXYLABS_PASSWORD=your_password
 *   ANTHROPIC_API_KEY=sk-ant-...
 *   DATABASE_URL=postgresql://...
 */

require('dotenv').config();
const https = require('https');
const { Pool } = require('pg');
const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');

// ─── Config ──────────────────────────────────────────────────────────────────

function getArg(name) {
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=')[1];
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return null;
}

const SAMPLE = parseInt(getArg('sample') || '0') || 0;
const AGENT_ID = getArg('agent-id') || `agent-${crypto.randomBytes(4).toString('hex')}`;

const DELAY_MS       = 3000;
const CLAUDE_MODEL   = 'claude-sonnet-4-20250514';
const MAX_HTML_CHARS = 40000;

const CAREER_PATH_CANDIDATES = [
  '/careers', '/jobs', '/careers/jobs', '/about/careers',
  '/join-us', '/work-with-us', '/open-positions', '/hiring',
  '/careers/open-positions',
];

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// ─── Oxylabs helper ──────────────────────────────────────────────────────────

async function oxylabsFetch(url) {
  const payload = JSON.stringify({
    source: 'universal',
    url,
    render: 'html',
    parse: false,
    browser_instructions: [
      {
        type: 'wait_for_element',
        selector: {
          type: 'css',
          value: [
            '.job-listing', '.job-card', '.opening', '.posting',
            '.position-card', '[class*="job"]', '[class*="career"]',
            '[class*="position"]', 'li[data-job]', '.iCIMS_JobsTable',
            '.css-19uc56f',
          ].join(', '),
        },
        timeout_s: 10,
      },
      { type: 'wait', wait_time_s: 2 },
    ],
  });

  const credentials = Buffer.from(
    `${process.env.OXYLABS_USERNAME}:${process.env.OXYLABS_PASSWORD}`
  ).toString('base64');

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'realtime.oxylabs.io',
        path: '/v1/queries',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${credentials}`,
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 400) {
            return reject(new Error(`Oxylabs HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          }
          try {
            const json = JSON.parse(data);
            const html = json?.results?.[0]?.content || '';
            resolve({ html, statusCode: res.statusCode, raw: json });
          } catch (e) {
            reject(new Error(`JSON parse error: ${e.message}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(new Error('Oxylabs request timeout')); });
    req.write(payload);
    req.end();
  });
}

// ─── Careers page finder ─────────────────────────────────────────────────────

async function findCareersPage(baseUrl) {
  let base;
  try {
    const u = new URL(baseUrl.startsWith('http') ? baseUrl : 'https://' + baseUrl);
    base = u.origin;
  } catch {
    base = baseUrl.replace(/\/$/, '');
  }

  for (const candidate of CAREER_PATH_CANDIDATES) {
    const tryUrl = base + candidate;
    console.log(`    → Trying: ${tryUrl}`);
    try {
      const { html } = await oxylabsFetch(tryUrl);
      const lower = html.toLowerCase();
      const hasJobKeywords = (
        lower.includes('job') || lower.includes('career') ||
        lower.includes('position') || lower.includes('opening') ||
        lower.includes('apply')
      );
      if (html.length > 2000 && hasJobKeywords) {
        console.log(`    ✓ Found careers page: ${tryUrl} (${html.length} chars)`);
        return { careersUrl: tryUrl, html };
      }
    } catch {
      // Try next candidate
    }
    await sleep(500);
  }
  return null;
}

// ─── Claude selector extraction ──────────────────────────────────────────────

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function extractSelectorsWithClaude(html, careersUrl) {
  const trimmedHtml = html.slice(0, MAX_HTML_CHARS);

  const prompt = `You are a web scraping expert. Analyze this HTML from a company careers page and identify CSS selectors for scraping job listings.

Careers page URL: ${careersUrl}

HTML (may be truncated):
\`\`\`html
${trimmedHtml}
\`\`\`

Return ONLY valid JSON (no markdown, no explanation) with this exact shape:
{
  "job_card_selector": "CSS selector for the element wrapping each individual job listing",
  "title_selector": "CSS selector for the job title, relative to job_card_selector",
  "location_selector": "CSS selector for the job location, relative to job_card_selector (empty string if not present)",
  "link_selector": "CSS selector for the <a> tag linking to the full job posting, relative to job_card_selector",
  "confidence": "high | medium | low | failed",
  "notes": "brief notes about the page structure or ATS platform detected (e.g. Workday, Greenhouse, etc.)"
}

Rules:
- If this is a Workday page (myworkdayjobs.com or similar), use selectors like: job_card=".css-19uc56f", title="h3", location=".css-129m7dg", link="a"
- If this is a Greenhouse page, use: job_card=".opening", title="a", location=".location", link="a"
- If this is a Lever page, use: job_card=".posting", title=".posting-name h5", location=".posting-categories .location", link="a"
- If this is an iCIMS page, use: job_card=".iCIMS_JobsTable tr", title=".iCIMS_JobsTableTitleCell a", location=".iCIMS_JobsTableLocationCell", link=".iCIMS_JobsTableTitleCell a"
- If no job listings are visible on this page (e.g. it requires JS or login), set confidence to "failed" and explain in notes
- Prefer class selectors over nth-child or index-based selectors
- IMPORTANT: If you find any URLs in the HTML that point to an external ATS platform (BambooHR, Greenhouse, Lever, Workday, iCIMS, Taleo, Jobvite, SmartRecruiters, Teamtailor, Ashby, Rippling, etc.), always include the full URL in your notes field. Example: "Page is a marketing landing page. Actual jobs hosted at https://company.bamboohr.com/careers"
- If the careers_url already has a path like /open-positions or /jobs that is different from what you fetched, note the correct direct URL to job listings in your notes`;

  const response = await claude.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 500,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0]?.text?.trim() || '';
  try {
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    return {
      job_card_selector: '',
      title_selector: '',
      location_selector: '',
      link_selector: '',
      confidence: 'failed',
      notes: `Claude returned non-JSON: ${text.slice(0, 100)}`,
    };
  }
}

// ─── Neon DB helpers ─────────────────────────────────────────────────────────

/**
 * Claim the next pending company using row locking (SELECT ... FOR UPDATE SKIP LOCKED).
 * Returns the claimed row or null if none available.
 */
async function claimNextCompany() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(`
      UPDATE companies
      SET status = 'processing', agent_id = $1, started_at = NOW(), updated_at = NOW()
      WHERE id = (
        SELECT id FROM companies
        WHERE status = 'pending'
          AND (enabled IS NULL OR LOWER(enabled) IN ('false', '0', 'disabled', 'no', ''))
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING *
    `, [AGENT_ID]);

    await client.query('COMMIT');
    return rows[0] || null;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Mark a company as done/failed with results.
 */
async function updateCompanyResult(id, updates) {
  const { rows } = await pool.query(`
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
        status = $11,
        completed_at = NOW(),
        updated_at = NOW()
    WHERE id = $1
    RETURNING *
  `, [
    id,
    updates.careers_url || null,
    updates.job_card_selector || '',
    updates.title_selector || '',
    updates.location_selector || '',
    updates.link_selector || '',
    updates.selector_confidence || 'unknown',
    updates.selector_notes || '',
    updates.enabled || 'false',
    updates.notes || '',
    updates.status || 'done',
  ]);
  return rows[0];
}

/**
 * Release a claimed row back to pending (e.g. on unexpected error).
 */
async function releaseCompany(id) {
  await pool.query(`
    UPDATE companies
    SET status = 'pending', agent_id = NULL, started_at = NULL, updated_at = NOW()
    WHERE id = $1
  `, [id]);
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isJobPostingUrl(url) {
  if (!url) return false;
  return (
    /\/jobs?\/[^/]*\d{5,}/.test(url) ||
    /\/(jobseekers\/job|job-detail|job-posting|apply)\//i.test(url) ||
    url.includes('avua.com/jobs/') ||
    url.includes('onlinejobs.ph/jobseekers')
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  // Validate env
  if (!process.env.OXYLABS_USERNAME || !process.env.OXYLABS_PASSWORD) {
    console.error('Missing OXYLABS_USERNAME or OXYLABS_PASSWORD in .env');
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Missing ANTHROPIC_API_KEY in .env');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error('Missing DATABASE_URL in .env');
    process.exit(1);
  }

  // Verify DB connection
  const { rows: [{ count: totalCount }] } = await pool.query('SELECT COUNT(*) AS count FROM companies');
  console.log(`Connected to Neon. ${totalCount} companies in database.`);
  console.log(`Agent ID: ${AGENT_ID}`);

  const { rows: [{ count: pendingCount }] } = await pool.query(
    `SELECT COUNT(*) AS count FROM companies WHERE status = 'pending' AND (enabled IS NULL OR LOWER(enabled) IN ('false', '0', 'disabled', 'no', ''))`
  );
  console.log(`Pending disabled companies: ${pendingCount}`);

  if (parseInt(pendingCount) === 0) {
    console.log('No pending companies to process. Done.');
    await pool.end();
    return;
  }

  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  const limit = SAMPLE > 0 ? SAMPLE : Infinity;

  while (processed < limit) {
    // Claim next row with row locking
    const row = await claimNextCompany();
    if (!row) {
      console.log('\nNo more pending companies available. Done.');
      break;
    }

    const name = row.company_name;
    const baseUrl = row.careers_url;

    if (!baseUrl) {
      console.log(`\n[${processed + 1}] ${name} — no URL, skipping`);
      await updateCompanyResult(row.id, {
        ...row, selector_notes: 'No URL available', selector_confidence: 'failed', status: 'failed',
      });
      processed++;
      failed++;
      continue;
    }

    if (isJobPostingUrl(baseUrl)) {
      console.log(`\n[${processed + 1}] ${name} — URL is a specific job posting, skipping`);
      await updateCompanyResult(row.id, {
        ...row,
        selector_notes: 'careers_url is a specific job posting, not a careers page — needs correct URL',
        selector_confidence: 'failed',
        status: 'failed',
      });
      processed++;
      failed++;
      continue;
    }

    console.log(`\n[${processed + 1}] ${name}`);
    console.log(`  Base URL: ${baseUrl}`);

    try {
      // Step 1: Find the careers page
      let careersResult;

      if (row.careers_url) {
        console.log(`  → Trying careers_url: ${row.careers_url}`);
        try {
          const { html } = await oxylabsFetch(row.careers_url);
          const lower = html.toLowerCase();
          const hasJobKeywords = (
            lower.includes('job') || lower.includes('career') ||
            lower.includes('position') || lower.includes('opening') ||
            lower.includes('apply')
          );
          if (html.length > 2000 && hasJobKeywords) {
            careersResult = { careersUrl: row.careers_url, html };
          } else {
            console.log(`  careers_url didn't look like a careers page, trying path candidates`);
          }
        } catch {
          console.log(`  careers_url failed, trying path candidates`);
        }
      }

      if (!careersResult) {
        careersResult = await findCareersPage(baseUrl);
      }

      if (!careersResult) {
        console.log(`  No careers page found`);
        await updateCompanyResult(row.id, {
          ...row,
          selector_confidence: 'failed',
          selector_notes: 'No careers page found after trying all common paths',
          status: 'failed',
        });
        failed++;
        processed++;
        await sleep(DELAY_MS);
        continue;
      }

      // Step 2: Send HTML to Claude
      console.log(`  → Sending HTML to Claude for selector extraction...`);
      const selectors = await extractSelectorsWithClaude(careersResult.html, careersResult.careersUrl);

      console.log(`  Confidence: ${selectors.confidence} | Card: ${selectors.job_card_selector} | Notes: ${selectors.notes}`);

      // Step 3: Extract any ATS redirect URL
      const atsUrlMatch = (selectors.notes || '').match(
        /https?:\/\/[^\s"')>]+(?:bamboohr|greenhouse|lever|workday|icims|taleo|jobvite|smartrecruiters|myworkdayjobs|teamtailor|ashbyhq|rippling|recruitee|breezy|applytojob|careers\.)[^\s"')>]*/i
      );
      const discoveredAtsUrl = atsUrlMatch ? atsUrlMatch[0].replace(/[.,]+$/, '') : null;
      if (discoveredAtsUrl && discoveredAtsUrl !== careersResult.careersUrl) {
        console.log(`  ATS URL found: ${discoveredAtsUrl}`);
      }

      // Step 4: Update DB
      const newEnabled = (selectors.confidence === 'high' || selectors.confidence === 'medium') ? 'true' : row.enabled;
      const newNotes = discoveredAtsUrl && selectors.confidence === 'failed'
        ? `${row.notes || ''} | ATS URL found: ${discoveredAtsUrl} - retry needed`.trim()
        : row.notes;

      await updateCompanyResult(row.id, {
        careers_url: discoveredAtsUrl || careersResult.careersUrl,
        job_card_selector: selectors.job_card_selector || '',
        title_selector: selectors.title_selector || '',
        location_selector: selectors.location_selector || '',
        link_selector: selectors.link_selector || '',
        selector_confidence: selectors.confidence || 'unknown',
        selector_notes: selectors.notes || '',
        enabled: newEnabled,
        notes: newNotes,
        status: 'done',
      });
      succeeded++;
      console.log(`  Saved to Neon.`);

    } catch (err) {
      console.error(`  Error: ${err.message}`);
      try {
        await updateCompanyResult(row.id, {
          ...row,
          selector_confidence: 'failed',
          selector_notes: `Error: ${err.message.slice(0, 150)}`,
          status: 'failed',
        });
      } catch {
        // If DB update fails too, release the row
        await releaseCompany(row.id).catch(() => {});
      }
      failed++;
    }

    processed++;
    if (processed < limit) {
      await sleep(DELAY_MS);
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('Done!');
  console.log(`   Agent:     ${AGENT_ID}`);
  console.log(`   Processed: ${processed}`);
  console.log(`   Succeeded: ${succeeded}`);
  console.log(`   Failed:    ${failed}`);
  console.log('='.repeat(60));

  await pool.end();
}

main().catch(async (err) => {
  console.error('Fatal error:', err);
  await pool.end().catch(() => {});
  process.exit(1);
});

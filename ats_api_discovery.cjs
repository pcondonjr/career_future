/**
 * ats_api_discovery.cjs
 *
 * Discovers job listings for disabled companies by detecting their ATS platform
 * and hitting the public JSON API directly. No Oxylabs, no Claude, no cost.
 *
 * Supported ATS platforms:
 *   - Greenhouse (boards-api.greenhouse.io)
 *   - Lever (api.lever.co)
 *   - Workable (apply.workable.com/api)
 *   - Ashby (api.ashbyhq.com)
 *   - SmartRecruiters (api.smartrecruiters.com)
 *   - BambooHR (company.bamboohr.com)
 *   - Recruitee (company.recruitee.com/api)
 *   - Teamtailor (company.teamtailor.com)
 *
 * For non-ATS URLs, uses lightweight HEAD/GET requests to detect redirects
 * to known ATS platforms before giving up.
 *
 * Usage:
 *   node ats_api_discovery.cjs
 *   node ats_api_discovery.cjs --sample 10
 *   node ats_api_discovery.cjs --agent-id api-1
 *   node ats_api_discovery.cjs --include-processed   (retry done/failed rows too)
 *
 * Env vars: DATABASE_URL
 */

require('dotenv').config();
const https = require('https');
const http = require('http');
const { Pool } = require('pg');
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
const AGENT_ID = getArg('agent-id') || `api-${crypto.randomBytes(4).toString('hex')}`;
const INCLUDE_PROCESSED = process.argv.includes('--include-processed');
const DELAY_MS = 1000; // 1s between requests — polite, and these are fast

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Retry wrapper for DB operations that may fail on transient DNS/network errors
async function withRetry(fn, retries = 3, delayMs = 5000) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); } catch (err) {
      if (i === retries - 1) throw err;
      const isTransient = err.code === 'ENOTFOUND' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
      if (!isTransient) throw err;
      console.log(`  ⚠ DB error (${err.code}), retrying in ${delayMs / 1000}s... (${i + 1}/${retries})`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

// ─── HTTP helper ─────────────────────────────────────────────────────────────

function fetchJSON(url, { timeout = 15000, followRedirects = true } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'CareerFuture/1.0' } }, (res) => {
      if (followRedirects && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return fetchJSON(redirectUrl, { timeout, followRedirects }).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, data, headers: res.headers, url: res.url || url });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(new Error('Request timeout')); });
  });
}

function fetchHead(url, { timeout = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(url, { method: 'HEAD', headers: { 'User-Agent': 'CareerFuture/1.0' } }, (res) => {
      resolve({ statusCode: res.statusCode, headers: res.headers, location: res.headers.location });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(new Error('Head timeout')); });
  });
}

// ─── ATS Detection & API calls ──────────────────────────────────────────────

const ATS_PATTERNS = [
  {
    name: 'Greenhouse',
    detect: (url) => {
      const m = url.match(/boards\.greenhouse\.io\/(?:embed\/job_board\?.*for=)?(\w[\w-]*)/i)
              || url.match(/greenhouse\.io\/(\w[\w-]*)/i);
      return m ? m[1] : null;
    },
    apiUrl: (slug) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`,
    parseJobs: (data) => {
      const json = JSON.parse(data);
      return (json.jobs || []).map(j => ({
        title: j.title,
        location: j.location?.name || '',
        url: j.absolute_url || '',
      }));
    },
    selectors: { job_card: '.opening', title: 'a', location: '.location', link: 'a' },
  },
  {
    name: 'Lever',
    detect: (url) => {
      const m = url.match(/jobs\.lever\.co\/(\w[\w-]*)/i)
              || url.match(/api\.lever\.co\/v0\/postings\/(\w[\w-]*)/i);
      return m ? m[1] : null;
    },
    apiUrl: (slug) => `https://api.lever.co/v0/postings/${slug}`,
    parseJobs: (data) => {
      const json = JSON.parse(data);
      return (Array.isArray(json) ? json : []).map(j => ({
        title: j.text || '',
        location: j.categories?.location || '',
        url: j.hostedUrl || '',
      }));
    },
    selectors: { job_card: '.posting', title: '.posting-name h5', location: '.posting-categories .location', link: 'a' },
  },
  {
    name: 'Workable',
    detect: (url) => {
      const m = url.match(/apply\.workable\.com\/(?:api\/v\d\/widget\/accounts\/)?(\w[\w-]*)/i);
      return m ? m[1] : null;
    },
    apiUrl: (slug) => `https://apply.workable.com/api/v3/accounts/${slug}/jobs`,
    apiMethod: 'POST',
    parseJobs: (data) => {
      const json = JSON.parse(data);
      return (json.results || []).map(j => ({
        title: j.title || '',
        location: j.location?.city || j.location?.country || '',
        url: j.url || `https://apply.workable.com/${j.account?.shortcode}/j/${j.shortcode}/`,
      }));
    },
    selectors: { job_card: '[data-ui="job"]', title: 'h3', location: '.job-details span', link: 'a' },
  },
  {
    name: 'Ashby',
    detect: (url) => {
      const m = url.match(/jobs\.ashbyhq\.com\/(\w[\w-]*)/i);
      return m ? m[1] : null;
    },
    apiUrl: (slug) => `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
    parseJobs: (data) => {
      const json = JSON.parse(data);
      return (json.jobs || []).map(j => ({
        title: j.title || '',
        location: j.location || '',
        url: j.jobUrl || '',
      }));
    },
    selectors: { job_card: '[data-testid="job-posting"]', title: 'a', location: '.location', link: 'a' },
  },
  {
    name: 'Workday',
    detect: (url) => {
      // Match: company.wd5.myworkdayjobs.com/path, services1.wd502.myworkday.com, wd3.myworkdaysite.com
      const m = url.match(/(\w[\w-]*)\.wd\d+\.myworkdayjobs\.com(?:\/[\w-]+)?/i)
              || url.match(/([\w-]+)\.myworkday(?:site)?\.com/i);
      if (m) return m[0].replace(/^https?:\/\//, ''); // Return the full host+path as "slug"
      return null;
    },
    apiUrl: (slug) => `https://${slug}`,
    parseJobs: (data) => {
      // Workday embeds job data in JSON-LD or a JS variable. Try to extract.
      try {
        const json = JSON.parse(data);
        const items = json.jobPostings || json.body?.children || [];
        return items.map(j => ({ title: j.title || j.text || '', location: j.locationsText || '', url: '' }));
      } catch {
        // Try to find JSON-LD
        const ldMatch = data.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
        if (ldMatch) {
          try {
            const ld = JSON.parse(ldMatch[1]);
            const items = Array.isArray(ld) ? ld : ld.itemListElement || [ld];
            return items.filter(i => i['@type'] === 'JobPosting').map(j => ({
              title: j.title || '', location: j.jobLocation?.address?.addressLocality || '', url: j.url || '',
            }));
          } catch {}
        }
        // Count job-like elements as a heuristic
        const jobMatches = data.match(/data-automation-id="jobTitle"/gi) || [];
        if (jobMatches.length > 0) {
          return jobMatches.map(() => ({ title: '(Workday job)', location: '', url: '' }));
        }
        return [];
      }
    },
    selectors: { job_card: '[data-automation-id="jobItem"]', title: '[data-automation-id="jobTitle"]', location: '[data-automation-id="locations"]', link: 'a' },
  },
  {
    name: 'SmartRecruiters',
    detect: (url) => {
      const m = url.match(/jobs\.smartrecruiters\.com\/(\w[\w-]*)/i)
              || url.match(/api\.smartrecruiters\.com\/v1\/companies\/(\w[\w-]*)/i)
              || url.match(/join\.smartrecruiters\.com\/(\w[\w-]*)/i);
      return m ? m[1] : null;
    },
    apiUrl: (slug) => `https://api.smartrecruiters.com/v1/companies/${slug}/postings`,
    parseJobs: (data) => {
      const json = JSON.parse(data);
      return (json.content || []).map(j => ({
        title: j.name || '',
        location: j.location?.city || '',
        url: j.ref || '',
      }));
    },
    selectors: { job_card: '.opening-job', title: 'a', location: '.location', link: 'a' },
  },
  {
    name: 'BambooHR',
    detect: (url) => {
      const m = url.match(/(\w[\w-]*)\.bamboohr\.com/i);
      return m ? m[1] : null;
    },
    apiUrl: (slug) => `https://${slug}.bamboohr.com/careers/list`,
    parseJobs: (data) => {
      // BambooHR returns HTML, but the /list endpoint has JSON embedded
      // Try parsing as JSON first, fall back to regex
      try {
        const json = JSON.parse(data);
        return (json.result || []).map(j => ({
          title: j.jobOpeningName || '',
          location: j.location?.city || '',
          url: `https://${json.company || ''}.bamboohr.com/careers/${j.id}`,
        }));
      } catch {
        // Extract from HTML
        const matches = [...data.matchAll(/<a[^>]*href="(\/careers\/\d+)"[^>]*>([^<]+)/gi)];
        return matches.map(m => ({ title: m[2].trim(), location: '', url: m[1] }));
      }
    },
    selectors: { job_card: '.BambooHR-ATS-board__JobList-item', title: 'a', location: '.BambooHR-ATS-Location', link: 'a' },
  },
  {
    name: 'Recruitee',
    detect: (url) => {
      const m = url.match(/(\w[\w-]*)\.recruitee\.com/i);
      return m ? m[1] : null;
    },
    apiUrl: (slug) => `https://${slug}.recruitee.com/api/offers`,
    parseJobs: (data) => {
      const json = JSON.parse(data);
      return (json.offers || []).map(j => ({
        title: j.title || '',
        location: j.location || '',
        url: j.careers_url || '',
      }));
    },
    selectors: { job_card: '.offer', title: 'a', location: '.location', link: 'a' },
  },
  {
    name: 'Teamtailor',
    detect: (url) => {
      // Teamtailor uses custom domains, detect by header or known patterns
      const m = url.match(/(\w[\w-]*)\.teamtailor\.com/i);
      return m ? m[1] : null;
    },
    apiUrl: (slug) => `https://${slug}.teamtailor.com/jobs`,
    parseJobs: (data) => {
      // Teamtailor returns HTML; extract job links
      const matches = [...data.matchAll(/<a[^>]*href="(\/jobs\/\d+[^"]*)"[^>]*>[\s\S]*?<span[^>]*>([^<]+)/gi)];
      return matches.map(m => ({ title: m[2].trim(), location: '', url: m[1] }));
    },
    selectors: { job_card: 'li[class*="job"]', title: 'a span', location: '.location', link: 'a' },
  },
];

/**
 * Try to detect ATS from a URL string (careers_url or notes).
 * Returns { ats, slug } or null.
 */
function detectATS(url) {
  if (!url) return null;
  for (const ats of ATS_PATTERNS) {
    const slug = ats.detect(url);
    if (slug) return { ats, slug };
  }
  return null;
}

/**
 * Search the notes and selector_notes for ATS URLs we might have missed.
 */
function findATSInNotes(notes, selectorNotes) {
  const combined = `${notes || ''} ${selectorNotes || ''}`;
  const urlMatches = combined.match(/https?:\/\/[^\s"')>,]+/gi) || [];
  for (const url of urlMatches) {
    const result = detectATS(url);
    if (result) return { ...result, discoveredUrl: url };
  }
  return null;
}

/**
 * For unknown URLs, try a GET to detect if it redirects to a known ATS.
 */
async function probeForATS(url) {
  try {
    const res = await fetchHead(url);
    if (res.location) {
      const result = detectATS(res.location);
      if (result) return { ...result, discoveredUrl: res.location };
    }
    // Also try common career subpaths
    for (const path of ['/careers', '/jobs']) {
      try {
        const base = new URL(url.startsWith('http') ? url : `https://${url}`).origin;
        const probeRes = await fetchHead(base + path);
        if (probeRes.location) {
          const result = detectATS(probeRes.location);
          if (result) return { ...result, discoveredUrl: probeRes.location };
        }
      } catch {}
    }
  } catch {}
  return null;
}

/**
 * Fetch jobs from an ATS API.
 */
async function fetchATSJobs(ats, slug) {
  const url = ats.apiUrl(slug);

  if (ats.apiMethod === 'POST') {
    // Workable needs a POST with empty body
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const req = https.request({
        hostname: parsed.hostname,
        path: parsed.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode, data }));
      });
      req.on('error', reject);
      req.setTimeout(15000, () => req.destroy(new Error('timeout')));
      req.write(JSON.stringify({ query: '', location: '' }));
      req.end();
    });
  }

  return fetchJSON(url);
}

// ─── Neon DB helpers ─────────────────────────────────────────────────────────

async function claimNextCompany() {
  return withRetry(async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const statusFilter = INCLUDE_PROCESSED
        ? `status IN ('pending', 'done', 'failed')`
        : `status = 'pending'`;

      const { rows } = await client.query(`
        UPDATE companies
        SET status = 'processing', agent_id = $1, started_at = NOW(), updated_at = NOW()
        WHERE id = (
          SELECT id FROM companies
          WHERE ${statusFilter}
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
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });
}

async function updateCompanyResult(id, updates) {
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
        status = $11,
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
    updates.selector_confidence || 'unknown',
    updates.selector_notes || '',
    updates.enabled || 'false',
    updates.notes || '',
    updates.status || 'done',
  ]));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Missing DATABASE_URL in .env');
    process.exit(1);
  }

  const { rows: [{ count: totalCount }] } = await pool.query('SELECT COUNT(*) AS count FROM companies');
  console.log(`Connected to Neon. ${totalCount} companies in database.`);
  console.log(`Agent ID: ${AGENT_ID}`);

  const statusFilter = INCLUDE_PROCESSED
    ? `status IN ('pending', 'done', 'failed')`
    : `status = 'pending'`;
  const { rows: [{ count: pendingCount }] } = await pool.query(
    `SELECT COUNT(*) AS count FROM companies WHERE ${statusFilter} AND (enabled IS NULL OR LOWER(enabled) IN ('false', '0', 'disabled', 'no', ''))`
  );
  console.log(`Companies to process: ${pendingCount}`);

  let processed = 0, detected = 0, withJobs = 0, noATS = 0;
  const limit = SAMPLE > 0 ? SAMPLE : Infinity;

  while (processed < limit) {
    const row = await claimNextCompany();
    if (!row) {
      console.log('\nNo more companies to process.');
      break;
    }

    const name = row.company_name;
    const url = row.careers_url || '';
    console.log(`\n[${processed + 1}] ${name} — ${url}`);

    // Step 1: Try to detect ATS from careers_url
    let atsResult = detectATS(url);
    let source = 'careers_url';

    // Step 2: Check notes from previous Oxylabs run
    if (!atsResult) {
      atsResult = findATSInNotes(row.notes, row.selector_notes);
      if (atsResult) source = 'notes';
    }

    // Step 3: Probe the URL for redirects to ATS
    if (!atsResult && url && url.startsWith('http')) {
      console.log(`  → Probing for ATS redirect...`);
      atsResult = await probeForATS(url);
      if (atsResult) source = 'redirect';
    }

    if (!atsResult) {
      console.log(`  ✗ No ATS platform detected`);
      await updateCompanyResult(row.id, {
        ...row,
        selector_confidence: 'failed',
        selector_notes: `No known ATS platform detected via URL, notes, or redirect probe`,
        status: 'done',
      });
      noATS++;
      processed++;
      continue;
    }

    const { ats, slug, discoveredUrl } = atsResult;
    console.log(`  ✓ Detected: ${ats.name} (slug: ${slug}) via ${source}`);
    detected++;

    // Step 4: Hit the ATS API
    try {
      const response = await fetchATSJobs(ats, slug);
      let jobs = [];
      try {
        jobs = ats.parseJobs(response.data);
      } catch (parseErr) {
        console.log(`  ⚠ Parse error: ${parseErr.message}`);
      }

      const jobCount = jobs.length;
      const confidence = jobCount > 0 ? 'high' : 'medium';
      const apiUrl = ats.apiUrl(slug);
      const bestUrl = discoveredUrl || url;

      console.log(`  → ${jobCount} jobs found via API`);
      if (jobCount > 0) {
        console.log(`    Sample: ${jobs[0].title} — ${jobs[0].location}`);
        withJobs++;
      }

      await updateCompanyResult(row.id, {
        careers_url: bestUrl,
        job_card_selector: ats.selectors.job_card,
        title_selector: ats.selectors.title,
        location_selector: ats.selectors.location,
        link_selector: ats.selectors.link,
        selector_confidence: confidence,
        selector_notes: `${ats.name} ATS detected via ${source}. API: ${apiUrl} — ${jobCount} jobs found.`,
        enabled: jobCount > 0 ? 'true' : row.enabled,
        notes: row.notes || `${ats.name} ATS`,
        status: 'done',
      });

    } catch (err) {
      console.log(`  ✗ API error: ${err.message}`);
      await updateCompanyResult(row.id, {
        ...row,
        careers_url: discoveredUrl || url,
        selector_confidence: 'low',
        selector_notes: `${ats.name} detected via ${source}, but API call failed: ${err.message.slice(0, 100)}`,
        status: 'done',
      });
    }

    processed++;
    await sleep(DELAY_MS);
  }

  console.log('\n' + '='.repeat(60));
  console.log('Done!');
  console.log(`  Agent:       ${AGENT_ID}`);
  console.log(`  Processed:   ${processed}`);
  console.log(`  ATS found:   ${detected}`);
  console.log(`  With jobs:   ${withJobs}`);
  console.log(`  No ATS:      ${noATS}`);
  console.log('='.repeat(60));

  await pool.end();
}

main().catch(async (err) => {
  console.error('Fatal error:', err);
  await pool.end().catch(() => {});
  process.exit(1);
});

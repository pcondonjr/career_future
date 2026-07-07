/**
 * src/backend/discovery-shared.cjs
 *
 * Shared helpers for the company-discovery scripts (discover-companies.cjs,
 * discover-press-releases.cjs). Both follow the same Serper → Firecrawl →
 * Haiku → discovery_seen → companies pipeline; this module holds the parts
 * that are identical between them so the two scripts stay small and only
 * differ in their query sets and Haiku validation prompt.
 */

'use strict';

const nodemailer = require('nodemailer');

const SERPER_API = 'https://google.serper.dev/search';

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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractDomain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return null; }
}

function isATSDomain(url, atsDomains) {
  const domain = extractDomain(url) || '';
  for (const ats of atsDomains) {
    if (domain === ats || domain.endsWith('.' + ats)) return true;
  }
  return false;
}

// Return the best URL to scrape: prefer a /careers or /jobs path.
// If the given URL is already a career page, use it. Otherwise construct
// domain + /careers as a first attempt.
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

// ─── Serper ──────────────────────────────────────────────────────────────────

async function searchSerper(query, apiKey, { delayMs = 1500 } = {}) {
  const allItems = [];

  for (const page of [1, 2]) {
    let res, data;
    try {
      res  = await fetch(SERPER_API, {
        method:  'POST',
        headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
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
    await sleep(delayMs);
  }

  return allItems;
}

// ─── Firecrawl ───────────────────────────────────────────────────────────────

async function scrapeWithFirecrawl(firecrawl, url, maxChars = 8000) {
  const result = await firecrawl.v1.scrapeUrl(url, {
    formats: ['markdown'],
    waitFor: 4000,
    timeout: 25000,
  });
  if (!result.success) throw new Error(result.error || 'Firecrawl returned success=false');
  return (result.markdown || '').slice(0, maxChars);
}

// ─── Neon DB helpers ─────────────────────────────────────────────────────────

async function loadExistingNames(pool) {
  const { rows } = await pool.query(`SELECT LOWER(company_name) AS name FROM companies`);
  return new Set(rows.map(r => r.name));
}

async function loadExistingDomains(pool) {
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

// Domains already scraped+validated (accepted OR rejected) within the rescan
// window — skips re-spending Firecrawl/Haiku on a candidate that keeps
// resurfacing from the same Serper query every run. Shared across every
// discovery script so one worker's rejection also protects the others from
// re-checking the same domain.
async function loadSeenDomains(pool, maxAgeDays) {
  const { rows } = await pool.query(`
    SELECT domain, verdict, reason FROM discovery_seen
    WHERE checked_at > NOW() - INTERVAL '1 day' * $1
  `, [maxAgeDays]);
  return new Map(rows.map(r => [r.domain, r]));
}

async function markDomainSeen(pool, domain, verdict, reason, dryRun) {
  if (dryRun) return;
  await pool.query(`
    INSERT INTO discovery_seen (domain, checked_at, verdict, reason)
    VALUES ($1, NOW(), $2, $3)
    ON CONFLICT (domain) DO UPDATE SET checked_at = NOW(), verdict = EXCLUDED.verdict, reason = EXCLUDED.reason
  `, [domain, verdict, reason || null]);
}

async function insertCompany(pool, { company_name, careers_url, hq_city, hq_state, sourceLabel, source, dryRun }) {
  if (dryRun) return false;
  const noteParts = [hq_city, hq_state, sourceLabel].filter(Boolean);
  const notes = noteParts.join(' - ');
  const { rowCount } = await pool.query(`
    INSERT INTO companies (
      company_name, careers_url, enabled, notes, hq_state,
      source, scrape_status
    ) VALUES ($1, $2, FALSE, $3, $4, $5, 'pending_review')
    ON CONFLICT (company_name) DO NOTHING
  `, [company_name, careers_url, notes, hq_state ? hq_state.toUpperCase() : null, source]);
  return rowCount > 0;
}

// ─── Digest email ────────────────────────────────────────────────────────────
// Brief plain-text "tried / accomplished / missed" summary, reusing the same
// Gmail credentials as the existing emailer.js job-alert emails. Silently
// skipped if those env vars aren't set, so this never blocks a run.

async function sendDigestEmail(subject, summaryLines) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_APP_PASSWORD) {
    console.log('  (digest email skipped — EMAIL_USER/EMAIL_APP_PASSWORD not set)');
    return;
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_APP_PASSWORD },
  });

  const text = summaryLines.join('\n');
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const html = `<pre style="font-family: 'Consolas', monospace; font-size: 14px; white-space: pre-wrap;">${escaped}</pre>`;

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to:   process.env.EMAIL_USER,
      subject,
      text,
      html,
    });
    console.log('  Digest email sent.');
  } catch (err) {
    console.warn(`  ⚠️  Digest email failed: ${err.message}`);
  }
}

module.exports = {
  EST_STATES,
  sleep,
  extractDomain,
  isATSDomain,
  buildCareersUrl,
  searchSerper,
  scrapeWithFirecrawl,
  loadExistingNames,
  loadExistingDomains,
  loadSeenDomains,
  markDomainSeen,
  insertCompany,
  sendDigestEmail,
};

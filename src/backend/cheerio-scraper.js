/**
 * src/backend/cheerio-scraper.js
 *
 * Static-page career site scraper using Cheerio + node-fetch.
 * Runs before Puppeteer — cheap first pass, zero browser overhead.
 *
 * Returns a ScrapeResult object:
 *   { status, jobs, company_name, careers_url, reason }
 *
 * Status values:
 *   'ok'            — jobs array populated (may be empty = no openings)
 *   'ats_blocked'   — URL redirected or resolved to a known ATS domain
 *   'js_required'   — page loaded but no job cards found; likely needs browser
 *   'no_careers'    — 404, redirect to homepage, or empty page
 *   'error'         — fetch failed (timeout, DNS, etc.)
 *
 * Usage:
 *   import { scrapeCompany } from './cheerio-scraper.js';
 *   const result = await scrapeCompany(companyRow);
 */

import fetch from 'node-fetch';
import * as cheerio from 'cheerio';

// ── Constants ─────────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS  = 12_000;
const MAX_JOBS_PER_PAGE = 50;   // safety cap — if a page returns 200+ listings something is wrong

const ATS_DOMAIN_PATTERN = /greenhouse\.io|lever\.co|workday\.com|myworkdayjobs\.com|ashby\.com|workable\.com|icims\.com|taleo\.net|smartrecruiters\.com|bamboohr\.com|jazz\.co/i;

// Patterns that suggest a redirect landed on a homepage or error page
const DEAD_URL_PATTERN = /\/404|not-found|page-not-found|error/i;

// User-agent that looks like a real browser to avoid bot blocks
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── ATS detection ─────────────────────────────────────────────────────────────

function detectAtsPlatform(url = '') {
  const u = url.toLowerCase();
  if (u.includes('greenhouse'))       return 'greenhouse';
  if (u.includes('lever.co'))        return 'lever';
  if (u.includes('workday') || u.includes('myworkdayjobs')) return 'workday';
  if (u.includes('workable'))        return 'workable';
  if (u.includes('ashby'))           return 'ashby';
  if (u.includes('icims'))           return 'icims';
  if (u.includes('taleo'))           return 'taleo';
  if (u.includes('smartrecruiters')) return 'smartrecruiters';
  if (u.includes('bamboohr'))        return 'bamboohr';
  if (u.includes('jazz.co'))         return 'jazz';
  return 'unknown';
}

// ── Fetch with timeout ────────────────────────────────────────────────────────

async function fetchPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal:  controller.signal,
      headers: {
        'User-Agent':      UA,
        'Accept':          'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',   // follow up to 5 redirects by default
    });

    return {
      ok:          res.ok,
      status:      res.status,
      finalUrl:    res.url,   // URL after any redirects
      html:        res.ok ? await res.text() : '',
    };
  } catch (err) {
    if (err.name === 'AbortError') {
      return { ok: false, status: 0, finalUrl: url, html: '', error: 'timeout' };
    }
    return { ok: false, status: 0, finalUrl: url, html: '', error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

// ── Job extraction ────────────────────────────────────────────────────────────

function extractJobs($, row) {
  const jobs = [];

  // If no selectors configured, attempt a heuristic fallback
  const cardSel  = row.job_card_selector  || null;
  const titleSel = row.title_selector     || null;
  const locSel   = row.location_selector  || null;
  const linkSel  = row.link_selector      || null;

  if (!cardSel) {
    return { jobs: [], usedFallback: true };
  }

  const cards = $(cardSel);

  cards.each((i, el) => {
    if (i >= MAX_JOBS_PER_PAGE) return false; // break

    const $el = $(el);

    // Title
    let title = '';
    if (titleSel) {
      const titleEl = $el.find(titleSel).first();
      title = titleEl.text().trim() || titleEl.attr('title') || '';
    }
    if (!title) title = $el.find('h2, h3, h4, .title, .job-title').first().text().trim();
    if (!title) return; // skip cards with no title

    // Location
    let location = '';
    if (locSel) {
      location = $el.find(locSel).first().text().trim();
    }
    if (!location) location = $el.find('.location, [class*="location"], [class*="loc"]').first().text().trim();

    // Link
    let href = '';
    if (linkSel) {
      const linkEl = $el.find(linkSel).first();
      href = linkEl.attr('href') || linkEl.attr('data-href') || '';
    }
    if (!href) href = $el.find('a').first().attr('href') || '';

    // Resolve relative URLs
    if (href && href.startsWith('/')) {
      try {
        const base = new URL(row.careers_url);
        href = `${base.protocol}//${base.host}${href}`;
      } catch (_) { /* leave as-is */ }
    }

    jobs.push({ title, location: location || 'Not specified', url: href || '' });
  });

  return { jobs, usedFallback: false };
}

// ── Heuristic: did the page actually load a careers page? ─────────────────────

function looksLikeCareerPage(html, url) {
  if (!html || html.length < 500) return false;

  // Check for common careers-page signals in the HTML
  const lower = html.toLowerCase();
  const careerSignals = [
    'job', 'career', 'position', 'opening', 'role', 'hiring', 'apply',
    'full-time', 'part-time', 'remote', 'engineer', 'manager', 'analyst',
  ];
  const hitCount = careerSignals.filter(s => lower.includes(s)).length;
  return hitCount >= 3;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Scrape a single company's career page.
 *
 * @param {object} row  — a companies table row (or equivalent plain object)
 * @returns {ScrapeResult}
 */
export async function scrapeCompany(row) {
  const { company_name, careers_url } = row;

  // ── Pre-flight: ATS URL check (no fetch needed) ──────────────────────────
  if (ATS_DOMAIN_PATTERN.test(careers_url)) {
    return {
      status:       'ats_blocked',
      jobs:         [],
      company_name,
      careers_url,
      ats_platform: detectAtsPlatform(careers_url),
      reason:       'careers_url matches known ATS domain',
    };
  }

  // ── Fetch ────────────────────────────────────────────────────────────────
  const page = await fetchPage(careers_url);

  // Timeout or DNS failure
  if (page.error) {
    return {
      status:       'error',
      jobs:         [],
      company_name,
      careers_url,
      reason:       page.error,
    };
  }

  // Non-200 response
  if (!page.ok) {
    return {
      status:       'no_careers',
      jobs:         [],
      company_name,
      careers_url,
      reason:       `HTTP ${page.status}`,
    };
  }

  // ── Post-redirect ATS check ──────────────────────────────────────────────
  // The original URL may have been clean but redirected to an ATS
  if (page.finalUrl !== careers_url && ATS_DOMAIN_PATTERN.test(page.finalUrl)) {
    return {
      status:       'ats_blocked',
      jobs:         [],
      company_name,
      careers_url,
      final_url:    page.finalUrl,
      ats_platform: detectAtsPlatform(page.finalUrl),
      reason:       `redirected to ATS: ${page.finalUrl}`,
    };
  }

  // ── Dead URL check ───────────────────────────────────────────────────────
  if (DEAD_URL_PATTERN.test(page.finalUrl)) {
    return {
      status:       'no_careers',
      jobs:         [],
      company_name,
      careers_url,
      reason:       `redirect landed on error page: ${page.finalUrl}`,
    };
  }

  // ── Parse HTML ───────────────────────────────────────────────────────────
  const $ = cheerio.load(page.html);

  // Check for ATS iframes embedded in otherwise clean pages
  const iframeSrc = $('iframe[src]').map((_, el) => $(el).attr('src')).get().join(' ');
  if (ATS_DOMAIN_PATTERN.test(iframeSrc)) {
    const platform = detectAtsPlatform(iframeSrc);
    return {
      status:       'ats_blocked',
      jobs:         [],
      company_name,
      careers_url,
      ats_platform: platform,
      reason:       `page embeds ATS iframe (${platform})`,
    };
  }

  // ── Extract jobs ─────────────────────────────────────────────────────────
  const { jobs, usedFallback } = extractJobs($, row);

  // No job cards found — determine if JS-rendered or genuinely no openings
  if (jobs.length === 0) {
    const pageText = $('body').text();
    const noOpeningsSignals = [
      'no open positions', 'no current openings', 'no jobs available',
      'no roles available', 'check back', 'no postings',
    ];
    const hasNoOpeningsMsg = noOpeningsSignals.some(s =>
      pageText.toLowerCase().includes(s)
    );

    if (hasNoOpeningsMsg) {
      return {
        status:       'ok',
        jobs:         [],
        company_name,
        careers_url,
        reason:       'page explicitly says no openings',
      };
    }

    // No cards + no "no openings" message = probably JS-rendered
    if (!looksLikeCareerPage(page.html, careers_url)) {
      return {
        status:       'no_careers',
        jobs:         [],
        company_name,
        careers_url,
        reason:       'page loaded but does not look like a careers page',
      };
    }

    return {
      status:       'js_required',
      jobs:         [],
      company_name,
      careers_url,
      reason:       usedFallback
        ? 'no selectors configured and no cards found'
        : 'selectors found no cards — likely JS-rendered',
    };
  }

  // ── Success ──────────────────────────────────────────────────────────────
  return {
    status:       'ok',
    jobs,
    company_name,
    careers_url,
    reason:       null,
  };
}

/**
 * Scrape multiple companies with concurrency control and per-company logging.
 *
 * @param {object[]} rows       — array of company rows
 * @param {object}   options
 * @param {number}   options.concurrency  — parallel fetches (default 3)
 * @param {Function} options.onResult     — called after each company finishes
 * @returns {ScrapeResult[]}
 */
export async function scrapeAll(rows, { concurrency = 3, onResult } = {}) {
  const results  = [];
  const queue    = [...rows];
  const inFlight = new Set();

  async function runOne(row) {
    const result = await scrapeCompany(row);
    results.push(result);
    if (onResult) onResult(result);
    return result;
  }

  // Process with concurrency cap
  const chunks = [];
  for (let i = 0; i < rows.length; i += concurrency) {
    chunks.push(rows.slice(i, i + concurrency));
  }

  for (const chunk of chunks) {
    await Promise.all(chunk.map(row => runOne(row)));
  }

  return results;
}

// ── CLI test mode ─────────────────────────────────────────────────────────────
// Run directly to test against a single URL:
//   node src/backend/cheerio-scraper.js https://example.com/careers

if (process.argv[1] && process.argv[1].endsWith('cheerio-scraper.js')) {
  const testUrl = process.argv[2];
  if (!testUrl) {
    console.error('Usage: node src/backend/cheerio-scraper.js <careers_url>');
    console.error('       node src/backend/cheerio-scraper.js https://example.com/careers');
    process.exit(1);
  }

  console.log(`Testing: ${testUrl}\n`);
  scrapeCompany({
    company_name:        'CLI Test',
    careers_url:         testUrl,
    job_card_selector:   process.env.CF_CARD_SEL   || '',
    title_selector:      process.env.CF_TITLE_SEL  || '',
    location_selector:   process.env.CF_LOC_SEL    || '',
    link_selector:       process.env.CF_LINK_SEL   || '',
  }).then(result => {
    console.log('Status  :', result.status);
    console.log('Reason  :', result.reason || 'none');
    console.log('Jobs    :', result.jobs.length);
    if (result.jobs.length > 0) {
      console.log('\nFirst 5 jobs:');
      result.jobs.slice(0, 5).forEach((j, i) =>
        console.log(`  ${i+1}. ${j.title} | ${j.location} | ${j.url}`)
      );
    }
    if (result.ats_platform) {
      console.log('ATS     :', result.ats_platform);
    }
  }).catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}

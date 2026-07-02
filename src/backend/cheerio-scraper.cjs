/**
 * src/backend/cheerio-scraper.cjs
 *
 * Static-page career site scraper using Cheerio + Node built-in fetch.
 * No node-fetch needed — Node 18+ has fetch built in (you're on Node 24).
 * Uses require() throughout to match the project's existing .cjs pattern.
 *
 * Returns a ScrapeResult object:
 *   { status, jobs, company_name, careers_url, reason }
 *
 * Status values:
 *   'ok'            — scraped; jobs array has results (may be empty = no openings)
 *   'ats_blocked'   — URL resolved to a known ATS domain
 *   'js_required'   — page loaded but no cards found; likely needs Puppeteer
 *   'no_careers'    — 404, dead redirect, or not a careers page
 *   'error'         — fetch failed (timeout, DNS, etc.)
 *
 * CLI test:
 *   node src/backend/cheerio-scraper.cjs https://www.acstechnologies.com/careers/
 */

'use strict';

const cheerio = require('cheerio');

// ── Constants ─────────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS  = 12_000;
const MAX_JOBS_PER_PAGE = 50;

const ATS_DOMAIN_PATTERN = /greenhouse\.io|lever\.co|workday\.com|myworkdayjobs\.com|ashby\.com|workable\.com|icims\.com|taleo\.net|smartrecruiters\.com|bamboohr\.com|jazz\.co/i;
const DEAD_URL_PATTERN   = /\/404|not-found|page-not-found/i;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Helpers ───────────────────────────────────────────────────────────────────

function detectAtsPlatform(url = '') {
  const u = url.toLowerCase();
  if (u.includes('greenhouse'))        return 'greenhouse';
  if (u.includes('lever.co'))          return 'lever';
  if (u.includes('workday') || u.includes('myworkdayjobs')) return 'workday';
  if (u.includes('workable'))          return 'workable';
  if (u.includes('ashby'))             return 'ashby';
  if (u.includes('icims'))             return 'icims';
  if (u.includes('taleo'))             return 'taleo';
  if (u.includes('smartrecruiters'))   return 'smartrecruiters';
  if (u.includes('bamboohr'))          return 'bamboohr';
  if (u.includes('jazz.co'))           return 'jazz';
  return 'unknown';
}

async function fetchPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':      UA,
        'Accept':          'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });

    return {
      ok:       res.ok,
      status:   res.status,
      finalUrl: res.url,
      html:     res.ok ? await res.text() : '',
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

function extractJobs($, row) {
  const cardSel  = row.job_card_selector  || null;
  const titleSel = row.title_selector     || null;
  const locSel   = row.location_selector  || null;
  const linkSel  = row.link_selector      || null;

  if (!cardSel) {
    return { jobs: [], usedFallback: true };
  }

  const jobs  = [];
  const cards = $(cardSel);

  cards.each((i, el) => {
    if (i >= MAX_JOBS_PER_PAGE) return false;

    const $el = $(el);

    // Title
    let title = '';
    if (titleSel) {
      const titleEl = $el.find(titleSel).first();
      title = titleEl.text().trim() || titleEl.attr('title') || '';
    }
    if (!title) title = $el.find('h2,h3,h4,.title,.job-title').first().text().trim();
    if (!title) return;

    // Location
    let location = '';
    if (locSel) location = $el.find(locSel).first().text().trim();
    if (!location) location = $el.find('.location,[class*="location"],[class*="loc"]').first().text().trim();

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
      } catch (_) {}
    }

    jobs.push({ title, location: location || 'Not specified', url: href || '' });
  });

  return { jobs, usedFallback: false };
}

function looksLikeCareerPage(html) {
  if (!html || html.length < 500) return false;
  const lower = html.toLowerCase();
  const signals = ['job','career','position','opening','role','hiring','apply','full-time','remote','manager','analyst'];
  return signals.filter(s => lower.includes(s)).length >= 3;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function scrapeCompany(row) {
  const { company_name, careers_url } = row;

  // Pre-flight ATS check — no fetch needed
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

  const page = await fetchPage(careers_url);

  if (page.error) {
    return { status: 'error', jobs: [], company_name, careers_url, reason: page.error };
  }

  if (!page.ok) {
    return { status: 'no_careers', jobs: [], company_name, careers_url, reason: `HTTP ${page.status}` };
  }

  // Post-redirect ATS check
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

  if (DEAD_URL_PATTERN.test(page.finalUrl)) {
    return { status: 'no_careers', jobs: [], company_name, careers_url, reason: `dead redirect: ${page.finalUrl}` };
  }

  const $ = cheerio.load(page.html);

  // ATS iframe check
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

  const { jobs, usedFallback } = extractJobs($, row);

  if (jobs.length === 0) {
    const pageText = $('body').text().toLowerCase();
    const noOpenings = ['no open positions','no current openings','no jobs available','no roles available','check back later','no postings'];
    if (noOpenings.some(s => pageText.includes(s))) {
      return { status: 'ok', jobs: [], company_name, careers_url, reason: 'no openings message found' };
    }
    if (!looksLikeCareerPage(page.html)) {
      return { status: 'no_careers', jobs: [], company_name, careers_url, reason: 'does not look like a careers page' };
    }
    return {
      status:  'js_required',
      jobs:    [],
      company_name,
      careers_url,
      reason:  usedFallback ? 'no selectors configured' : 'selectors matched no cards — likely JS-rendered',
    };
  }

  return { status: 'ok', jobs, company_name, careers_url, reason: null };
}

async function scrapeAll(rows, { concurrency = 3, onResult } = {}) {
  const results = [];
  for (let i = 0; i < rows.length; i += concurrency) {
    const chunk = rows.slice(i, i + concurrency);
    const batch = await Promise.all(chunk.map(row => scrapeCompany(row)));
    batch.forEach(r => {
      results.push(r);
      if (onResult) onResult(r);
    });
  }
  return results;
}

module.exports = { scrapeCompany, scrapeAll };

// ── CLI test mode ─────────────────────────────────────────────────────────────

if (require.main === module) {
  const testUrl = process.argv[2];
  if (!testUrl) {
    console.error('Usage: node src/backend/cheerio-scraper.cjs <careers_url>');
    process.exit(1);
  }

  console.log(`Testing: ${testUrl}\n`);

  scrapeCompany({
    company_name:       'CLI Test',
    careers_url:        testUrl,
    job_card_selector:  process.env.CF_CARD_SEL  || '',
    title_selector:     process.env.CF_TITLE_SEL || '',
    location_selector:  process.env.CF_LOC_SEL   || '',
    link_selector:      process.env.CF_LINK_SEL  || '',
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
    if (result.ats_platform) console.log('ATS     :', result.ats_platform);
  }).catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}

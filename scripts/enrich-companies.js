#!/usr/bin/env node
/**
 * Bulk careers page discovery & CSS selector enrichment.
 *
 * Reads enriched-companies-0306.csv, discovers careers pages, maps known ATS
 * selectors, and appends new rows to data/companies-weekly.csv.
 *
 * Usage:
 *   node scripts/enrich-companies.js              # Run all phases
 *   node scripts/enrich-companies.js --phase1     # HTTP probing only
 *   node scripts/enrich-companies.js --phase2     # Puppeteer DOM analysis (needs phase1)
 *   node scripts/enrich-companies.js --phase3     # CSV output only
 *   node scripts/enrich-companies.js --resume     # Resume from checkpoint
 *   node scripts/enrich-companies.js --stats      # Show progress stats
 */
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse/sync';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// === File paths ===
const INPUT_CSV = path.join(ROOT, 'enriched-companies-0306.csv');
const WEEKLY_CSV = path.join(ROOT, 'data', 'companies-weekly.csv');
const DAILY_CSV = path.join(ROOT, 'data', 'companies.csv');
const PROGRESS_FILE = path.join(__dirname, 'enrich-progress.json');

// === Configuration ===
const CONCURRENCY = 5;
const HTTP_TIMEOUT = 10000;
const PUPPETEER_TIMEOUT = 30000;
const DELAY_BETWEEN_BATCHES = 300;
const DELAY_BETWEEN_PUPPETEER = 2000;

// === ATS Pattern Map ===
// Keys are hostname substrings — checked with url.hostname.includes(key)
const ATS_PATTERNS = {
  'boards.greenhouse.io':     { name: 'Greenhouse', card: '.opening', title: 'a', location: '.location', link: 'a' },
  'job-boards.greenhouse.io': { name: 'Greenhouse', card: '.opening', title: 'a', location: '.location', link: 'a' },
  'jobs.ashbyhq.com':         { name: 'Ashby', card: '.job-card', title: '[itemprop="title"]', location: '[itemprop="addressLocality"]', link: 'a' },
  'jobs.lever.co':            { name: 'Lever', card: '.posting', title: 'h5', location: '.sort-by-location', link: '.posting-title' },
  'apply.workable.com':       { name: 'Workable', card: '[data-ui="job"]', title: 'h3', location: '.job-details span', link: 'a' },
  'recruiting.paylocity.com': { name: 'Paylocity', card: '.job-listing-job-item', title: '.job-item-title a', location: '.location-column', link: '.job-item-title a' },
  'myworkdayjobs.com':        { name: 'Workday', card: '.css-19uc56f', title: '[data-automation-id="jobTitle"]', location: '.css-129m7dg', link: 'a' },
  'bamboohr.com':             { name: 'BambooHR', card: '.BambooHR-ATS-board__item', title: 'a', location: '.BambooHR-ATS-board__item--location', link: 'a' },
  'breezy.hr':                { name: 'Breezy HR', card: '.positions .position', title: 'h2', location: '.location', link: 'a' },
  'eightfold.ai':             { name: 'Eightfold', card: '.position-card', title: '.position-title', location: '.position-location', link: 'a' },
  'applytojob.com':           { name: 'JazzHR', card: '.resumator-job', title: '.resumator-job-title', location: '.resumator-job-location', link: 'a' },
  'icims.com':                { name: 'iCIMS', card: '.iCIMS_JobsTable .row', title: '.iCIMS_JobTitle', location: 'td.iCIMS_JobLocation', link: '.iCIMS_JobTitle a' },
  'smartrecruiters.com':      { name: 'SmartRecruiters', card: '.job-item', title: '.job-title', location: '.job-location', link: 'a' },
  'jobs.jobvite.com':         { name: 'Jobvite', card: '.jv-job-list-item', title: '.jv-job-list-name a', location: '.jv-job-list-location', link: '.jv-job-list-name a' },
  'pinpointhq.com':           { name: 'Pinpoint', card: '.opening', title: 'a', location: '.location', link: 'a' },
  'recruitee.com':            { name: 'Recruitee', card: '.opening', title: 'a', location: '.location', link: 'a' },
  'phenom.com':               { name: 'Phenom', card: '.jobs-list-item', title: '.job-title', location: '.job-location', link: '.job-title a' },
  'ultipro.com':              { name: 'UKG', card: '.opportunity', title: '.opportunity-title', location: '.opportunity-location', link: 'a' },
};

// === Career link discovery ===
const CAREER_LINK_RE = /href=["']([^"']*(?:career|jobs|join-us|work-with-us|openings|hiring|opportunities|employment|join-our-team|current-openings|open-positions|vacancies)[^"']*)["']/gi;

const CAREER_PATHS = [
  '/careers', '/jobs', '/about/careers', '/company/careers',
  '/join-us', '/work-with-us', '/about/jobs', '/en/careers',
  '/us/careers', '/open-positions', '/job-openings',
];

// ============================================================
// Utility helpers
// ============================================================
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function normalizeUrl(raw) {
  let url = raw.trim();
  // Force https
  url = url.replace(/^http:\/\//, 'https://');
  if (!url.startsWith('https://')) url = 'https://' + url;
  // Remove trailing slash for consistency
  return url.replace(/\/+$/, '');
}

async function safeFetch(url, opts = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeout || HTTP_TIMEOUT);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        ...(opts.headers || {}),
      },
    });
    return res;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function matchAts(urlStr) {
  try {
    const u = new URL(urlStr);
    for (const [pattern, selectors] of Object.entries(ATS_PATTERNS)) {
      if (u.hostname.includes(pattern)) return selectors;
    }
  } catch { /* ignore */ }
  return null;
}

// ============================================================
// Data loading
// ============================================================
async function loadInputCSV() {
  const content = await fsp.readFile(INPUT_CSV, 'utf-8');
  const records = parse(content, { columns: true, skip_empty_lines: true, relax_column_count: true });
  return records
    .filter(r => r['Website'] && r['Website'].trim())
    .map(r => ({
      companyName: (r['Company Name-Apollo'] || r['Company Name'] || '').replace(/-Apollo$/, '').trim(),
      website: normalizeUrl(r['Website']),
      city: (r['Company City'] || '').trim(),
      state: (r['Company State'] || '').trim(),
      employees: (r['# Employees'] || '').trim(),
    }));
}

async function loadExistingNames(csvPath) {
  try {
    const content = await fsp.readFile(csvPath, 'utf-8');
    const names = new Set();
    for (const line of content.split('\n')) {
      if (line.startsWith('#') || line.startsWith('company_name')) continue;
      const name = line.split(',')[0].trim().toLowerCase();
      if (name) names.add(name);
    }
    return names;
  } catch { return new Set(); }
}

async function loadProgress() {
  try {
    const data = JSON.parse(await fsp.readFile(PROGRESS_FILE, 'utf-8'));
    return data;
  } catch { return null; }
}

async function saveProgress(data) {
  data.lastUpdated = new Date().toISOString();
  await fsp.writeFile(PROGRESS_FILE, JSON.stringify(data, null, 2));
}

// ============================================================
// Phase 1: HTTP Probing
// ============================================================
async function probeCompany(company) {
  const result = {
    companyName: company.companyName,
    website: company.website,
    city: company.city,
    state: company.state,
    employees: company.employees,
    careersUrl: null,
    phase1Status: 'homepage_only',
    atsName: null,
    selectors: null,
    errorMessage: null,
  };

  // Step 1: GET homepage, scan for career links
  try {
    const res = await safeFetch(company.website);
    if (res && res.ok) {
      const html = await res.text();
      const matches = [...html.matchAll(CAREER_LINK_RE)];
      if (matches.length > 0) {
        // Pick the best match — prefer one with /careers or /jobs in it
        let bestHref = matches[0][1];
        for (const m of matches) {
          if (/\/careers|\/jobs/i.test(m[1])) { bestHref = m[1]; break; }
        }
        // Resolve relative URLs
        try {
          const resolved = new URL(bestHref, company.website).href;
          result.careersUrl = resolved;
        } catch {
          result.careersUrl = bestHref;
        }
      }
    }
  } catch (err) {
    result.errorMessage = err.message;
    result.phase1Status = 'error';
    return result;
  }

  // Step 2: If no link found, try common paths
  if (!result.careersUrl) {
    for (const p of CAREER_PATHS) {
      const tryUrl = company.website + p;
      const res = await safeFetch(tryUrl, { method: 'HEAD' });
      if (res && (res.ok || res.status === 301 || res.status === 302)) {
        result.careersUrl = res.url || tryUrl;
        break;
      }
      // Fallback: some servers reject HEAD
      if (res && res.status === 405) {
        const getRes = await safeFetch(tryUrl);
        if (getRes && getRes.ok) {
          result.careersUrl = getRes.url || tryUrl;
          break;
        }
      }
    }
  }

  if (!result.careersUrl) {
    result.phase1Status = 'homepage_only';
    return result;
  }

  // Step 3: Check if careers URL matches a known ATS
  const ats = matchAts(result.careersUrl);
  if (ats) {
    result.phase1Status = 'ats_matched';
    result.atsName = ats.name;
    result.selectors = { card: ats.card, title: ats.title, location: ats.location, link: ats.link };
  } else {
    result.phase1Status = 'careers_found';
  }

  return result;
}

async function runPhase1(companies, progress) {
  const results = progress.results || [];
  const done = new Set(results.map(r => r.companyName.toLowerCase()));
  const remaining = companies.filter(c => !done.has(c.companyName.toLowerCase()));

  console.log(`\n=== Phase 1: HTTP Probing ===`);
  console.log(`Total: ${companies.length} | Already done: ${done.size} | Remaining: ${remaining.length}\n`);

  for (let i = 0; i < remaining.length; i += CONCURRENCY) {
    const batch = remaining.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(c => probeCompany(c)));
    results.push(...batchResults);

    // Progress log
    const total = results.length;
    const matched = results.filter(r => r.phase1Status === 'ats_matched').length;
    const found = results.filter(r => r.phase1Status === 'careers_found').length;
    const errors = results.filter(r => r.phase1Status === 'error').length;
    process.stdout.write(`\r  [${total}/${companies.length}] ATS: ${matched} | Careers: ${found} | Homepage only: ${total - matched - found - errors} | Errors: ${errors}`);

    // Save checkpoint every 25 companies
    if (total % 25 < CONCURRENCY) {
      progress.results = results;
      await saveProgress(progress);
    }

    if (i + CONCURRENCY < remaining.length) await delay(DELAY_BETWEEN_BATCHES);
  }

  progress.results = results;
  progress.phase1Complete = true;
  await saveProgress(progress);
  console.log('\n  Phase 1 complete. Checkpoint saved.\n');
  return results;
}

// ============================================================
// Phase 2: Puppeteer DOM Analysis
// ============================================================
function findChrome() {
  const candidates = [
    path.join(process.env['PROGRAMFILES'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['LOCALAPPDATA'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env['PROGRAMFILES'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return null;
}

// Reuses the evaluate logic from scripts/inspect-site.js
async function analyzeCareersDom(page, url) {
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: PUPPETEER_TIMEOUT });
    await delay(3000);
  } catch {
    return null;
  }

  return await page.evaluate(() => {
    const info = {};
    const cls = el => (typeof el.className === 'string' ? el.className : el.getAttribute?.('class') || '');

    // Job links
    const jobLinks = document.querySelectorAll('a[href*="/jobs/"], a[href*="/job/"], a[href*="/careers/"], a[href*="/position"]');
    info.jobLinksCount = jobLinks.length;
    info.jobLinkSamples = Array.from(jobLinks).slice(0, 6).map(a => ({
      href: a.getAttribute('href'),
      text: a.textContent.trim().substring(0, 100),
      class: cls(a).substring(0, 80),
      parentTag: a.parentElement?.tagName,
      parentClass: cls(a.parentElement || {}).substring(0, 80),
    }));

    // Repeating containers (likely job lists)
    const allEls = document.querySelectorAll('div, ul, ol, section');
    const repeating = [];
    for (const el of allEls) {
      if (el.children.length >= 3) {
        const childClasses = Array.from(el.children).map(c => c.className).filter(Boolean);
        const uniqueChildClasses = [...new Set(childClasses)];
        if (uniqueChildClasses.length === 1 && childClasses.length >= 3) {
          repeating.push({
            tag: el.tagName, class: cls(el).substring(0, 80),
            childCount: el.children.length,
            childTag: el.children[0].tagName,
            childClass: cls(el.children[0]).substring(0, 80),
            sampleText: el.children[0].textContent.trim().substring(0, 120),
          });
        }
      }
    }
    info.repeatingContainers = repeating.slice(0, 8);

    // Sample cards from best container
    if (repeating.length > 0) {
      const best = repeating.sort((a, b) => b.childCount - a.childCount)[0];
      const firstClass = best.class.split(' ')[0];
      const selector = firstClass ? best.tag + '.' + firstClass : best.tag;
      const container = document.querySelector(selector);
      if (container) {
        info.sampleCards = Array.from(container.children).slice(0, 3).map(card => ({
          fullText: card.innerText.substring(0, 200),
          links: Array.from(card.querySelectorAll('a')).map(a => ({
            href: a.getAttribute('href'), text: a.textContent.trim().substring(0, 80),
          })),
          headings: Array.from(card.querySelectorAll('h1,h2,h3,h4,h5')).map(h => ({
            tag: h.tagName, class: cls(h).substring(0, 60), text: h.textContent.trim().substring(0, 80),
          })),
          spans: Array.from(card.querySelectorAll('span, p, div')).map(s => ({
            class: cls(s).substring(0, 60), text: s.textContent.trim().substring(0, 80),
          })).filter(s => s.text && s.text.length < 60), // likely metadata, not long descriptions
        }));
      }
    }

    return info;
  });
}

function inferSelectors(analysis) {
  if (!analysis || !analysis.repeatingContainers || analysis.repeatingContainers.length === 0) {
    return null;
  }

  // Pick best container — prefer one whose child class contains job-related words
  const jobKeywords = ['job', 'card', 'listing', 'posting', 'position', 'opening', 'result', 'item'];
  let best = analysis.repeatingContainers[0];
  for (const c of analysis.repeatingContainers) {
    const lc = (c.childClass || '').toLowerCase();
    if (jobKeywords.some(k => lc.includes(k))) { best = c; break; }
  }

  const childClass = (best.childClass || '').split(' ')[0].replace(/[\n\r"',]/g, '').trim();
  const card = (childClass && childClass.length > 1) ? '.' + childClass : best.childTag.toLowerCase();

  // Infer title: first heading or first link in sample cards
  let title = 'a';
  let location = '.location';
  let link = 'a';

  if (analysis.sampleCards && analysis.sampleCards.length > 0) {
    const sample = analysis.sampleCards[0];
    if (sample.headings && sample.headings.length > 0) {
      const h = sample.headings[0];
      const hClass = (h.class || '').split(' ')[0].replace(/[\n\r"',]/g, '').trim();
      title = hClass && hClass.length > 1 ? h.tag.toLowerCase() + '.' + hClass : h.tag.toLowerCase();
    }
    // Look for location-like spans
    if (sample.spans) {
      const locSpan = sample.spans.find(s =>
        /location|city|region|remote|office/i.test(s.class) ||
        /,\s*[A-Z]{2}/.test(s.text) // "City, ST" pattern
      );
      if (locSpan && locSpan.class) {
        const locClass = locSpan.class.split(' ')[0].replace(/[\n\r"',]/g, '').trim();
        if (locClass && locClass.length > 1) location = '.' + locClass;
      }
    }
    if (sample.links && sample.links.length > 0) {
      link = 'a';
    }
  }

  return { card, title, location, link };
}

async function runPhase2(progress) {
  const results = progress.results;
  const needsAnalysis = results.filter(r => r.phase1Status === 'careers_found' && !r.phase2Status);

  console.log(`\n=== Phase 2: Puppeteer DOM Analysis ===`);
  console.log(`Companies needing analysis: ${needsAnalysis.length}\n`);

  if (needsAnalysis.length === 0) {
    console.log('  Nothing to analyze.\n');
    progress.phase2Complete = true;
    await saveProgress(progress);
    return;
  }

  const chromePath = findChrome();
  if (!chromePath) {
    console.error('  No Chrome/Edge found. Skipping Phase 2.');
    progress.phase2Complete = true;
    await saveProgress(progress);
    return;
  }

  const puppeteer = (await import('puppeteer-core')).default;
  let browser = await puppeteer.launch({
    headless: 'new',
    executablePath: chromePath,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  let page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
  // Block images/fonts/css for speed
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort();
    else req.continue();
  });

  let processed = 0;
  for (const entry of needsAnalysis) {
    processed++;
    process.stdout.write(`\r  [${processed}/${needsAnalysis.length}] Analyzing: ${entry.companyName.substring(0, 40).padEnd(40)}`);

    try {
      const analysis = await analyzeCareersDom(page, entry.careersUrl);
      const selectors = inferSelectors(analysis);
      if (selectors) {
        entry.phase2Status = 'selectors_inferred';
        entry.selectors = selectors;
      } else {
        entry.phase2Status = 'needs_manual_review';
      }
    } catch (err) {
      entry.phase2Status = 'error';
      entry.errorMessage = (entry.errorMessage || '') + ' | Phase2: ' + err.message;

      // Restart browser on crash
      try { await browser.close(); } catch { /* ignore */ }
      browser = await puppeteer.launch({
        headless: 'new', executablePath: chromePath,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      });
      page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
      await page.setRequestInterception(true);
      page.on('request', req => {
        if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) req.abort();
        else req.continue();
      });
    }

    // Save checkpoint every 10 companies
    if (processed % 10 === 0) {
      await saveProgress(progress);
    }

    await delay(DELAY_BETWEEN_PUPPETEER);
  }

  try { await browser.close(); } catch { /* ignore */ }

  progress.phase2Complete = true;
  await saveProgress(progress);
  console.log('\n  Phase 2 complete. Checkpoint saved.\n');
}

// ============================================================
// Phase 3: CSV Output
// ============================================================
function escapeCsvField(val) {
  if (!val) return '';
  val = String(val);
  if (val.includes(',') || val.includes('"') || val.includes('\n')) {
    return '"' + val.replace(/"/g, '""') + '"';
  }
  return val;
}

function buildNote(entry) {
  const parts = [];
  if (entry.city) parts.push(entry.city);
  if (entry.state) parts.push(entry.state);
  if (entry.employees) parts.push(entry.employees + ' employees');
  if (entry.atsName) parts.push(entry.atsName + ' ATS');
  else if (entry.phase2Status === 'selectors_inferred') parts.push('Auto-detected selectors - needs verification');
  else if (entry.phase1Status === 'homepage_only') parts.push('No careers page found');
  else if (entry.phase2Status === 'needs_manual_review') parts.push('Needs manual review');
  else if (entry.phase1Status === 'error') parts.push('Error: ' + (entry.errorMessage || 'unknown'));

  // Flag international
  const US_STATES = new Set([
    'alabama','alaska','arizona','arkansas','california','colorado','connecticut','delaware',
    'florida','georgia','hawaii','idaho','illinois','indiana','iowa','kansas','kentucky',
    'louisiana','maine','maryland','massachusetts','michigan','minnesota','mississippi',
    'missouri','montana','nebraska','nevada','new hampshire','new jersey','new mexico',
    'new york','north carolina','north dakota','ohio','oklahoma','oregon','pennsylvania',
    'rhode island','south carolina','south dakota','tennessee','texas','utah','vermont',
    'virginia','washington','west virginia','wisconsin','wyoming',
    'district of columbia',
  ]);
  if (entry.state && !US_STATES.has(entry.state.toLowerCase())) {
    parts.push('International');
  }

  return parts.join(' - ');
}

function isUSCompany(entry) {
  const US_STATES = new Set([
    'alabama','alaska','arizona','arkansas','california','colorado','connecticut','delaware',
    'florida','georgia','hawaii','idaho','illinois','indiana','iowa','kansas','kentucky',
    'louisiana','maine','maryland','massachusetts','michigan','minnesota','mississippi',
    'missouri','montana','nebraska','nevada','new hampshire','new jersey','new mexico',
    'new york','north carolina','north dakota','ohio','oklahoma','oregon','pennsylvania',
    'rhode island','south carolina','south dakota','tennessee','texas','utah','vermont',
    'virginia','washington','west virginia','wisconsin','wyoming',
    'district of columbia',
  ]);
  return !entry.state || US_STATES.has(entry.state.toLowerCase());
}

async function runPhase3(progress) {
  const results = progress.results;

  // Load existing company names to skip
  const weeklyNames = await loadExistingNames(WEEKLY_CSV);
  const dailyNames = await loadExistingNames(DAILY_CSV);

  console.log(`\n=== Phase 3: CSV Output ===`);
  console.log(`Existing weekly: ${weeklyNames.size} | Existing daily: ${dailyNames.size}\n`);

  const PLACEHOLDER = { card: '.job-card', title: 'h3', location: '.location', link: 'a' };
  const newRows = [];

  for (const entry of results) {
    // Skip duplicates
    if (weeklyNames.has(entry.companyName.toLowerCase())) continue;
    if (dailyNames.has(entry.companyName.toLowerCase())) continue;

    const selectors = entry.selectors || PLACEHOLDER;
    const careersUrl = entry.careersUrl || entry.website;
    const isUS = isUSCompany(entry);

    // Enabled only if ATS matched AND US-based
    const enabled = entry.phase1Status === 'ats_matched' && isUS;

    const row = [
      escapeCsvField(entry.companyName),
      escapeCsvField(careersUrl),
      escapeCsvField(selectors.card),
      escapeCsvField(selectors.title),
      escapeCsvField(selectors.location),
      escapeCsvField(selectors.link),
      enabled ? 'true' : 'false',
      escapeCsvField(buildNote(entry)),
    ].join(',');

    newRows.push(row);
  }

  console.log(`  New rows to append: ${newRows.length}`);
  const enabledCount = newRows.filter(r => r.includes(',true,')).length;
  console.log(`  Enabled (ATS matched + US): ${enabledCount}`);
  console.log(`  Disabled (needs review): ${newRows.length - enabledCount}\n`);

  if (newRows.length > 0) {
    await fsp.appendFile(WEEKLY_CSV, '\n' + newRows.join('\n'));
    console.log(`  Appended ${newRows.length} rows to data/companies-weekly.csv\n`);
  } else {
    console.log('  Nothing to append.\n');
  }

  progress.phase3Complete = true;
  await saveProgress(progress);
}

// ============================================================
// Stats
// ============================================================
function showStats(progress) {
  const results = progress.results || [];
  const atsMatched = results.filter(r => r.phase1Status === 'ats_matched');
  const careersFound = results.filter(r => r.phase1Status === 'careers_found');
  const homepageOnly = results.filter(r => r.phase1Status === 'homepage_only');
  const errors = results.filter(r => r.phase1Status === 'error');

  console.log('\n=== Enrichment Progress ===');
  console.log(`Last updated: ${progress.lastUpdated || 'never'}`);
  console.log(`Phase 1: ${progress.phase1Complete ? 'COMPLETE' : 'INCOMPLETE'}`);
  console.log(`Phase 2: ${progress.phase2Complete ? 'COMPLETE' : 'INCOMPLETE'}`);
  console.log(`Phase 3: ${progress.phase3Complete ? 'COMPLETE' : 'INCOMPLETE'}`);
  console.log(`\nTotal companies: ${results.length}`);
  console.log(`  ATS matched:    ${atsMatched.length}`);
  console.log(`  Careers found:   ${careersFound.length}`);
  console.log(`  Homepage only:   ${homepageOnly.length}`);
  console.log(`  Errors:          ${errors.length}`);

  // ATS breakdown
  if (atsMatched.length > 0) {
    console.log('\nATS Breakdown:');
    const byAts = {};
    for (const r of atsMatched) {
      byAts[r.atsName] = (byAts[r.atsName] || 0) + 1;
    }
    for (const [name, count] of Object.entries(byAts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${name}: ${count}`);
    }
  }

  // Phase 2 breakdown
  const inferred = results.filter(r => r.phase2Status === 'selectors_inferred').length;
  const manual = results.filter(r => r.phase2Status === 'needs_manual_review').length;
  if (inferred || manual) {
    console.log(`\nPhase 2 Results:`);
    console.log(`  Selectors inferred: ${inferred}`);
    console.log(`  Needs manual review: ${manual}`);
  }

  console.log('');
}

// ============================================================
// Main
// ============================================================
async function main() {
  const args = process.argv.slice(2);
  const flag = args[0] || '';

  let progress = await loadProgress() || { results: [] };

  if (flag === '--stats') {
    showStats(progress);
    return;
  }

  // Load input data
  const allCompanies = await loadInputCSV();
  const weeklyNames = await loadExistingNames(WEEKLY_CSV);
  const dailyNames = await loadExistingNames(DAILY_CSV);
  const companies = allCompanies.filter(c =>
    !weeklyNames.has(c.companyName.toLowerCase()) &&
    !dailyNames.has(c.companyName.toLowerCase())
  );

  console.log(`Loaded ${allCompanies.length} companies from enriched CSV`);
  console.log(`Skipping ${allCompanies.length - companies.length} already in weekly/daily CSV`);
  console.log(`Processing ${companies.length} new companies`);

  const runAll = !flag || flag === '--resume';
  const resuming = flag === '--resume';

  if (flag === '--phase1' || runAll) {
    await runPhase1(companies, progress);
  }

  if (flag === '--phase2' || runAll) {
    if (!progress.phase1Complete) {
      console.error('Phase 1 not complete. Run --phase1 first.');
      return;
    }
    await runPhase2(progress);
  }

  if (flag === '--phase3' || runAll) {
    await runPhase3(progress);
  }

  showStats(progress);
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});

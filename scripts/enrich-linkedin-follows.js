/**
 * enrich-linkedin-follows.js
 *
 * 4-phase pipeline to discover career pages and CSS selectors for LinkedIn
 * followed companies, then append results to companies-weekly.csv.
 *
 * Phase 1: Filter — remove non-employers, already-listed, tiny trade shops
 * Phase 2: Serper API — batch search for career page URLs
 * Phase 3: Puppeteer — discover career pages for companies where Serper missed
 * Phase 4: Puppeteer — detect CSS selectors on each career page
 *
 * Usage:
 *   node scripts/enrich-linkedin-follows.js [--dry-run] [--limit N] [--skip-phase4]
 */

import dotenv from 'dotenv';
dotenv.config();

import puppeteer from 'puppeteer-core';
import { parse } from 'csv-parse/sync';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import path from 'path';

// ─── Config ──────────────────────────────────────────────────────────────────

const SERPER_API = 'https://google.serper.dev/search';
const SERPER_API_KEY = process.env.SERPER_API_KEY;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SKIP_PHASE4 = args.includes('--skip-phase4');
const LIMIT = (() => {
  const idx = args.indexOf('--limit');
  return idx !== -1 ? parseInt(args[idx + 1], 10) : 0;
})();

// ─── Helpers ─────────────────────────────────────────────────────────────────

function findChrome() {
  const candidates = [
    path.join(process.env['PROGRAMFILES'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['LOCALAPPDATA'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env['PROGRAMFILES'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function csvEscape(val) {
  if (!val) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ─── Phase 1: Filter ─────────────────────────────────────────────────────────

// Companies that are not actual employers (AI tools, newsletters, communities,
// learning platforms, staffing agencies, Salesforce consultancies < 20 people)
const SKIP_PATTERNS = [
  // AI / tools / media / communities
  /chatgpt|claude\b|openai|microsoft copilot|microsoft developer|microsoft 365/i,
  /grok conference|ai central|neuron.*ai|playwright|slack\b|nebula logger/i,
  /naukri|shine\.com|xelplus|the crm success|get force certified/i,
  /ayan insights|feedcoyote|the nonprofit hive|the referral bench/i,
  /upstate upstarts|user stories|confidential careers|p\.a\.w\. journey/i,
  /remote climate|early exit club|flight levels academy|the drip\b/i,
  /firecrawl|fathom\.ai|plenteous\.ai|testsigma|bast ai/i,
  /genai works|supermoon ai|knowcloudai|slip robotics/i,
  // Staffing / recruiting firms (they post other companies' jobs)
  /addison group|collabera|cynet systems|revature|ledgent technology/i,
  /k2 partnering|optomi|ringside talent|james search group/i,
  /stellar professionals|jcw\b|jcw group|liberty personnel|talent navigator/i,
  /kastech canada|programmers\.io|spar information|resolution technologies/i,
  // Very small Salesforce consultancies / solo shops
  /beyond the cloud|bluecloud|bluestone solutions|canvas cloud/i,
  /cloudcrest consulting|cloudhound|creech computer|db services/i,
  /digitalthinker|dryad consulting|ehana|enstrapp|fullerfied/i,
  /left main rei|logicle analytics|lucidware|magic button labs/i,
  /mk partners|mogli|orange bees|percolator consulting/i,
  /plumlogix|radianhub|rotive|saprex|shandoka|shujaa/i,
  /trustrive|waterbird consulting|watt hamlett/i,
  /retentional|scopestack|s-docs|techidmanager/i,
  // Tiny local trade / construction / manufacturing with no career pages
  /acree oil|alfmeier|all skilled construction|amamco tool/i,
  /arcpoint labs|avalon inspections|buckeye fire|carson.s nut/i,
  /cline hose|dave steel|deltec homes|diamond brand/i,
  /diversified coatings|ditch witch|eldeco|embtrak/i,
  /emory electric|golden strip glass|hodge floors|homesource/i,
  /h&w electrical|hw resources|jettons grading|jocassee/i,
  /km fabrics|kings mountain|kingsway international/i,
  /maintenance & inspection|morris business|multi-pack/i,
  /new south construction|oconee federal|olive manufacturing/i,
  /patriot healthcare|premierepc|prestige subaru/i,
  /promotions unlimited|refrigerated solutions|sermonaudio/i,
  /sfrep|shibumi shade|sparks research|stark rfid/i,
  /strong missions|susu lend|tax titans|taylors windows/i,
  /viatec|wilkins communication|wj partners/i,
  /james g\. murphy|imagemark|iconoclast brand/i,
  /hombolt|innovative solar|integrated micro/i,
  /investinet|inveterate|itnamerica/i,
  /palmetto digital|package insight|redhype/i,
  /sms-chemicals|soteria community|tm floyd/i,
  /münich composites|munich composites/i,
  // PMI chapters / sports / non-hiring entities
  /pmi palmetto|boyd cycling|city club of greenville/i,
  /craft axe throwing|camp greystone/i,
  // Non-US / irrelevant
  /avvio part of shr|adbakx|arnex solutions/i,
];

function shouldSkip(name) {
  return SKIP_PATTERNS.some(p => p.test(name));
}

function loadExistingCompanies() {
  const names = new Set();
  for (const file of ['data/companies.csv', 'data/companies-weekly.csv']) {
    if (!existsSync(file)) continue;
    const lines = readFileSync(file, 'utf-8').split('\n').slice(1); // skip header
    for (const line of lines) {
      if (!line.trim()) continue;
      // Extract company_name (first field) — handle quoted names
      let name;
      if (line.startsWith('"')) {
        const endQuote = line.indexOf('",', 1);
        name = endQuote > 0 ? line.substring(1, endQuote) : line.substring(1);
      } else {
        name = line.split(',')[0];
      }
      if (name) names.add(name.toLowerCase().trim());
    }
  }
  return names;
}

// ─── Phase 2: Serper API search ──────────────────────────────────────────────

async function searchCareersUrl(companyName) {
  if (!SERPER_API_KEY) return null;

  try {
    const res = await fetch(SERPER_API, {
      method: 'POST',
      headers: { 'X-API-KEY': SERPER_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: `"${companyName}" careers jobs`, num: 5 }),
    });

    if (res.status === 429) {
      console.warn('  !! Serper quota exceeded — stopping API searches');
      return 'QUOTA_EXCEEDED';
    }
    if (!res.ok) return null;

    const data = await res.json();
    if (!data.organic || data.organic.length === 0) return null;

    // Look for career-related URLs in results
    const careerPatterns = /\/careers|\/jobs|\/job-openings|\/open-positions|\/work-with-us|\/join|\/employment|\/hiring|greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|bamboohr\.com|myworkdayjobs\.com|icims\.com|jobvite\.com|ultipro\.com|paycomonline\.net|paylocity\.com|smartrecruiters\.com|breezy\.hr|applytojob\.com/i;

    // Priority 1: Direct career/ATS URL
    for (const item of data.organic) {
      if (careerPatterns.test(item.link)) {
        return { careersUrl: item.link, website: new URL(item.link).origin, source: 'serper-careers' };
      }
    }

    // Priority 2: Company homepage (we'll discover careers page in Phase 3)
    const firstResult = data.organic[0];
    const domain = new URL(firstResult.link).origin;

    // Skip LinkedIn, Wikipedia, Facebook, etc.
    if (/linkedin\.com|wikipedia\.org|facebook\.com|yelp\.com|glassdoor|indeed\.com|crunchbase/i.test(domain)) {
      // Try second result
      if (data.organic.length > 1) {
        const second = data.organic[1];
        const domain2 = new URL(second.link).origin;
        if (!/linkedin\.com|wikipedia\.org|facebook\.com|yelp\.com|glassdoor|indeed\.com|crunchbase/i.test(domain2)) {
          return { careersUrl: null, website: domain2, source: 'serper-homepage' };
        }
      }
      return null;
    }

    return { careersUrl: null, website: domain, source: 'serper-homepage' };
  } catch (err) {
    console.warn(`  !! Serper error: ${err.message}`);
    return null;
  }
}

// ─── Phase 3: Puppeteer career page discovery ────────────────────────────────

const CAREER_KEYWORDS = ['career', 'careers', 'jobs', 'job', 'work-with-us', 'join-us', 'join-our-team', 'employment', 'hiring', 'opportunities', 'open-positions'];

async function discoverCareersPage(browser, website) {
  const page = await browser.newPage();
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (['image', 'font', 'media'].includes(req.resourceType())) req.abort();
      else req.continue();
    });

    await page.goto(website, { waitUntil: 'domcontentloaded', timeout: 15000 });

    // Look for career links on the page
    const careerLink = await page.evaluate((keywords) => {
      const links = Array.from(document.querySelectorAll('a[href]'));
      for (const link of links) {
        const href = link.href.toLowerCase();
        const text = link.textContent.toLowerCase().trim();
        for (const kw of keywords) {
          if (href.includes('/' + kw) || text === kw || text === kw + 's') {
            return link.href;
          }
        }
      }
      return null;
    }, CAREER_KEYWORDS);

    if (careerLink) return careerLink;

    // Try common paths
    for (const p of ['/careers', '/jobs', '/about/careers', '/company/careers', '/join-us', '/open-positions']) {
      try {
        const testUrl = new URL(p, website).href;
        const response = await page.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: 8000 });
        if (response && response.status() === 200) return testUrl;
      } catch { /* path doesn't exist */ }
    }

    return null;
  } catch {
    return null;
  } finally {
    await page.close();
  }
}

// ─── Phase 4: Selector detection ─────────────────────────────────────────────

const ATS_PATTERNS = [
  { name: 'Lever', urlMatch: /lever\.co|jobs\.lever/i, card: '.posting', title: '.posting-title h5', location: '.posting-categories .location', link: 'a.posting-title' },
  { name: 'Greenhouse', urlMatch: /greenhouse\.io|boards\.greenhouse/i, card: '.opening', title: 'a', location: '.location', link: 'a' },
  { name: 'Ashby', urlMatch: /ashbyhq\.com|jobs\.ashby/i, card: '.ashby-job-posting-brief-list div[data-testid]', title: 'a', location: 'span', link: 'a' },
  { name: 'Workable', urlMatch: /apply\.workable\.com/i, card: 'li[data-ui="job"]', title: 'a', location: 'span[data-ui="job-location"]', link: 'a' },
  { name: 'BambooHR', urlMatch: /bamboohr\.com/i, card: '.BambooHR-ATS-board__JobList__Item', title: 'a', location: '.BambooHR-ATS-Location', link: 'a' },
  { name: 'JazzHR', urlMatch: /applytojob\.com|jazz\.co/i, card: '.resumator-job', title: 'a', location: '.resumator-job-info', link: 'a' },
  { name: 'Paycom', urlMatch: /paycomonline\.net/i, card: '.gnewtonJobLink', title: 'a', location: '.location', link: 'a' },
  { name: 'iCIMS', urlMatch: /icims\.com/i, card: '.iCIMS_JobsTable .row', title: 'a', location: '.iCIMS_JobHeaderLocation', link: 'a' },
  { name: 'Jobvite', urlMatch: /jobvite\.com|jobs\.jobvite/i, card: '.jv-job-list tr', title: 'a', location: '.jv-job-list-location', link: 'a' },
  { name: 'UltiPro/UKG', urlMatch: /ultipro\.com|recruiting\.ultipro/i, card: '.opportunity', title: 'a', location: '.opportunity-location', link: 'a' },
  { name: 'Breezy', urlMatch: /breezy\.hr/i, card: '.position', title: 'a', location: '.location', link: 'a' },
  { name: 'SmartRecruiters', urlMatch: /smartrecruiters\.com/i, card: '.opening-job', title: 'a', location: '.location', link: 'a' },
  { name: 'Workday', urlMatch: /myworkdayjobs\.com/i, card: '[data-automation-id="jobItem"]', title: 'a', location: '[data-automation-id="locations"]', link: 'a' },
  { name: 'Paylocity', urlMatch: /paylocity\.com/i, card: '.job-listing-job-item', title: '.job-item-title a', location: '.location-column', link: '.job-item-title a' },
  { name: 'Rippling', urlMatch: /ats\.rippling\.com/i, card: '[class*="job"]', title: 'a', location: 'span', link: 'a' },
];

async function detectSelectors(browser, url) {
  // Check URL-based ATS first (no page load needed)
  for (const ats of ATS_PATTERNS) {
    if (ats.urlMatch.test(url)) {
      return {
        method: 'ats-url',
        card: ats.card, title: ats.title, location: ats.location, link: ats.link,
        platform: ats.name, confidence: 'high',
      };
    }
  }

  const page = await browser.newPage();
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (['image', 'font', 'media'].includes(req.resourceType())) req.abort();
      else req.continue();
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
    await delay(2000);

    const result = await page.evaluate(() => {
      // Check for ATS iframes
      for (const iframe of document.querySelectorAll('iframe')) {
        const src = iframe.src || '';
        if (/lever|greenhouse|bamboohr|workable|ashby|jazz|paycom|icims|jobvite|ultipro|breezy|smartrecruiters|myworkdayjobs|taleo|paylocity/i.test(src)) {
          return { method: 'iframe', iframeSrc: src };
        }
      }

      // ATS embeds
      if (document.querySelector('#grnhse_app')) return { method: 'ats-embed', platform: 'Greenhouse' };
      if (document.querySelector('#BambooHR')) return { method: 'ats-embed', platform: 'BambooHR' };

      const mainContent = document.querySelector('main, #content, .content, #main, .main, [role="main"]') || document.body;

      function isInNavOrFooter(el) {
        let p = el;
        while (p && p !== document.body) {
          const tag = p.tagName?.toLowerCase();
          const cls = (p.className || '').toString().toLowerCase();
          if (tag === 'nav' || tag === 'header' || tag === 'footer' || /\b(nav|navbar|header|footer|menu|sidebar)\b/.test(cls)) return true;
          p = p.parentElement;
        }
        return false;
      }

      // Job-class selectors
      const patterns = [
        '.job-card', '.job-listing', '.job-post', '.job-item', '.job-row', '.job',
        '.posting', '.opening', '.position-item', '.position-listing', '.position',
        '.career-item', '.career-listing', '.career-card', '.vacancy', '.opportunity',
      ];
      for (const sel of patterns) {
        const items = Array.from(mainContent.querySelectorAll(sel)).filter(el => !isInNavOrFooter(el));
        if (items.length >= 1 && items[0].querySelector('a[href]')) {
          const first = items[0];
          const titleEl = first.querySelector('h2, h3, h4, h5') || first.querySelector('a');
          const locEl = first.querySelector('.location, [class*="location"], [class*="Location"]');
          return {
            method: 'class-match', card: sel,
            title: titleEl?.tagName === 'A' ? 'a' : titleEl?.tagName?.toLowerCase() || 'a',
            location: locEl ? '.' + (Array.from(locEl.classList).find(c => /location/i.test(c)) || 'location') : 'span',
            link: 'a', count: items.length,
            sampleTitle: (titleEl?.textContent || '').trim().substring(0, 80),
          };
        }
      }

      // No openings check
      const text = document.body.textContent.toLowerCase();
      for (const pat of ['no current openings', 'no open positions', 'no positions available', 'no jobs available', 'currently no openings', 'check back later']) {
        if (text.includes(pat)) return { method: 'no-openings' };
      }

      return { method: 'none' };
    });

    // If iframe found, match against known ATS
    if (result.method === 'iframe') {
      for (const ats of ATS_PATTERNS) {
        if (ats.urlMatch.test(result.iframeSrc)) {
          return {
            method: 'ats-iframe', card: ats.card, title: ats.title,
            location: ats.location, link: ats.link, platform: ats.name,
            confidence: 'high', note: `iframe: ${result.iframeSrc}`,
          };
        }
      }
      return { method: 'iframe', confidence: 'low', note: `Unknown ATS iframe: ${result.iframeSrc}` };
    }

    if (result.method === 'ats-embed') {
      return { method: 'ats-embed', confidence: 'medium', platform: result.platform };
    }

    if (result.method === 'class-match') {
      return { ...result, confidence: 'medium' };
    }

    return result;
  } catch (err) {
    return { method: 'error', note: err.message };
  } finally {
    await page.close();
  }
}

// ─── Main pipeline ───────────────────────────────────────────────────────────

async function main() {
  console.log('=== LinkedIn Follows Enrichment Pipeline ===\n');
  if (DRY_RUN) console.log('** DRY RUN — no files will be modified **\n');
  if (!SERPER_API_KEY) {
    console.error('Missing SERPER_API_KEY in .env — Phase 2 will be skipped');
  }

  // ── Phase 1: Filter ──
  console.log('── Phase 1: Filter ──────────────────────────────');
  const follows = parse(readFileSync('data/linkedin-follows.csv', 'utf-8'), {
    columns: true, skip_empty_lines: true, trim: true, relax_column_count: true,
  });
  const existing = loadExistingCompanies();
  const followNames = follows.map(r => r.Organization.trim());

  const candidates = followNames.filter(name => {
    if (existing.has(name.toLowerCase())) return false;
    if (shouldSkip(name)) return false;
    return true;
  });

  const skippedExisting = followNames.filter(n => existing.has(n.toLowerCase())).length;
  const skippedFilter = followNames.length - skippedExisting - candidates.length;

  console.log(`  Total follows: ${followNames.length}`);
  console.log(`  Already in lists: ${skippedExisting}`);
  console.log(`  Filtered (non-employers): ${skippedFilter}`);
  console.log(`  Candidates to process: ${candidates.length}`);

  let toProcess = candidates;
  if (LIMIT > 0) {
    toProcess = candidates.slice(0, LIMIT);
    console.log(`  Limited to: ${toProcess.length}`);
  }
  console.log();

  // ── Phase 2: Serper API search ──
  console.log('── Phase 2: Serper API Search ───────────────────');
  const companies = []; // { name, website, careersUrl, source }
  let quotaExceeded = false;

  for (let i = 0; i < toProcess.length; i++) {
    const name = toProcess[i];
    if (quotaExceeded || !SERPER_API_KEY) {
      companies.push({ name, website: null, careersUrl: null, source: 'skipped' });
      continue;
    }

    process.stdout.write(`  [${i + 1}/${toProcess.length}] ${name}...`);
    const result = await searchCareersUrl(name);

    if (result === 'QUOTA_EXCEEDED') {
      quotaExceeded = true;
      companies.push({ name, website: null, careersUrl: null, source: 'quota' });
      console.log(' QUOTA');
      continue;
    }

    if (result) {
      companies.push({ name, website: result.website, careersUrl: result.careersUrl, source: result.source });
      console.log(result.careersUrl ? ` ${result.careersUrl}` : ` ${result.website} (homepage)`);
    } else {
      companies.push({ name, website: null, careersUrl: null, source: 'not-found' });
      console.log(' not found');
    }

    await delay(300); // Rate limit
  }

  const foundCareers = companies.filter(c => c.careersUrl).length;
  const foundHomepage = companies.filter(c => c.website && !c.careersUrl).length;
  const notFound = companies.filter(c => !c.website).length;
  console.log(`\n  Direct careers URL: ${foundCareers}`);
  console.log(`  Homepage only: ${foundHomepage}`);
  console.log(`  Not found: ${notFound}\n`);

  // ── Phase 3: Discover career pages via Puppeteer ──
  const needsDiscovery = companies.filter(c => c.website && !c.careersUrl);
  console.log(`── Phase 3: Career Page Discovery (${needsDiscovery.length} companies) ──`);

  if (needsDiscovery.length > 0) {
    const chromePath = findChrome();
    if (!chromePath) {
      console.error('  No Chrome/Edge found — skipping Phase 3 & 4');
    } else {
      const browser = await puppeteer.launch({
        executablePath: chromePath, headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });

      for (let i = 0; i < needsDiscovery.length; i++) {
        const company = needsDiscovery[i];
        process.stdout.write(`  [${i + 1}/${needsDiscovery.length}] ${company.name}...`);

        const careersUrl = await discoverCareersPage(browser, company.website);
        if (careersUrl) {
          company.careersUrl = careersUrl;
          company.source = 'puppeteer-discover';
          console.log(` ${careersUrl}`);
        } else {
          console.log(' no careers page');
        }

        await delay(500);
      }

      await browser.close();
    }
  }

  const totalWithCareers = companies.filter(c => c.careersUrl).length;
  console.log(`\n  Total with careers URL: ${totalWithCareers}\n`);

  // ── Phase 4: Selector detection ──
  const toDetect = companies.filter(c => c.careersUrl);
  console.log(`── Phase 4: Selector Detection (${toDetect.length} companies) ──`);

  if (!SKIP_PHASE4 && toDetect.length > 0) {
    const chromePath = findChrome();
    if (!chromePath) {
      console.error('  No Chrome/Edge found — skipping');
    } else {
      const browser = await puppeteer.launch({
        executablePath: chromePath, headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });

      for (let i = 0; i < toDetect.length; i++) {
        const company = toDetect[i];
        process.stdout.write(`  [${i + 1}/${toDetect.length}] ${company.name}...`);

        const detection = await detectSelectors(browser, company.careersUrl);
        company.detection = detection;

        if (detection.confidence === 'high' || detection.method === 'class-match') {
          console.log(` ${detection.platform || detection.method}: ${detection.card}`);
        } else if (detection.method === 'no-openings') {
          console.log(' no openings');
        } else if (detection.method === 'error') {
          console.log(` error: ${detection.note}`);
        } else {
          console.log(` ${detection.method}`);
        }

        await delay(1000);
      }

      await browser.close();
    }
  } else if (SKIP_PHASE4) {
    console.log('  Skipped (--skip-phase4)\n');
  }

  // ── Output: Build CSV rows and append ──
  console.log('\n── Results ─────────────────────────────────────');

  const csvRows = [];
  let enabledCount = 0;
  let disabledCount = 0;

  for (const company of companies) {
    const d = company.detection || {};
    let card = '', title = '', location = '', link = '';
    let enabled = false;
    let notes = '';

    if (!company.careersUrl) {
      notes = company.website
        ? `Homepage: ${company.website} - no careers page found`
        : 'No website found via search';
      disabledCount++;
    } else if (d.confidence === 'high') {
      card = d.card; title = d.title; location = d.location; link = d.link;
      enabled = true;
      notes = `${d.platform} ATS${d.note ? ' - ' + d.note : ''}`;
      enabledCount++;
    } else if (d.method === 'class-match') {
      card = d.card; title = d.title; location = d.location; link = d.link;
      enabled = true;
      notes = `Heuristic match (${d.count} items)`;
      if (d.sampleTitle) notes += ` - sample: ${d.sampleTitle}`;
      enabledCount++;
    } else if (d.method === 'no-openings') {
      notes = 'No current openings';
      disabledCount++;
    } else {
      // Has careers URL but no selectors — use AI extraction
      card = '.job-card'; title = 'a'; location = 'span'; link = 'a';
      notes = `Needs AI extraction - ${d.method || 'unknown structure'}`;
      if (d.note) notes += ` - ${d.note}`;
      disabledCount++;
    }

    const row = [
      csvEscape(company.name),
      csvEscape(company.careersUrl || company.website || ''),
      csvEscape(card), csvEscape(title), csvEscape(location), csvEscape(link),
      enabled ? 'true' : 'false',
      csvEscape(notes),
    ].join(',');

    csvRows.push(row);
  }

  console.log(`  Enabled (selectors found): ${enabledCount}`);
  console.log(`  Disabled (needs review): ${disabledCount}`);
  console.log(`  Total rows: ${csvRows.length}`);

  if (DRY_RUN) {
    console.log('\n  DRY RUN — preview of first 10 rows:');
    csvRows.slice(0, 10).forEach(r => console.log(`    ${r}`));
    console.log('\n  Run without --dry-run to append to companies-weekly.csv');
  } else {
    // Append to companies-weekly.csv
    const weeklyPath = 'data/companies-weekly.csv';
    const newLines = '\n' + csvRows.join('\n');
    appendFileSync(weeklyPath, newLines);
    console.log(`\n  Appended ${csvRows.length} rows to ${weeklyPath}`);

    // Also save a standalone report
    const reportPath = 'data/linkedin-follows-enriched.csv';
    const header = 'company_name,careers_url,job_card_selector,title_selector,location_selector,link_selector,enabled,notes';
    writeFileSync(reportPath, header + '\n' + csvRows.join('\n') + '\n');
    console.log(`  Full report saved to ${reportPath}`);
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

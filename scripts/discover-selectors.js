import puppeteer from 'puppeteer-core';
import { parse } from 'csv-parse/sync';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';

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

// Known ATS platform patterns
const ATS_PATTERNS = [
  { name: 'Lever', urlMatch: /lever\.co|jobs\.lever/i, card: '.posting', title: '.posting-title h5', location: '.posting-categories .location', link: 'a.posting-title' },
  { name: 'Greenhouse', urlMatch: /greenhouse\.io|boards\.greenhouse/i, card: '.opening', title: 'a', location: '.location', link: 'a' },
  { name: 'Ashby', urlMatch: /ashbyhq\.com|jobs\.ashby/i, card: '[data-testid]', title: 'a', location: 'span', link: 'a' },
  { name: 'Workable', urlMatch: /apply\.workable\.com/i, card: 'li[data-ui="job"]', title: 'a', location: 'span[data-ui="job-location"]', link: 'a' },
  { name: 'BambooHR', urlMatch: /bamboohr\.com/i, card: '.BambooHR-ATS-board__JobList__Item', title: 'a', location: '.BambooHR-ATS-Location', link: 'a' },
  { name: 'JazzHR', urlMatch: /applytojob\.com|jazz\.co/i, card: '.resumator-job', title: 'a', location: '.resumator-job-info', link: 'a' },
  { name: 'Paycom', urlMatch: /paycomonline\.net/i, card: '.gnewtonJobLink, .job-listing', title: 'a', location: '.location', link: 'a' },
  { name: 'iCIMS', urlMatch: /icims\.com/i, card: '.iCIMS_JobsTable .row, .col-xs-12', title: 'a', location: '.iCIMS_JobHeaderLocation', link: 'a' },
  { name: 'Jobvite', urlMatch: /jobvite\.com|jobs\.jobvite/i, card: '.jv-job-list tr, .jv-job-item', title: 'a', location: '.jv-job-list-location', link: 'a' },
  { name: 'UltiPro/UKG', urlMatch: /ultipro\.com|recruiting\.ultipro/i, card: '.opportunity', title: 'a', location: '.opportunity-location', link: 'a' },
  { name: 'Breezy', urlMatch: /breezy\.hr/i, card: '.position', title: 'a', location: '.location', link: 'a' },
  { name: 'SmartRecruiters', urlMatch: /smartrecruiters\.com/i, card: '.opening-job', title: 'a', location: '.location', link: 'a' },
];

async function analyzePageDeep(page, url) {
  // Check URL-based ATS
  for (const ats of ATS_PATTERNS) {
    if (ats.urlMatch.test(url)) {
      return { card: ats.card, title: ats.title, location: ats.location, link: ats.link, platform: ats.name, method: 'url-pattern' };
    }
  }

  const result = await page.evaluate(() => {
    // Check for ATS iframes first
    const iframes = Array.from(document.querySelectorAll('iframe'));
    for (const iframe of iframes) {
      const src = iframe.src || '';
      if (/lever|greenhouse|bamboohr|workable|ashby|jazz|paycom|icims|jobvite|ultipro|breezy|smartrecruiters|myworkdayjobs|taleo/i.test(src)) {
        return { method: 'iframe', iframeSrc: src };
      }
    }

    // Check for ATS embed containers
    const grnhse = document.querySelector('#grnhse_app');
    if (grnhse) return { method: 'ats-embed', platform: 'Greenhouse embed', detail: '#grnhse_app' };
    const bamboo = document.querySelector('#BambooHR');
    if (bamboo) return { method: 'ats-embed', platform: 'BambooHR embed', detail: '#BambooHR' };

    // Look for job-specific selectors (NOT nav items)
    // Strategy: find elements whose text/class/id contains job-related keywords
    // AND are in the main content area (not in nav/header/footer)

    const mainContent = document.querySelector('main, #content, .content, #main, .main, article, .page-content, .entry-content, [role="main"]') || document.body;

    // Exclude header/nav/footer
    function isInNavOrFooter(el) {
      let parent = el;
      while (parent && parent !== document.body) {
        const tag = parent.tagName?.toLowerCase();
        const cls = (parent.className || '').toString().toLowerCase();
        const role = (parent.getAttribute('role') || '').toLowerCase();
        if (tag === 'nav' || tag === 'header' || tag === 'footer' ||
            role === 'navigation' || role === 'banner' || role === 'contentinfo' ||
            /\b(nav|navbar|header|footer|menu|sidebar)\b/.test(cls)) {
          return true;
        }
        parent = parent.parentElement;
      }
      return false;
    }

    // Strategy 1: Look for elements with job-related class names in main content
    const jobClassPatterns = [
      '.job-card', '.job-listing', '.job-post', '.job-item', '.job-row', '.job',
      '.posting', '.opening', '.position-item', '.position-listing', '.position',
      '.career-item', '.career-listing', '.career-card',
      '.vacancy', '.opportunity', '.role-item',
      'li.position', 'tr.job', '.wp-block-post',
    ];

    for (const sel of jobClassPatterns) {
      const items = mainContent.querySelectorAll(sel);
      const filtered = Array.from(items).filter(el => !isInNavOrFooter(el));
      if (filtered.length >= 1) {
        const first = filtered[0];
        const linkEl = first.querySelector('a[href]');
        const titleEl = first.querySelector('h2, h3, h4, h5') || linkEl;
        const locEl = first.querySelector('.location, [class*="location"], [class*="Location"]');

        return {
          method: 'class-match',
          card: sel,
          title: titleEl?.tagName === 'A' ? 'a' : titleEl ? titleEl.tagName.toLowerCase() : 'a',
          location: locEl ? `.${Array.from(locEl.classList).find(c => /location/i.test(c)) || 'location'}` : 'span',
          link: 'a',
          count: filtered.length,
          sampleTitle: (titleEl?.textContent || '').trim().substring(0, 80),
          sampleLink: linkEl?.href || '',
        };
      }
    }

    // Strategy 2: Find links in main content that look like job postings
    // (links whose href or text contains job-related keywords)
    const contentLinks = Array.from(mainContent.querySelectorAll('a[href]')).filter(a => !isInNavOrFooter(a));
    const jobLinks = contentLinks.filter(a => {
      const href = (a.href || '').toLowerCase();
      const text = (a.textContent || '').toLowerCase().trim();
      // Link points to a job detail page
      if (/\/job[s]?\/|\/position[s]?\/|\/opening[s]?\/|\/career[s]?\/.*\d|\/apply/i.test(href)) return true;
      // Text is a job-like title (more than 3 words, not a nav item)
      if (text.length > 15 && text.split(/\s+/).length >= 3 && !/home|about|contact|donate|get involved|menu|volunteer/i.test(text)) return true;
      return false;
    });

    if (jobLinks.length >= 1) {
      // Try to find a common parent
      const firstLink = jobLinks[0];
      let parent = firstLink.parentElement;

      // Walk up to find a container that holds multiple job links
      let container = null;
      let containerSel = '';
      while (parent && parent !== document.body) {
        const siblings = parent.parentElement?.children || [];
        const matchingSiblings = Array.from(siblings).filter(sib => sib.querySelector('a[href]') && sib.tagName === parent.tagName);
        if (matchingSiblings.length >= 2) {
          container = parent;
          // Build selector from tag + class
          const tag = parent.tagName.toLowerCase();
          const cls = Array.from(parent.classList).filter(c => !/menu|nav|header|footer|active|current/i.test(c))[0];
          containerSel = cls ? `${tag}.${cls}` : tag;
          break;
        }
        parent = parent.parentElement;
      }

      return {
        method: 'link-analysis',
        card: containerSel || 'li',
        title: 'a',
        location: 'span',
        link: 'a',
        count: jobLinks.length,
        sampleTitle: jobLinks[0].textContent.trim().substring(0, 80),
        sampleLink: jobLinks[0].href,
        sampleLinks: jobLinks.slice(0, 5).map(a => ({ text: a.textContent.trim().substring(0, 60), href: a.href })),
      };
    }

    // Strategy 3: Check if the page says "no openings" or similar
    const bodyText = document.body.textContent.toLowerCase();
    const noJobsPatterns = [
      'no current openings', 'no open positions', 'no positions available',
      'no current job', 'no jobs available', 'currently no openings',
      'no vacancies', 'check back', 'no opportunities at this time',
    ];
    for (const pat of noJobsPatterns) {
      if (bodyText.includes(pat)) {
        return { method: 'no-openings', message: pat };
      }
    }

    // Strategy 4: Look for any repeated content blocks in main area
    const blocks = mainContent.querySelectorAll('div, li, article, section, tr');
    const tagClassMap = {};
    for (const el of blocks) {
      if (isInNavOrFooter(el)) continue;
      if (!el.querySelector('a[href]')) continue;
      const text = el.textContent.trim();
      if (text.length < 10 || text.length > 2000) continue;

      const tag = el.tagName.toLowerCase();
      const classes = Array.from(el.classList).filter(c => c.length > 2 && !/menu|nav|header|footer|active|current|col|row|container|wrapper|grid|flex/i.test(c));
      const key = classes.length > 0 ? `${tag}.${classes[0]}` : null;
      if (key) {
        if (!tagClassMap[key]) tagClassMap[key] = [];
        tagClassMap[key].push(el);
      }
    }

    // Find groups of 2+ similar elements
    let bestGroup = null;
    let bestKey = null;
    for (const [key, els] of Object.entries(tagClassMap)) {
      if (els.length >= 2 && (!bestGroup || els.length > bestGroup.length)) {
        bestGroup = els;
        bestKey = key;
      }
    }

    if (bestGroup && bestGroup.length >= 2) {
      const first = bestGroup[0];
      const titleEl = first.querySelector('h2, h3, h4, h5, a');
      return {
        method: 'repeated-blocks',
        card: bestKey,
        title: titleEl?.tagName === 'A' ? 'a' : titleEl?.tagName?.toLowerCase() || 'a',
        location: 'span',
        link: 'a',
        count: bestGroup.length,
        sampleTitle: (titleEl?.textContent || '').trim().substring(0, 80),
      };
    }

    // Last resort: page content summary
    const visibleText = document.body.textContent.replace(/\s+/g, ' ').trim().substring(0, 300);
    return { method: 'none', pageSnippet: visibleText };
  });

  // If iframe detected, try to extract the ATS URL
  if (result.method === 'iframe') {
    const iframeUrl = result.iframeSrc;
    for (const ats of ATS_PATTERNS) {
      if (ats.urlMatch.test(iframeUrl)) {
        return { card: ats.card, title: ats.title, location: ats.location, link: ats.link, platform: `${ats.name} (iframe)`, method: 'iframe-ats', iframeSrc: iframeUrl, useIframeUrl: true };
      }
    }
    return { ...result, platform: 'Unknown ATS iframe' };
  }

  return result;
}

async function main() {
  console.log('Discovering CSS selectors for TogetherSC employers...\n');

  const csvContent = readFileSync('togethersc_employers_enriched.csv', 'utf-8');
  const records = parse(csvContent, { columns: true, skip_empty_lines: true, trim: true });

  // Filter to companies with careers pages
  const companies = records
    .filter(r => r['Careers Page'] && r['Careers Page'].trim())
    .map(r => ({
      name: r.Name.replace(/^"+|"+$/g, '').trim(),
      careersUrl: r['Careers Page'].trim(),
      website: (r.Website || '').trim(),
    }));

  console.log(`Found ${companies.length} companies with careers pages\n`);

  const chromePath = findChrome();
  if (!chromePath) { console.error('No Chrome/Edge found!'); process.exit(1); }
  console.log(`Using browser: ${chromePath}\n`);

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const results = [];

  for (let i = 0; i < companies.length; i++) {
    const { name, careersUrl } = companies[i];
    console.log(`[${i + 1}/${companies.length}] ${name} - ${careersUrl}`);

    const page = await browser.newPage();
    try {
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      await page.setRequestInterception(true);
      page.on('request', req => {
        if (['image', 'font', 'media'].includes(req.resourceType())) {
          req.abort();
        } else {
          req.continue();
        }
      });

      await page.goto(careersUrl, { waitUntil: 'networkidle2', timeout: 20000 });
      await new Promise(r => setTimeout(r, 2000));

      const detection = await analyzePageDeep(page, careersUrl);
      results.push({ name, careersUrl, ...detection });

      const m = detection.method;
      if (['class-match', 'url-pattern', 'iframe-ats'].includes(m)) {
        console.log(`  ✅ ${detection.platform || m}: card=${detection.card} title=${detection.title} loc=${detection.location} link=${detection.link} (${detection.count || '?'} items)`);
        if (detection.sampleTitle) console.log(`     Sample: "${detection.sampleTitle}"`);
      } else if (m === 'link-analysis' || m === 'repeated-blocks') {
        console.log(`  🔶 ${m}: card=${detection.card} title=${detection.title} (${detection.count} items)`);
        if (detection.sampleTitle) console.log(`     Sample: "${detection.sampleTitle}"`);
        if (detection.sampleLinks) detection.sampleLinks.slice(0, 2).forEach(l => console.log(`     - ${l.text}`));
      } else if (m === 'iframe') {
        console.log(`  🔗 ATS iframe: ${detection.iframeSrc}`);
      } else if (m === 'ats-embed') {
        console.log(`  🔗 ${detection.platform}: ${detection.detail}`);
      } else if (m === 'no-openings') {
        console.log(`  ⬜ No openings: "${detection.message}"`);
      } else {
        console.log(`  ❌ No listings detected`);
        if (detection.pageSnippet) console.log(`     Page: ${detection.pageSnippet.substring(0, 120)}...`);
      }
    } catch (err) {
      console.log(`  ❌ ERROR: ${err.message}`);
      results.push({ name, careersUrl, method: 'error', error: err.message });
    } finally {
      await page.close();
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  await browser.close();

  // Generate CSV
  const header = 'company_name,careers_url,job_card_selector,title_selector,location_selector,link_selector,enabled,skip_keyword_filter,use_ai_extraction,notes';
  const lines = results.map(r => {
    const escapedName = r.name.includes(',') ? `"${r.name}"` : r.name;
    let card = '', title = '', location = '', link = '';
    let useAI = 'true';
    let enabled = 'false';
    let notes = '';

    if (['class-match', 'url-pattern', 'iframe-ats'].includes(r.method)) {
      card = r.card;
      title = r.title;
      location = r.location;
      link = r.link;
      useAI = 'false';
      enabled = 'true';
      const atsUrl = r.useIframeUrl ? ` - Use iframe URL: ${r.iframeSrc}` : '';
      notes = `${r.platform || r.method} - ${r.count || '?'} items${atsUrl}`;
      if (r.sampleTitle) notes += ` - sample: ${r.sampleTitle}`;
    } else if (r.method === 'link-analysis' || r.method === 'repeated-blocks') {
      card = r.card;
      title = r.title;
      location = r.location || 'span';
      link = r.link;
      useAI = 'true';
      enabled = 'false';
      notes = `${r.method} (${r.count} items) - needs verification`;
      if (r.sampleTitle) notes += ` - sample: ${r.sampleTitle}`;
    } else if (r.method === 'iframe') {
      notes = `ATS iframe: ${r.iframeSrc} - scrape iframe URL directly`;
    } else if (r.method === 'ats-embed') {
      notes = `${r.platform} - ${r.detail}`;
    } else if (r.method === 'no-openings') {
      notes = `No current openings - ${r.message}`;
    } else if (r.method === 'error') {
      notes = `Error: ${r.error}`;
    } else {
      notes = 'No job listings detected - manual review needed';
    }

    notes = notes.replace(/"/g, '""');
    if (notes.includes(',')) notes = `"${notes}"`;

    return `${escapedName},${r.careersUrl},${card},${title},${location},${link},${enabled},false,${useAI},${notes}`;
  });

  const output = header + '\n' + lines.join('\n') + '\n';
  writeFileSync('data/togethersc_companies.csv', output);

  console.log(`\n📊 Summary:`);
  const auto = results.filter(r => ['class-match', 'url-pattern', 'iframe-ats'].includes(r.method)).length;
  const partial = results.filter(r => ['link-analysis', 'repeated-blocks'].includes(r.method)).length;
  const noJobs = results.filter(r => r.method === 'no-openings').length;
  const manual = results.filter(r => ['none', 'iframe', 'ats-embed', 'error'].includes(r.method)).length;
  console.log(`  Auto-detected selectors: ${auto}`);
  console.log(`  Partial detection (needs review): ${partial}`);
  console.log(`  No current openings: ${noJobs}`);
  console.log(`  Needs manual review: ${manual}`);
  console.log(`\nSaved to data/togethersc_companies.csv`);
}

main().catch(console.error);

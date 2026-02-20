import fs from 'fs/promises';
import { parse } from 'csv-parse/sync';
import configManager from './src/main/config.js';

const SERPER_API = 'https://google.serper.dev/search';
const SERPER_JOBS_API = 'https://google.serper.dev/jobs';

export class GoogleDorkScraper {
  // Role suffixes combined with the config keyword for Jobs API searches
  static JOB_QUERIES = [
    { suffix: 'administrator', id: 'jobs-admin' },
    { suffix: 'admin', id: 'jobs-admin-short' },
    { suffix: 'business analyst', id: 'jobs-ba' },
    { suffix: 'project manager', id: 'jobs-pm' },
    { suffix: 'developer', id: 'jobs-dev' },
    { suffix: 'consultant', id: 'jobs-consultant' },
  ];

  constructor(options = {}) {
    this.apiKey = process.env.SERPER_API_KEY;

    if (!this.apiKey) {
      console.error(
        '\n❌ Missing Serper API key in .env\n\n' +
        'Setup instructions:\n' +
        '  1. Go to https://serper.dev/ → Sign up (free, no credit card)\n' +
        '  2. Copy your API key → paste into .env as SERPER_API_KEY\n' +
        '  3. Free tier: 2,500 queries\n'
      );
      throw new Error('SERPER_API_KEY must be set in .env');
    }

    // Read search parameters from Dashboard config (allow overrides via options)
    this.keywords = options.keywords || configManager.getKeywords();
    this.locations = options.locations || configManager.getLocations();

    console.log(`⚙️  Using keyword: "${this.keywords[0] || 'salesforce'}"`);
    console.log(`⚙️  Using locations: ${this.locations.join(', ')}`);
  }

  /**
   * Replace {{keyword}} and {{locations_or}} placeholders in a query template
   * with the actual values from Dashboard config.
   */
  _interpolateQuery(template) {
    const keyword = this.keywords[0] || 'salesforce';
    const locationsOr = this.locations
      .map(l => `"${l}"`)
      .join(' OR ');

    return template
      .replace(/\{\{keyword\}\}/g, keyword)
      .replace(/\{\{locations_or\}\}/g, `(${locationsOr})`);
  }

  async loadDorks(csvPath, frequency = 'daily') {
    const fileContent = await fs.readFile(csvPath, 'utf-8');
    const records = parse(fileContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      comment: '#'
    });

    const filtered = records.filter(r => r.frequency === frequency);
    console.log(`📋 Loaded ${filtered.length} ${frequency} dorks from ${csvPath}`);
    return filtered;
  }

  async searchGoogle(query) {
    const allItems = [];

    // Fetch 2 pages (20 results total)
    for (const page of [1, 2]) {
      try {
        const res = await fetch(SERPER_API, {
          method: 'POST',
          headers: {
            'X-API-KEY': this.apiKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ q: query, num: 10, page })
        });
        const data = await res.json();

        if (data.statusCode === 429 || res.status === 429) {
          console.warn('  ⚠️  API quota exceeded — stopping');
          return allItems;
        }

        if (!res.ok) {
          console.warn(`  ⚠️  API error: ${data.message || res.statusText}`);
          return allItems;
        }

        if (data.organic && data.organic.length > 0) {
          allItems.push(...data.organic);
        } else {
          break; // No more results
        }

      } catch (err) {
        console.warn(`  ⚠️  Network error: ${err.message}`);
        return allItems;
      }

      // Rate limit between pages
      await this._delay(1000);
    }

    return allItems;
  }

  parseResultToJob(item) {
    const title = this._cleanTitle(item.title);
    const company = this._extractCompany(item.title, item.displayedLink || '');
    const location = this._extractLocation(item.snippet || '');
    const url = item.link;

    return { title, company, url, location };
  }

  async runDorkSearch(csvPath, frequency = 'daily') {
    const dorks = await this.loadDorks(csvPath, frequency);

    if (dorks.length === 0) {
      console.log(`No ${frequency} dorks found.`);
      return [];
    }

    const allJobs = [];
    const seenUrls = new Set();

    for (const dork of dorks) {
      const query = this._interpolateQuery(dork.query);
      console.log(`🔍 Searching: ${dork.dork_id} (${dork.category})`);
      console.log(`   Query: ${query}`);

      const items = await this.searchGoogle(query);
      let added = 0;

      let skipped = 0;
      for (const item of items) {
        // Deduplicate within this run by URL
        if (seenUrls.has(item.link)) continue;
        seenUrls.add(item.link);

        // Filter out non-job results and international locations
        if (!this._isLikelyJob(item) || !this._isRelevantLocation(item)) {
          skipped++;
          continue;
        }

        const job = this.parseResultToJob(item);
        job.source = dork.dork_id;
        allJobs.push(job);
        added++;
      }

      console.log(`  Found ${items.length} results, ${added} unique${skipped ? `, ${skipped} filtered` : ''}`);

      // Rate limit between queries
      await this._delay(2000);
    }

    console.log(`\n📊 Total unique jobs from dorks: ${allJobs.length}`);

    // Validate URLs — remove dead links (filled positions, expired postings)
    console.log(`🔗 Validating ${allJobs.length} job URLs...`);
    const validJobs = await this._validateJobs(allJobs);
    const removed = allJobs.length - validJobs.length;
    if (removed > 0) {
      console.log(`  ❌ Removed ${removed} dead link${removed === 1 ? '' : 's'}`);
    }
    console.log(`✅ ${validJobs.length} verified jobs`);

    return validJobs;
  }

  // --- Serper Jobs API (structured Google Jobs results) ---

  async searchGoogleJobs(query, location = 'United States') {
    const allItems = [];

    for (const page of [1, 2]) {
      try {
        const res = await fetch(SERPER_JOBS_API, {
          method: 'POST',
          headers: {
            'X-API-KEY': this.apiKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ q: query, location, num: 10, page })
        });
        const data = await res.json();

        if (data.statusCode === 429 || res.status === 429) {
          console.warn('  ⚠️  API quota exceeded — stopping');
          return allItems;
        }

        if (!res.ok) {
          console.warn(`  ⚠️  API error: ${data.message || res.statusText}`);
          return allItems;
        }

        if (data.jobs && data.jobs.length > 0) {
          allItems.push(...data.jobs);
        } else {
          break;
        }

      } catch (err) {
        console.warn(`  ⚠️  Network error: ${err.message}`);
        return allItems;
      }

      await this._delay(1000);
    }

    return allItems;
  }

  _parseJobsResult(item) {
    return {
      title: item.title || '',
      company: item.companyName || '',
      url: item.link || '',
      location: item.location || '',
      date: item.date || '',
      extensions: item.extensions || [],
    };
  }

  async runJobsSearch() {
    const keyword = this.keywords[0] || 'salesforce';
    const queries = GoogleDorkScraper.JOB_QUERIES;

    const allJobs = [];
    const seenUrls = new Set();

    for (const q of queries) {
      const query = `${keyword} ${q.suffix}`;
      console.log(`🔍 Jobs API: ${q.id}`);
      console.log(`   Query: "${query}" (location: United States)`);

      const items = await this.searchGoogleJobs(query);
      let added = 0;
      let skipped = 0;

      for (const item of items) {
        if (!item.link || seenUrls.has(item.link)) continue;
        seenUrls.add(item.link);

        // Reuse location filter — item shape differs from organic, adapt it
        const asOrganic = { title: item.title || '', snippet: item.snippet || '', link: item.link };
        if (!this._isRelevantLocation(asOrganic)) {
          skipped++;
          continue;
        }

        const job = this._parseJobsResult(item);
        job.source = q.id;
        allJobs.push(job);
        added++;
      }

      console.log(`  Found ${items.length} results, ${added} unique${skipped ? `, ${skipped} filtered` : ''}`);
      await this._delay(2000);
    }

    console.log(`\n📊 Total unique jobs from Jobs API: ${allJobs.length}`);

    // Validate URLs
    console.log(`🔗 Validating ${allJobs.length} job URLs...`);
    const validJobs = await this._validateJobs(allJobs);
    const removed = allJobs.length - validJobs.length;
    if (removed > 0) {
      console.log(`  ❌ Removed ${removed} dead link${removed === 1 ? '' : 's'}`);
    }
    console.log(`✅ ${validJobs.length} verified jobs`);

    return validJobs;
  }

  // --- Private helpers ---

  // International locations — if any of these appear in the title, snippet, or URL
  // the result is almost certainly not a US Eastern Time zone job.
  static INTL_BLOCKLIST = [
    // Countries
    'india', 'canada', 'united kingdom', 'australia', 'germany', 'france',
    'singapore', 'japan', 'china', 'brazil', 'mexico', 'ireland', 'netherlands',
    'spain', 'italy', 'sweden', 'switzerland', 'israel', 'south korea',
    'philippines', 'poland', 'czech republic', 'portugal', 'new zealand',
    'belgium', 'denmark', 'norway', 'finland', 'austria', 'colombia', 'argentina',
    // Major international cities
    'bangalore', 'bengaluru', 'hyderabad', 'mumbai', 'pune', 'chennai',
    'delhi', 'noida', 'gurgaon', 'gurugram', 'kolkata', 'ahmedabad',
    'toronto', 'vancouver', 'montreal', 'ottawa', 'calgary', 'edmonton',
    'london, uk', 'london, england', 'manchester', 'birmingham, uk', 'edinburgh',
    'sydney', 'melbourne', 'brisbane', 'perth, au',
    'berlin', 'munich', 'frankfurt', 'hamburg',
    'paris, fr', 'amsterdam', 'dublin', 'tel aviv', 'tokyo', 'shanghai',
    'hong kong', 'são paulo', 'sao paulo', 'bogota', 'buenos aires',
    'manila', 'guadalajara',
  ];

  // URL path segments that indicate non-US locale
  static INTL_URL_PATTERNS = [
    '/en-gb/', '/en-in/', '/fr-ca/', '/en-au/', '/fr-fr/', '/de-de/',
    '/ja-jp/', '/en-sg/', '/en-ie/', '/en-nz/', '/pt-br/', '/es-es/',
    '/it-it/', '/nl-nl/', '/ko-kr/', '/zh-cn/',
  ];

  // URL subdomain prefixes that indicate non-US postings
  static INTL_SUBDOMAIN_RE = /^https?:\/\/(india|europe|apac|emea|latam|asia|uk|earlycareers-|indiacareers)/i;

  /**
   * Reject results that are clearly outside the US.
   * Uses a blocklist approach: if we see a strong international signal, reject.
   * If no geographic signal or a US signal, keep (benefit of the doubt).
   */
  _isRelevantLocation(item) {
    const title = (item.title || '').toLowerCase();
    const snippet = (item.snippet || '').toLowerCase();
    const url = (item.link || '').toLowerCase();
    const text = `${title} ${snippet}`;

    // Check URL for international locale paths (e.g. /en-GB/, /fr-CA/)
    if (GoogleDorkScraper.INTL_URL_PATTERNS.some(p => url.includes(p))) return false;

    // Check URL subdomain for international indicators
    if (GoogleDorkScraper.INTL_SUBDOMAIN_RE.test(item.link || '')) return false;

    // Check title + snippet for international locations
    for (const loc of GoogleDorkScraper.INTL_BLOCKLIST) {
      if (text.includes(loc)) return false;
    }

    return true;
  }

  /**
   * Filter out results that aren't actual job postings.
   * Checks that the keyword appears in the title or snippet,
   * and rejects company/category landing pages.
   */
  _isLikelyJob(item) {
    const title = (item.title || '').toLowerCase();
    const url = (item.link || '').toLowerCase();
    const keyword = (this.keywords[0] || 'salesforce').toLowerCase();

    // Keyword MUST appear in the title — snippet-only matches are too noisy
    if (!title.includes(keyword)) {
      return false;
    }

    // Reject generic landing/category pages (title is just a company name or "Careers at X")
    if (/^(careers|jobs|job search|search results)\b/i.test(title)) return false;

    // Reject URLs that are search/category pages rather than individual job posts
    const nonJobPaths = ['/search/', '/search?', '/results', '/login', '/register', '/category'];
    if (nonJobPaths.some(p => url.includes(p))) return false;

    return true;
  }

  _cleanTitle(rawTitle) {
    const keyword = (this.keywords[0] || 'salesforce').toLowerCase();

    // Strip known ATS platform suffixes like "Job Title - Company | Workday"
    let title = rawTitle
      .replace(/\s*[\|–—-]\s*(Workday|Greenhouse|iCIMS|Lever|SmartRecruiters|Phenom|Jobvite|Ashby|Eightfold).*$/i, '')
      .trim();

    // Only strip the last " - Whatever" segment if the keyword survives
    const stripped = title.replace(/\s*[\|–—-]\s*[^|–—-]+$/, '').trim();
    if (stripped && stripped.toLowerCase().includes(keyword)) {
      title = stripped;
    }

    return title;
  }

  _extractCompany(title, displayLink) {
    // Try to get company from the "Title - Company | ATS" pattern
    const pipeMatch = title.match(/[\|–—-]\s*([^|–—-]+)\s*[\|–—-]/);
    if (pipeMatch) return pipeMatch[1].trim();

    const dashMatch = title.match(/[\|–—-]\s*([^|–—-]+)$/);
    if (dashMatch) {
      const candidate = dashMatch[1].trim();
      // Skip if it's just an ATS name
      if (!/^(Workday|Greenhouse|iCIMS|Lever|SmartRecruiters|Phenom|Jobvite|Ashby|Eightfold)$/i.test(candidate)) {
        return candidate;
      }
    }

    // Fallback: extract from domain
    // e.g. "acme.wd5.myworkdayjobs.com" → "acme"
    // e.g. "boards.greenhouse.io" stays as-is
    const domainMatch = displayLink.match(/^([^.]+)\./);
    if (domainMatch && !['www', 'boards', 'jobs', 'careers'].includes(domainMatch[1])) {
      return domainMatch[1].charAt(0).toUpperCase() + domainMatch[1].slice(1);
    }

    return displayLink;
  }

  _extractLocation(snippet) {
    // Look for "City, ST" pattern (2-letter state abbreviation)
    const cityState = snippet.match(/([A-Z][a-zA-Z\s]+,\s*[A-Z]{2})\b/);
    if (cityState) return cityState[1];

    // Look for "Remote" mentions
    if (/\bremote\b/i.test(snippet)) return 'Remote';

    // Check configured locations in snippet
    for (const loc of this.locations) {
      if (snippet.toLowerCase().includes(loc.toLowerCase())) {
        return loc.charAt(0).toUpperCase() + loc.slice(1);
      }
    }

    return '';
  }

  /**
   * Check if a job URL is still live. Returns false for 404/410 or
   * redirects that strip the job-specific path (i.e. "position filled" redirects).
   */
  async _validateUrl(url) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      let res = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      clearTimeout(timeout);

      // Some servers block HEAD — retry with GET
      if (res.status === 405 || res.status === 403) {
        const ctrl2 = new AbortController();
        const t2 = setTimeout(() => ctrl2.abort(), 8000);
        res = await fetch(url, {
          method: 'GET',
          signal: ctrl2.signal,
          redirect: 'follow',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });
        clearTimeout(t2);
      }

      // Clearly dead
      if (res.status === 404 || res.status === 410) return false;

      // Detect "job removed" redirects — e.g. /company/job-id → /company
      const finalUrl = res.url;
      if (finalUrl && finalUrl !== url) {
        const originalPath = new URL(url).pathname;
        const finalPath = new URL(finalUrl).pathname;
        if (originalPath.length - finalPath.length > 10 && originalPath.startsWith(finalPath)) {
          return false;
        }
      }

      return true;
    } catch {
      // Network error / timeout — keep the job (may be temporary)
      return true;
    }
  }

  /**
   * Validate an array of jobs in parallel batches.
   * Returns only jobs whose URLs are still live.
   */
  async _validateJobs(jobs) {
    const CONCURRENCY = 5;
    const alive = new Array(jobs.length).fill(true);

    for (let i = 0; i < jobs.length; i += CONCURRENCY) {
      const batch = jobs.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map((job, idx) =>
          this._validateUrl(job.url).then(ok => { alive[i + idx] = ok; })
        )
      );
      // Brief pause between batches to avoid triggering rate limits
      if (i + CONCURRENCY < jobs.length) await this._delay(500);
    }

    return jobs.filter((_, i) => alive[i]);
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

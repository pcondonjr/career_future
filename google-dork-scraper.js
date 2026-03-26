import fs from 'fs/promises';
import { writeFileSync, existsSync, unlinkSync } from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';
import configManager from './src/main/config.js';

const SERPER_API = 'https://google.serper.dev/search';
const SERPER_JOBS_API = 'https://google.serper.dev/jobs';
const PROGRESS_PATH = path.join(process.cwd(), '.scraper-progress.json');

export class GoogleDorkScraper {

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

    // Use search value from env var (set by dashboard) if available,
    // otherwise fall back to config keywords. Avoids config reload races.
    const searchOverride = process.env.CF_SEARCH_VALUE?.trim();
    this.keywords = options.keywords || (searchOverride ? [searchOverride] : configManager.getKeywords());
    this.locations = ['remote', 'greenville', 'south carolina'];
    this.matchMode = options.matchMode || process.env.CF_MATCH_MODE || process.env._CF_ACTIVE_MATCH_MODE || 'contains';

    console.log(`⚙️  Using keyword: "${this.keywords[0] || ''}"`);
    console.log(`⚙️  Using match mode: ${this.matchMode}`);
    console.log(`⚙️  Using locations: ${this.locations.join(', ')}`);
  }

  /**
   * Replace {{keyword}} and {{locations_or}} placeholders in a query template
   * with the actual values from Dashboard config.
   */
  _interpolateQuery(template) {
    const keyword = this.keywords[0] || '';
    const locationsOr = this.locations
      .map(l => `"${l}"`)
      .join(' OR ');

    // For multi-word keywords, the CSV dork templates already expect a single token
    // after {{keyword}} (e.g. "{{keyword}} administrator"). If the keyword itself is
    // a full phrase like "Senior Director of Marketing", the template produces a
    // natural search query.
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
    const url = this._cleanUrl(item.link);

    return { title, company, url, location };
  }

  /**
   * Normalize a job URL — strip deep apply paths that don't show the job description.
   * e.g. Workday: ".../job/Title_ID/apply/applyManually" → ".../job/Title_ID"
   */
  _cleanUrl(url) {
    // Workday: strip /apply, /apply/applyManually, /apply/autofillWithResume etc.
    if (/myworkdayjobs\.com/i.test(url)) {
      return url.replace(/\/apply(\/[^/?#]*)?(\?.*)?$/, '');
    }
    return url;
  }

  async runDorkSearch(csvPath, frequency = 'daily') {
    const dorks = await this.loadDorks(csvPath, frequency);

    if (dorks.length === 0) {
      console.log(`No ${frequency} dorks found.`);
      return [];
    }

    const allJobs = [];
    const seenUrls = new Set();
    const total = dorks.length;
    const startedAt = Date.now();

    for (let i = 0; i < total; i++) {
      const dork = dorks[i];
      const query = this._interpolateQuery(dork.query);
      console.log(`🔍 [${i + 1}/${total}] Searching: ${dork.dork_id} (${dork.category})`);
      console.log(`   Query: ${query}`);

      this._writeProgress({
        type: 'dorks',
        phase: 'searching',
        total,
        completed: i,
        jobsFound: allJobs.length,
        errors: 0,
        active: [dork.dork_id],
        startedAt,
        updatedAt: Date.now()
      });

      const items = await this.searchGoogle(query);
      let added = 0;

      let skipped = 0;
      for (const item of items) {
        // Deduplicate within this run by cleaned URL
        const cleanedLink = this._cleanUrl(item.link);
        if (seenUrls.has(cleanedLink)) continue;
        seenUrls.add(cleanedLink);

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
    this._writeProgress({
      type: 'dorks',
      phase: 'validating',
      total: allJobs.length,
      completed: 0,
      jobsFound: allJobs.length,
      errors: 0,
      active: ['URL validation'],
      startedAt,
      updatedAt: Date.now()
    });
    const validJobs = await this._validateJobsWithProgress(allJobs, startedAt);
    const removed = allJobs.length - validJobs.length;
    if (removed > 0) {
      console.log(`  ❌ Removed ${removed} dead link${removed === 1 ? '' : 's'}`);
    }
    console.log(`✅ ${validJobs.length} verified jobs`);

    this._clearProgress();
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
      url: this._cleanUrl(item.link || ''),
      location: item.location || '',
      date: item.date || '',
      extensions: item.extensions || [],
    };
  }

  async runJobsSearch() {
    const keyword = this.keywords[0] || '';
    const queries = [{ id: 'jobs-direct', query: keyword }];

    const allJobs = [];
    const seenUrls = new Set();
    const startedAt = Date.now();
    const total = queries.length;

    for (let qi = 0; qi < total; qi++) {
      const q = queries[qi];
      const query = q.query;
      console.log(`🔍 Jobs API: ${q.id}`);
      console.log(`   Query: "${query}" (location: United States)`);

      this._writeProgress({
        type: 'jobs-api',
        phase: 'searching',
        total,
        completed: qi,
        jobsFound: allJobs.length,
        errors: 0,
        active: [q.id],
        startedAt,
        updatedAt: Date.now()
      });

      const items = await this.searchGoogleJobs(query);
      let added = 0;
      let skipped = 0;

      for (const item of items) {
        const cleanedLink = this._cleanUrl(item.link || '');
        if (!cleanedLink || seenUrls.has(cleanedLink)) continue;
        seenUrls.add(cleanedLink);

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
    this._writeProgress({
      type: 'jobs-api',
      phase: 'validating',
      total: allJobs.length,
      completed: 0,
      jobsFound: allJobs.length,
      errors: 0,
      active: ['URL validation'],
      startedAt,
      updatedAt: Date.now()
    });
    const validJobs = await this._validateJobsWithProgress(allJobs, startedAt);
    const removed = allJobs.length - validJobs.length;
    if (removed > 0) {
      console.log(`  ❌ Removed ${removed} dead link${removed === 1 ? '' : 's'}`);
    }
    console.log(`✅ ${validJobs.length} verified jobs`);

    this._clearProgress();
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
   * Checks that the keyword appears in the title, respecting the active match mode.
   * For dork results, titles include company/ATS suffixes (e.g. "Title - Company | Workday"),
   * so we strip those before applying exact/begins/ends matching.
   */
  _isLikelyJob(item) {
    const rawTitle = (item.title || '').toLowerCase();
    const url = (item.link || '').toLowerCase();
    const keyword = (this.keywords[0] || '').toLowerCase().trim();

    // Guard: empty keyword would match everything via "".includes("") === true
    if (!keyword) return false;

    // Strip ATS/company suffixes for cleaner matching: "Title - Company | Workday" → "title"
    const cleanedTitle = rawTitle
      .replace(/\s*[\|–—-]\s*(workday|greenhouse|icims|lever|smartrecruiters|phenom|jobvite|ashby|eightfold).*$/i, '')
      .replace(/\s*[\|–—-]\s*[^|–—-]+$/, '')
      .trim();

    // Apply match mode against the cleaned title
    let match = false;
    switch (this.matchMode) {
      case 'exact':    match = cleanedTitle === keyword; break;
      case 'begins':   match = cleanedTitle.startsWith(keyword); break;
      case 'ends':     match = cleanedTitle.endsWith(keyword); break;
      case 'contains':
      default:         match = rawTitle.includes(keyword); break;
    }

    if (!match) return false;

    // Reject generic landing/category pages (title is just a company name or "Careers at X")
    if (/^(careers|jobs|job search|search results)\b/i.test(rawTitle)) return false;

    // Reject URLs that are search/category pages rather than individual job posts
    const nonJobPaths = ['/search/', '/search?', '/results', '/login', '/register', '/category'];
    if (nonJobPaths.some(p => url.includes(p))) return false;

    return true;
  }

  _cleanTitle(rawTitle) {
    const keyword = (this.keywords[0] || '').toLowerCase().trim();

    // Strip known ATS platform suffixes like "Job Title - Company | Workday"
    let title = rawTitle
      .replace(/\s*[\|–—-]\s*(Workday|Greenhouse|iCIMS|Lever|SmartRecruiters|Phenom|Jobvite|Ashby|Eightfold).*$/i, '')
      .trim();

    // Only strip the last " - Whatever" segment if the keyword survives
    const stripped = title.replace(/\s*[\|–—-]\s*[^|–—-]+$/, '').trim();
    if (keyword && stripped && stripped.toLowerCase().includes(keyword)) {
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
   * Check if a job URL is still live. Returns false for 404/410,
   * redirects that strip the job-specific path (i.e. "position filled" redirects),
   * or Workday pages where postingAvailable is false.
   */
  async _validateUrl(url) {
    try {
      const isWorkday = /myworkdayjobs\.com/i.test(url);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      // Workday returns 200 even for dead postings — must GET and inspect body
      let res = await fetch(url, {
        method: isWorkday ? 'GET' : 'HEAD',
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      clearTimeout(timeout);

      // Some servers block HEAD — retry with GET
      if (!isWorkday && (res.status === 405 || res.status === 403)) {
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

      // Workday-specific: check for "postingAvailable": false in page body
      if (isWorkday && res.body) {
        const body = await res.text();
        if (/"postingAvailable"\s*:\s*false/i.test(body)) {
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

  async _validateJobsWithProgress(jobs, startedAt) {
    const CONCURRENCY = 5;
    const alive = new Array(jobs.length).fill(true);
    const total = jobs.length;

    for (let i = 0; i < total; i += CONCURRENCY) {
      const batch = jobs.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map((job, idx) =>
          this._validateUrl(job.url).then(ok => { alive[i + idx] = ok; })
        )
      );

      this._writeProgress({
        type: 'dorks',
        phase: 'validating',
        total,
        completed: Math.min(i + CONCURRENCY, total),
        jobsFound: jobs.length,
        errors: alive.slice(0, Math.min(i + CONCURRENCY, total)).filter(v => !v).length,
        active: ['URL validation'],
        startedAt,
        updatedAt: Date.now()
      });

      if (i + CONCURRENCY < total) await this._delay(500);
    }

    return jobs.filter((_, i) => alive[i]);
  }

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  _writeProgress(data) {
    try { writeFileSync(PROGRESS_PATH, JSON.stringify(data)); } catch { /* best-effort */ }
  }

  _clearProgress() {
    try { if (existsSync(PROGRESS_PATH)) unlinkSync(PROGRESS_PATH); } catch { /* best-effort */ }
  }
}

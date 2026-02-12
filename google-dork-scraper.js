import fs from 'fs/promises';
import { parse } from 'csv-parse/sync';
import configManager from './src/main/config.js';

const GOOGLE_CSE_API = 'https://www.googleapis.com/customsearch/v1';

export class GoogleDorkScraper {
  constructor(options = {}) {
    this.apiKey = process.env.GOOGLE_CSE_KEY;
    this.cseId = process.env.GOOGLE_CSE_ID;

    if (!this.apiKey || !this.cseId) {
      console.error(
        '\n❌ Missing Google CSE credentials in .env\n\n' +
        'Setup instructions:\n' +
        '  1. Go to https://programmablesearchengine.google.com/ → Add\n' +
        '  2. Set "Search the entire web" = ON\n' +
        '  3. Name it "Job Dork Scraper" → Create\n' +
        '  4. Copy the Search Engine ID → paste into .env as GOOGLE_CSE_ID\n' +
        '  5. Click "Custom Search JSON API" → Get a Key\n' +
        '  6. Select/create a GCP project → Copy the API Key → paste into .env as GOOGLE_CSE_KEY\n' +
        '  7. Free tier: 100 queries/day\n'
      );
      throw new Error('GOOGLE_CSE_KEY and GOOGLE_CSE_ID must be set in .env');
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
    for (const start of [1, 11]) {
      const params = new URLSearchParams({
        key: this.apiKey,
        cx: this.cseId,
        q: query,
        num: '10',
        start: String(start)
      });

      try {
        const res = await fetch(`${GOOGLE_CSE_API}?${params}`);
        const data = await res.json();

        if (data.error) {
          if (data.error.code === 429) {
            console.warn('  ⚠️  Daily API quota exceeded — stopping');
            return allItems;
          }
          console.warn(`  ⚠️  API error: ${data.error.message}`);
          return allItems;
        }

        if (data.items && data.items.length > 0) {
          allItems.push(...data.items);
        }

        // No more pages available
        if (!data.queries?.nextPage) break;

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
    const company = this._extractCompany(item.title, item.displayLink);
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

      for (const item of items) {
        // Deduplicate within this run by URL
        if (seenUrls.has(item.link)) continue;
        seenUrls.add(item.link);

        const job = this.parseResultToJob(item);
        job.source = dork.dork_id;
        allJobs.push(job);
        added++;
      }

      console.log(`  Found ${items.length} results, ${added} unique`);

      // Rate limit between queries
      await this._delay(2000);
    }

    console.log(`\n📊 Total unique jobs from dorks: ${allJobs.length}`);
    return allJobs;
  }

  // --- Private helpers ---

  _cleanTitle(rawTitle) {
    // Strip common ATS suffixes like "Job Title - Company | Workday"
    return rawTitle
      .replace(/\s*[\|–—-]\s*(Workday|Greenhouse|iCIMS|Lever|SmartRecruiters|Phenom|Jobvite|Ashby|Eightfold).*$/i, '')
      .replace(/\s*[\|–—-]\s*[^|–—-]+$/, '') // Strip last " - Whatever" segment (usually ATS/company)
      .trim();
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

  _delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

import puppeteer from 'puppeteer-core';
import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { getKeywords, getLocations } from './sites-config.js';

dotenv.config();

export class JobScraper {
  constructor(options = {}) {
    this.browser = null;
    this.chromePath = options.chromePath || null;
  }

  _findChrome() {
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

  async initialize() {
    const launchOpts = {
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu'
      ]
    };
    const execPath = this.chromePath || this._findChrome();
    if (execPath) launchOpts.executablePath = execPath;
    this.browser = await puppeteer.launch(launchOpts);
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
    }
  }

  isRelevantJob(title, location) {
    const titleLower = title.toLowerCase();
    const locationLower = (location || '').toLowerCase();
    const matchMode = process.env._CF_ACTIVE_MATCH_MODE || 'contains';

    // Must match at least one keyword using the active match mode
    const keywords = getKeywords().filter(k => k.trim().length > 0);
    if (keywords.length === 0) return false; // No valid keywords — reject all
    const hasKeyword = keywords.some(keyword => {
      const kw = keyword.toLowerCase().trim();
      switch (matchMode) {
        case 'exact':    return titleLower === kw;
        case 'begins':   return titleLower.startsWith(kw);
        case 'ends':     return titleLower.endsWith(kw);
        case 'contains':
        default:         return titleLower.includes(kw);
      }
    });

    if (!hasKeyword) return false;

    // Location matching always uses "contains" (locations are inherently partial matches)
    if (location && locationLower) {
      const locations = getLocations();
      const hasLocation = locations.some(loc =>
        locationLower.includes(loc.toLowerCase())
      );
      return hasLocation;
    }

    return true; // Include if no location specified
  }

  isRelevantLocation(location) {
    const locationLower = (location || '').toLowerCase();

    // If no location specified, include the job
    if (!location || !locationLower) return true;

    // Check if location matches preferences
    const locations = getLocations();
    const hasLocation = locations.some(loc =>
      locationLower.includes(loc.toLowerCase())
    );
    return hasLocation;
  }

  async scrapeWithAI(page, siteConfig) {
    const pageText = await page.evaluate(() => document.body.innerText);
    const pageUrl = page.url();

    // Also extract all links from the page for URL resolution
    const links = await page.evaluate(() => {
      const anchors = document.querySelectorAll('a[href]');
      return Array.from(anchors).map(a => ({
        text: a.textContent.trim(),
        href: a.href
      }));
    });

    const client = new Anthropic();

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 8192,
      messages: [{
        role: 'user',
        content: `Extract job listings from the following page text. The page is from "${siteConfig.name}" at ${pageUrl}.

Return a JSON array of job objects with these fields:
- "title": the job title (string)
- "company": the company name (string), use "${siteConfig.name}" if not specified per-listing
- "url": the job listing URL (string) - match titles to URLs from the links list below
- "location": the job location (string), use "" if not found

Links on the page:
${JSON.stringify(links.slice(0, 200))}

Page text:
${pageText.slice(0, 12000)}

Return ONLY a valid JSON array, no other text. If no jobs are found, return [].`
      }]
    });

    let content = response.content[0].text.trim();
    // Strip markdown code fences if present
    content = content.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
    try {
      const jobs = JSON.parse(content);
      return Array.isArray(jobs) ? jobs : [];
    } catch (err) {
      console.error(`  AI extraction returned invalid JSON for ${siteConfig.name}:`, err.message);
      return [];
    }
  }

  async scrapeSite(siteConfig) {
    const page = await this.browser.newPage();
    
    try {
      // Set user agent to avoid bot detection
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );
      
      // Block unnecessary resources to speed up
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        const resourceType = request.resourceType();
        if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
          request.abort();
        } else {
          request.continue();
        }
      });
      
      // Progress logged by scrapeAllSites; log here only for standalone calls
      if (!this._batchMode) console.log(`Scraping ${siteConfig.name}...`);

      // Dynamically inject current keyword into URLs with search query params
      let targetUrl = siteConfig.url;
      try {
        const urlObj = new URL(targetUrl);
        const searchParams = ['q', 'query', 'keywords', 'keyword', 'Keywords', 'search', 'field_keyword'];
        const keywords = getKeywords().filter(k => k.trim().length > 0);
        if (keywords.length > 0) {
          for (const param of searchParams) {
            if (urlObj.searchParams.has(param)) {
              urlObj.searchParams.set(param, keywords[0]);
            }
          }
        }
        targetUrl = urlObj.toString();
      } catch {
        // URL parse failed — use original
      }

      // Navigate with timeout
      await page.goto(targetUrl, {
        waitUntil: 'networkidle2',
        timeout: 15000
      });

      // Wait for content to load
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      // Extract jobs - use AI extraction or CSS selectors
      let jobs;

      if (siteConfig.useAIExtraction) {
        console.log(`  Using AI extraction for ${siteConfig.name}`);
        jobs = await this.scrapeWithAI(page, siteConfig);
      } else {
        jobs = await page.evaluate((config) => {
        const results = [];
        const jobElements = document.querySelectorAll(config.selectors.jobCard);

        jobElements.forEach((el) => {
          try {
            const titleEl = el.querySelector(config.selectors.title);
            const locationEl = el.querySelector(config.selectors.location);
            let linkEl = el.querySelector(config.selectors.link);

            if (titleEl) {
              const title = titleEl.textContent.trim();
              const location = locationEl ? locationEl.textContent.trim() : '';

              // Try to find URL from multiple sources
              let url = null;

              // 1. Check if linkEl has href
              if (linkEl && (linkEl.href || linkEl.getAttribute('href'))) {
                url = linkEl.href || linkEl.getAttribute('href');
              }
              // 2. Check if titleEl itself has href
              else if (titleEl.href || titleEl.getAttribute('href')) {
                url = titleEl.href || titleEl.getAttribute('href');
              }
              // 3. Check if titleEl is inside an <a> tag (parent)
              else {
                let parent = titleEl.parentElement;
                for (let i = 0; i < 5 && parent; i++) {
                  if (parent.tagName === 'A' && parent.href) {
                    url = parent.href;
                    break;
                  }
                  parent = parent.parentElement;
                }
              }
              // 4. Fallback: find first external job link in the card
              if (!url) {
                const externalLink = el.querySelector('a[href*="career"], a[href*="job-details"], a[href*="/jobs/"]');
                if (externalLink) url = externalLink.href;
              }

              // Make relative URLs absolute
              if (url && !url.startsWith('http')) {
                url = new URL(url, window.location.origin).href;
              }

              if (title && url) {
                results.push({
                  title,
                  location,
                  url,
                  company: config.name
                });
              }
            }
          } catch (err) {
            // Skip problematic elements
            console.error('Error parsing element:', err.message);
          }
        });

        return results;
      }, siteConfig);
      }

      // Filter for relevant jobs (skip keyword filter if site is marked to skip)
      const relevantJobs = siteConfig.skipKeywordFilter
        ? jobs.filter(job => this.isRelevantLocation(job.location))
        : jobs.filter(job => this.isRelevantJob(job.title, job.location));

      console.log(`  Found ${relevantJobs.length} relevant jobs out of ${jobs.length} total${siteConfig.skipKeywordFilter ? ' (keyword filter skipped)' : ''}`);
      
      await page.close();
      return relevantJobs;
      
    } catch (error) {
      console.error(`Error scraping ${siteConfig.name}:`, error.message);
      await page.close();
      return [];
    }
  }

  _progressPath() {
    return path.join(process.cwd(), '.scraper-progress.json');
  }

  _writeProgress(progress) {
    try {
      fs.writeFileSync(this._progressPath(), JSON.stringify(progress));
    } catch { /* best-effort */ }
  }

  _clearProgress() {
    try {
      const p = this._progressPath();
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch { /* best-effort */ }
  }

  async scrapeAllSites(sites) {
    const CONCURRENCY = 3;
    const RESTART_EVERY = 50; // Restart Chrome every N sites per worker
    const allJobs = [];
    const total = sites.length;
    let completed = 0;
    let errors = 0;
    let queueIndex = 0;
    const activeWorkers = new Map(); // workerId -> site name

    this._batchMode = true;

    const updateProgress = () => {
      this._writeProgress({
        total,
        completed,
        errors,
        jobsFound: allJobs.length,
        active: Array.from(activeWorkers.values()),
        startedAt: startTime,
        updatedAt: Date.now()
      });
    };

    const startTime = Date.now();
    updateProgress();

    // Create worker browsers
    const workers = [];
    for (let w = 0; w < Math.min(CONCURRENCY, total); w++) {
      const scraper = new JobScraper({ chromePath: this.chromePath });
      await scraper.initialize();
      scraper._batchMode = true;
      workers.push(scraper);
    }

    const runWorker = async (workerId, scraper) => {
      let sitesSinceRestart = 0;

      while (true) {
        const idx = queueIndex++;
        if (idx >= total) break;

        const site = sites[idx];
        activeWorkers.set(workerId, site.name);
        console.log(`[${idx + 1}/${total}] (w${workerId + 1}) ${site.name}`);
        updateProgress();

        // Restart browser periodically to reclaim memory
        sitesSinceRestart++;
        if (sitesSinceRestart > RESTART_EVERY) {
          console.log(`  [w${workerId + 1}] Recycling Chrome after ${RESTART_EVERY} sites...`);
          try { await scraper.close(); } catch { /* ignore */ }
          await scraper.initialize();
          sitesSinceRestart = 0;
        }

        try {
          const jobs = await scraper.scrapeSite(site);
          allJobs.push(...jobs);
        } catch (error) {
          errors++;
          console.error(`  [${idx + 1}/${total}] (w${workerId + 1}) Failed: ${site.name}: ${error.message}`);
          // If browser crashed, restart it
          if (error.message.includes('disconnected') || error.message.includes('closed') || error.message.includes('Target closed')) {
            console.log(`  [w${workerId + 1}] Chrome crashed, restarting...`);
            try { await scraper.close(); } catch { /* ignore */ }
            await scraper.initialize();
            sitesSinceRestart = 0;
          }
        }

        completed++;
        activeWorkers.delete(workerId);
        updateProgress();

        // Brief pause between sites
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      // Shut down this worker's browser
      try { await scraper.close(); } catch { /* ignore */ }
    };

    // Run all workers concurrently
    console.log(`Starting ${workers.length} concurrent workers for ${total} sites...\n`);
    await Promise.all(workers.map((scraper, i) => runWorker(i, scraper)));

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    console.log(`\nScrape complete: ${total} sites, ${allJobs.length} jobs found, ${errors} errors, ${elapsed}s elapsed`);
    this._clearProgress();
    return allJobs;
  }
}

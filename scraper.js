import puppeteer from 'puppeteer';
import { KEYWORDS, LOCATIONS } from './sites-config.js';

export class JobScraper {
  constructor() {
    this.browser = null;
  }

  async initialize() {
    this.browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu'
      ]
    });
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
    }
  }

  isRelevantJob(title, location) {
    const titleLower = title.toLowerCase();
    const locationLower = (location || '').toLowerCase();
    
    // Must match at least one keyword
    const hasKeyword = KEYWORDS.some(keyword => 
      titleLower.includes(keyword.toLowerCase())
    );
    
    if (!hasKeyword) return false;
    
    // If location specified, check if it matches preferences
    if (location && locationLower) {
      const hasLocation = LOCATIONS.some(loc => 
        locationLower.includes(loc.toLowerCase())
      );
      return hasLocation;
    }
    
    return true; // Include if no location specified
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
      
      console.log(`Scraping ${siteConfig.name}...`);
      
      // Navigate with timeout
      await page.goto(siteConfig.url, {
        waitUntil: 'networkidle2',
        timeout: 30000
      });
      
      // Wait for content to load
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Extract jobs
      const jobs = await page.evaluate((config) => {
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
      
      // Filter for relevant jobs
      const relevantJobs = jobs.filter(job => 
        this.isRelevantJob(job.title, job.location)
      );
      
      console.log(`  Found ${relevantJobs.length} relevant jobs out of ${jobs.length} total`);
      
      await page.close();
      return relevantJobs;
      
    } catch (error) {
      console.error(`Error scraping ${siteConfig.name}:`, error.message);
      await page.close();
      return [];
    }
  }

  async scrapeAllSites(sites) {
    const allJobs = [];
    
    for (const site of sites) {
      try {
        const jobs = await this.scrapeSite(site);
        allJobs.push(...jobs);
        
        // Be polite - wait between sites
        await new Promise(resolve => setTimeout(resolve, 2000));
        
      } catch (error) {
        console.error(`Failed to scrape ${site.name}:`, error.message);
      }
    }
    
    return allJobs;
  }
}

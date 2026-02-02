import puppeteer from 'puppeteer';
import { parse } from 'csv-parse/sync';
import { readFileSync, writeFileSync } from 'fs';

const CAREER_KEYWORDS = ['career', 'jobs', 'job', 'work-with-us', 'join-us', 'employment', 'hiring', 'opportunities', 'join-our-team', 'work-here'];

async function discoverCareerPage(browser, companyName, homeUrl) {
  const page = await browser.newPage();

  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Try the home page first
    await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });

    // Look for career-related links
    const careerLink = await page.evaluate((keywords) => {
      const links = Array.from(document.querySelectorAll('a[href]'));
      for (const link of links) {
        const href = link.href.toLowerCase();
        const text = link.textContent.toLowerCase();
        for (const keyword of keywords) {
          if (href.includes(keyword) || text.includes(keyword)) {
            return link.href;
          }
        }
      }
      return null;
    }, CAREER_KEYWORDS);

    if (careerLink) {
      console.log(`✅ ${companyName}: ${careerLink}`);
      return { company: companyName, careerUrl: careerLink, status: 'found' };
    }

    // Try common career paths
    const commonPaths = ['/careers', '/jobs', '/about/careers', '/company/careers', '/join-us'];
    for (const path of commonPaths) {
      try {
        const testUrl = new URL(path, homeUrl).href;
        const response = await page.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: 8000 });
        if (response && response.status() === 200) {
          console.log(`✅ ${companyName}: ${testUrl} (guessed)`);
          return { company: companyName, careerUrl: testUrl, status: 'guessed' };
        }
      } catch (e) {
        // Path doesn't exist, continue
      }
    }

    console.log(`⚠️  ${companyName}: No career page found, using home page`);
    return { company: companyName, careerUrl: homeUrl, status: 'home_only' };

  } catch (error) {
    console.log(`❌ ${companyName}: Error - ${error.message}`);
    return { company: companyName, careerUrl: homeUrl, status: 'error', error: error.message };
  } finally {
    await page.close();
  }
}

async function main() {
  console.log('🔍 Discovering career pages...\n');

  // Read and parse the CSV
  const csvContent = readFileSync('companies-to-add.csv', 'utf-8');
  const records = parse(csvContent, { columns: true, skip_empty_lines: true, bom: true });

  // Clean up records
  const companies = records
    .filter(r => r.Company && r.website)
    .map(r => ({
      name: r.Company.replace(/^"+|"+$/g, '').replace(/,\s*Inc\.?"+?$/i, ' Inc').trim(),
      website: r.website.startsWith('http') ? r.website : `https://${r.website}`
    }));

  console.log(`Found ${companies.length} companies to process\n`);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const results = [];

  for (let i = 0; i < companies.length; i++) {
    const { name, website } = companies[i];
    console.log(`[${i + 1}/${companies.length}] Checking ${name}...`);
    const result = await discoverCareerPage(browser, name, website);
    results.push(result);

    // Small delay between requests
    await new Promise(r => setTimeout(r, 500));
  }

  await browser.close();

  // Generate CSV output
  const csvLines = results.map(r => {
    const escapedName = r.company.includes(',') ? `"${r.company}"` : r.company;
    const note = r.status === 'found' ? 'Career page found' :
                 r.status === 'guessed' ? 'Career path guessed' :
                 r.status === 'error' ? `Error: ${r.error}` : 'Home page only';
    return `${escapedName},${r.careerUrl},.job-card,h3,.location,a,false,${note}`;
  });

  writeFileSync('companies-discovered.csv',
    'company_name,careers_url,job_card_selector,title_selector,location_selector,link_selector,enabled,notes\n' +
    csvLines.join('\n') + '\n'
  );

  // Summary
  const found = results.filter(r => r.status === 'found').length;
  const guessed = results.filter(r => r.status === 'guessed').length;
  const homeOnly = results.filter(r => r.status === 'home_only').length;
  const errors = results.filter(r => r.status === 'error').length;

  console.log('\n📊 Summary:');
  console.log(`   Career pages found: ${found}`);
  console.log(`   Career paths guessed: ${guessed}`);
  console.log(`   Home page only: ${homeOnly}`);
  console.log(`   Errors: ${errors}`);
  console.log(`\n✅ Results saved to companies-discovered.csv`);
}

main().catch(console.error);

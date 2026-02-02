import puppeteer from 'puppeteer';

async function main() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

  console.log('\n=== Finding correct link selector ===\n');
  await page.goto('https://jobs.insightpartners.com/jobs?q=salesforce', {
    waitUntil: 'networkidle2',
    timeout: 30000
  });
  await new Promise(r => setTimeout(r, 3000));

  // Check structure around itemprop="title"
  const result = await page.evaluate(() => {
    const card = document.querySelector('.job-card');
    const titleSpan = card.querySelector('[itemprop="title"]');

    // Get the parent elements to find the link
    let parent = titleSpan;
    let linkParent = null;
    for (let i = 0; i < 5 && parent; i++) {
      if (parent.tagName === 'A' && parent.href) {
        linkParent = parent;
        break;
      }
      parent = parent.parentElement;
    }

    // Also check what links exist in the card
    const links = Array.from(card.querySelectorAll('a[href]')).map(a => ({
      text: a.textContent.trim().substring(0, 30),
      href: a.href.substring(0, 60),
      hasJobInHref: a.href.includes('job') || a.href.includes('career')
    }));

    return {
      titleSpanTag: titleSpan?.tagName,
      titleSpanText: titleSpan?.textContent.trim(),
      parentLinkFound: !!linkParent,
      parentLinkHref: linkParent?.href?.substring(0, 60),
      allLinks: links
    };
  });

  console.log('Title span tag:', result.titleSpanTag);
  console.log('Title text:', result.titleSpanText);
  console.log('Parent link found:', result.parentLinkFound);
  console.log('Parent link href:', result.parentLinkHref);
  console.log('\nAll links in card:');
  result.allLinks.forEach((l, i) => {
    console.log(`  [${i}] ${l.hasJobInHref ? '✓' : ' '} ${l.text} -> ${l.href}`);
  });

  await browser.close();
}

main().catch(console.error);

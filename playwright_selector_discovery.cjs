/**
 * playwright_selector_discovery.cjs
 *
 * Pass 1: Uses Playwright (headless Chromium) + DOM heuristics to discover
 * CSS selectors for job listings on custom company career pages.
 *
 * NO AI calls, NO external APIs — completely free.
 *
 * Only processes companies that ats_api_discovery.cjs already marked as
 * "No known ATS platform detected", so it's safe to run alongside or after.
 *
 * Usage:
 *   node playwright_selector_discovery.cjs
 *   node playwright_selector_discovery.cjs --sample 10
 *   node playwright_selector_discovery.cjs --agent-id pw-1
 *   node playwright_selector_discovery.cjs --dry-run
 *
 * Env vars: DATABASE_URL
 */

require('dotenv').config();
const { Pool } = require('pg');
const crypto = require('crypto');
const { chromium } = require('playwright');

// ─── CLI args ────────────────────────────────────────────────────────────────

function getArg(name) {
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=')[1];
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return null;
}

const SAMPLE = parseInt(getArg('sample') || '0') || 0;
const AGENT_ID = getArg('agent-id') || `pw-${crypto.randomBytes(4).toString('hex')}`;
const DRY_RUN = process.argv.includes('--dry-run');
const DELAY_MS = 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function withRetry(fn, retries = 3, delayMs = 5000) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); } catch (err) {
      if (i === retries - 1) throw err;
      const isTransient = err.code === 'ENOTFOUND' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
      if (!isTransient) throw err;
      console.log(`  DB error (${err.code}), retrying in ${delayMs / 1000}s... (${i + 1}/${retries})`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

// ─── Neon DB helpers ─────────────────────────────────────────────────────────

async function claimNextCompany() {
  return withRetry(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      UPDATE companies
      SET status = 'pw_processing', agent_id = $1, started_at = NOW(), updated_at = NOW()
      WHERE id = (
        SELECT id FROM companies
        WHERE status = 'done'
          AND selector_confidence = 'failed'
          AND (enabled IS NULL OR LOWER(enabled) IN ('false', '0', 'disabled', 'no', ''))
          AND careers_url IS NOT NULL
          AND careers_url != ''
          AND careers_url LIKE 'http%'
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING *
    `, [AGENT_ID]);
    await client.query('COMMIT');
    return rows[0] || null;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  });
}

async function updateCompanyResult(id, updates) {
  if (DRY_RUN) return;
  return withRetry(() => pool.query(`
    UPDATE companies
    SET careers_url = COALESCE($2, careers_url),
        job_card_selector = $3,
        title_selector = $4,
        location_selector = $5,
        link_selector = $6,
        selector_confidence = $7,
        selector_notes = $8,
        enabled = $9,
        notes = $10,
        status = 'done',
        completed_at = NOW(),
        updated_at = NOW()
    WHERE id = $1
  `, [
    id,
    updates.careers_url || null,
    updates.job_card_selector || '',
    updates.title_selector || '',
    updates.location_selector || '',
    updates.link_selector || '',
    updates.selector_confidence || 'failed',
    updates.selector_notes || '',
    updates.enabled || 'false',
    updates.notes || '',
  ]));
}

async function releaseCompany(id) {
  if (DRY_RUN) return;
  await pool.query(`
    UPDATE companies
    SET status = 'done', agent_id = NULL, started_at = NULL, updated_at = NOW()
    WHERE id = $1
  `, [id]);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Playwright page rendering ───────────────────────────────────────────────

async function renderPage(browser, url) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

  // Block heavy resources
  await page.route('**/*.{png,jpg,jpeg,gif,svg,webp,woff,woff2,ttf,eot,mp4,mp3,avi,mov,ico}', route => route.abort());
  await page.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (['image', 'media', 'font'].includes(type)) return route.abort();
    return route.continue();
  });

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  } catch (err) {
    // Try domcontentloaded fallback
    if (err.message.includes('timeout')) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      } catch {
        await context.close();
        throw new Error(`Page load failed: ${err.message.slice(0, 80)}`);
      }
    } else {
      await context.close();
      throw err;
    }
  }

  // Try to dismiss cookie banners
  try {
    await page.click('[class*="accept" i], [class*="consent" i], [id*="accept" i], [class*="agree" i], button:has-text("Accept"), button:has-text("OK"), button:has-text("I agree")', { timeout: 2000 });
    await sleep(500);
  } catch {}

  // Scroll to trigger lazy loading
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await sleep(1500);
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(500);

  return { page, context };
}

// ─── DOM heuristic analysis ──────────────────────────────────────────────────

/**
 * Runs inside the browser via page.evaluate().
 * Finds candidate groups of repeated elements and scores them.
 * Returns the best candidate with selectors.
 */
const DOM_ANALYSIS_FN = function () {
  const JOB_KEYWORDS = ['job', 'position', 'opening', 'career', 'apply', 'hiring', 'role',
    'opportunity', 'vacancy', 'posting', 'employment', 'recruit'];
  const ANTI_KEYWORDS = ['blog', 'news', 'article', 'team', 'testimonial', 'review',
    'social', 'footer', 'copyright', 'newsletter', 'subscribe'];
  const LOCATION_PATTERNS = /\b(remote|hybrid|on-?site|usa|uk|canada|australia|germany|india|singapore)\b|,\s*[A-Z]{2}\b|\b[A-Z][a-z]+,\s*[A-Z][a-z]/;
  const TITLE_LIKE_PATTERNS = /\b(engineer|developer|manager|analyst|designer|coordinator|specialist|consultant|director|architect|lead|senior|junior|intern|associate|administrator|support|sales|marketing|product|data|software|cloud|devops|full.?stack|front.?end|back.?end)\b/i;

  // ── Phase A: Find candidate groups ──

  function getCSSSelector(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;

    const classes = [...el.classList].filter(c =>
      c.length > 1 && c.length < 50 && !/^[a-z]{1,2}\d|^css-|^sc-|^_|^\d/.test(c)
    );

    if (classes.length > 0) {
      // Pick the most semantic class
      const semantic = classes.find(c =>
        JOB_KEYWORDS.some(k => c.toLowerCase().includes(k)) ||
        /list|card|item|row|post|entry|result/.test(c.toLowerCase())
      ) || classes[0];
      const sel = `.${CSS.escape(semantic)}`;
      // Check uniqueness relative to what we need
      return sel;
    }

    return el.tagName.toLowerCase();
  }

  function getRelativeSelector(el, ancestor) {
    if (!el || el === ancestor) return '';
    if (el.id) return `#${CSS.escape(el.id)}`;

    const classes = [...el.classList].filter(c =>
      c.length > 1 && c.length < 50 && !/^[a-z]{1,2}\d|^css-|^sc-|^_|^\d/.test(c)
    );

    const tag = el.tagName.toLowerCase();

    if (classes.length > 0) {
      const best = classes.find(c =>
        /title|name|heading|position|role|location|loc|city|place|link|url|apply/.test(c.toLowerCase())
      ) || classes[0];
      return `${tag}.${CSS.escape(best)}`;
    }

    // Just use the tag
    return tag;
  }

  const candidates = [];

  // Walk parents that have multiple similar children
  const allElements = document.querySelectorAll('body *');
  const seen = new Set();

  for (const parent of allElements) {
    // Skip tiny containers or deeply nested
    if (parent.children.length < 3) continue;
    const tag = parent.tagName.toLowerCase();
    if (['script', 'style', 'noscript', 'svg', 'head', 'meta'].includes(tag)) continue;

    // Group children by tag name
    const childrenByTag = {};
    for (const child of parent.children) {
      const ctag = child.tagName.toLowerCase();
      if (['script', 'style', 'noscript', 'br', 'hr'].includes(ctag)) continue;
      if (!childrenByTag[ctag]) childrenByTag[ctag] = [];
      childrenByTag[ctag].push(child);
    }

    for (const [childTag, children] of Object.entries(childrenByTag)) {
      if (children.length < 3) continue;

      // Each child must have at least one link and non-trivial text
      const validChildren = children.filter(c => {
        const links = c.querySelectorAll('a[href]');
        const text = c.innerText?.trim() || '';
        return links.length > 0 && text.length > 10;
      });

      if (validChildren.length < 3) continue;

      // Build selector for this group
      const parentSel = getCSSSelector(parent);
      const groupSel = `${parentSel} > ${childTag}`;

      // Deduplicate
      if (seen.has(groupSel)) continue;
      seen.add(groupSel);

      // Verify selector actually works
      const matched = document.querySelectorAll(groupSel);
      if (matched.length < 3) continue;

      candidates.push({
        selector: groupSel,
        parentSelector: parentSel,
        childTag,
        count: validChildren.length,
        matchedCount: matched.length,
        children: validChildren,
        parent,
      });
    }
  }

  // ── Phase B: Score each candidate ──

  const scoredCandidates = candidates.map(cand => {
    let score = 0;
    const notes = [];

    // Combined text of all children
    const allText = cand.children.map(c => c.innerText?.trim() || '').join(' ').toLowerCase();

    // Job keyword density (0-25)
    const kwCount = JOB_KEYWORDS.reduce((sum, kw) => sum + (allText.split(kw).length - 1), 0);
    const kwScore = Math.min(25, Math.round(kwCount / cand.count * 5));
    score += kwScore;

    // Anti-keywords (-5 to -20)
    const antiCount = ANTI_KEYWORDS.reduce((sum, kw) => sum + (allText.split(kw).length - 1), 0);
    if (antiCount > cand.count) {
      score -= Math.min(20, antiCount * 2);
      notes.push('anti-keywords detected');
    }

    // Link density (0-15)
    const linkCounts = cand.children.map(c => c.querySelectorAll('a[href]').length);
    const avgLinks = linkCounts.reduce((a, b) => a + b, 0) / linkCounts.length;
    if (avgLinks >= 0.8 && avgLinks <= 3) score += 15;
    else if (avgLinks > 3) score += 8;
    else score += 5;

    // Structural consistency (0-15)
    const childCounts = cand.children.map(c => c.children.length);
    const avgChildCount = childCounts.reduce((a, b) => a + b, 0) / childCounts.length;
    const childVariance = childCounts.reduce((sum, c) => sum + Math.abs(c - avgChildCount), 0) / childCounts.length;
    score += childVariance < 1 ? 15 : childVariance < 2 ? 10 : childVariance < 4 ? 5 : 0;

    // Text length consistency (0-10)
    const textLens = cand.children.map(c => (c.innerText?.trim() || '').length);
    const avgLen = textLens.reduce((a, b) => a + b, 0) / textLens.length;
    const lenVariance = textLens.reduce((sum, l) => sum + Math.abs(l - avgLen), 0) / textLens.length;
    const lenCV = avgLen > 0 ? lenVariance / avgLen : 1;
    score += lenCV < 0.3 ? 10 : lenCV < 0.5 ? 7 : lenCV < 0.8 ? 4 : 0;

    // Count sweet spot (0-10)
    const count = cand.count;
    score += (count >= 5 && count <= 50) ? 10 : (count >= 3 && count <= 100) ? 7 : 2;

    // Semantic parent signals (0-10)
    const parentClasses = (cand.parent.className || '').toLowerCase() + ' ' + (cand.parent.id || '').toLowerCase();
    const ancestorText = parentClasses + ' ' + [...(cand.parent.closest('[class*="job"],[class*="career"],[class*="position"],[class*="listing"],[class*="opening"],[id*="job"],[id*="career"]')?.classList || [])].join(' ').toLowerCase();
    const semanticHits = JOB_KEYWORDS.filter(kw => ancestorText.includes(kw)).length;
    score += Math.min(10, semanticHits * 5);

    // Location-like content (0-10)
    const hasLocation = cand.children.filter(c => LOCATION_PATTERNS.test(c.innerText || '')).length;
    score += hasLocation >= cand.count * 0.3 ? 10 : hasLocation > 0 ? 5 : 0;

    // Nav/footer penalty
    const isInNav = !!cand.parent.closest('nav, footer, header, [role="navigation"], [role="banner"]');
    if (isInNav) {
      score -= 15;
      notes.push('inside nav/footer');
    }

    // Title-like text bonus
    const titleLikeCount = cand.children.filter(c => TITLE_LIKE_PATTERNS.test(c.innerText || '')).length;
    if (titleLikeCount >= cand.count * 0.3) {
      score += 10;
      notes.push('title-like text found');
    }

    return {
      selector: cand.selector,
      count: cand.count,
      score,
      notes: notes.join('; '),
    };
  });

  // Sort by score descending
  scoredCandidates.sort((a, b) => b.score - a.score);

  if (scoredCandidates.length === 0) {
    return { found: false, candidates: 0 };
  }

  const best = scoredCandidates[0];
  if (best.score < 20) {
    return {
      found: false,
      candidates: scoredCandidates.length,
      bestScore: best.score,
      bestSelector: best.selector,
      reason: 'Best score too low',
    };
  }

  // ── Phase C: Extract sub-selectors from the best candidate ──

  const cards = document.querySelectorAll(best.selector);
  const firstCard = cards[0];
  if (!firstCard) return { found: false, reason: 'Selector matched 0 elements' };

  // Title: heading or prominent link
  let titleSelector = '';
  const titleCandidates = [
    ...firstCard.querySelectorAll('h1, h2, h3, h4, h5, h6'),
    ...firstCard.querySelectorAll('a'),
    ...firstCard.querySelectorAll('[class*="title" i], [class*="name" i], [class*="position" i], [class*="role" i]'),
  ];

  for (const el of titleCandidates) {
    const text = el.innerText?.trim() || '';
    if (text.length > 5 && text.length < 200) {
      titleSelector = getRelativeSelector(el, firstCard);
      break;
    }
  }

  // Link: most relevant <a>
  let linkSelector = '';
  const links = firstCard.querySelectorAll('a[href]');
  for (const a of links) {
    const href = a.getAttribute('href') || '';
    if (/\/(job|career|position|opening|apply|posting)s?\b/i.test(href) || /\/\d{4,}/.test(href)) {
      linkSelector = getRelativeSelector(a, firstCard);
      break;
    }
  }
  if (!linkSelector && links.length > 0) {
    linkSelector = getRelativeSelector(links[0], firstCard);
  }

  // Location: element with location-like class or content
  let locationSelector = '';
  const locCandidates = firstCard.querySelectorAll('[class*="location" i], [class*="loc" i], [class*="city" i], [class*="place" i], [class*="region" i]');
  if (locCandidates.length > 0) {
    locationSelector = getRelativeSelector(locCandidates[0], firstCard);
  } else {
    // Scan small text elements for location patterns
    const smallEls = firstCard.querySelectorAll('span, p, div, small');
    for (const el of smallEls) {
      const text = el.innerText?.trim() || '';
      if (text.length > 2 && text.length < 100 && LOCATION_PATTERNS.test(text)) {
        locationSelector = getRelativeSelector(el, firstCard);
        break;
      }
    }
  }

  // ── Phase D: Validate ──

  let validCount = 0;
  const sampleTitles = [];
  for (const card of cards) {
    const titleEl = titleSelector ? card.querySelector(titleSelector) : null;
    const linkEl = linkSelector ? card.querySelector(linkSelector) : null;
    const titleText = titleEl?.innerText?.trim() || '';
    const hasLink = linkEl?.getAttribute('href');

    if (titleText.length > 3 && hasLink) {
      validCount++;
      if (sampleTitles.length < 3) sampleTitles.push(titleText.slice(0, 60));
    }
  }

  const validRatio = cards.length > 0 ? validCount / cards.length : 0;
  let confidence;
  if (validCount >= 3 && validRatio >= 0.8) confidence = 'high';
  else if (validCount >= 3 && validRatio >= 0.5) confidence = 'medium';
  else if (validCount >= 1) confidence = 'low';
  else confidence = 'failed';

  return {
    found: true,
    candidates: scoredCandidates.length,
    best: {
      job_card_selector: best.selector,
      title_selector: titleSelector,
      location_selector: locationSelector,
      link_selector: linkSelector,
      score: best.score,
      cardCount: cards.length,
      validCount,
      validRatio: Math.round(validRatio * 100),
      confidence,
      sampleTitles,
      notes: best.notes,
    },
    // Top 3 for debugging
    top3: scoredCandidates.slice(0, 3).map(c => ({
      selector: c.selector,
      score: c.score,
      count: c.count,
    })),
  };
};

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('Missing DATABASE_URL in .env');
    process.exit(1);
  }

  const { rows: [{ count: totalCount }] } = await pool.query('SELECT COUNT(*) AS count FROM companies');
  console.log(`Connected to Neon. ${totalCount} total companies.`);
  console.log(`Agent ID: ${AGENT_ID}${DRY_RUN ? ' (DRY RUN)' : ''}`);

  const { rows: [{ count: eligibleCount }] } = await pool.query(
    `SELECT COUNT(*) AS count FROM companies
     WHERE status = 'done' AND selector_confidence = 'failed'
       AND (enabled IS NULL OR LOWER(enabled) IN ('false', '0', 'disabled', 'no', ''))
       AND careers_url IS NOT NULL AND careers_url != '' AND careers_url LIKE 'http%'`
  );
  console.log(`Eligible companies (ATS-failed, has URL): ${eligibleCount}`);

  if (parseInt(eligibleCount) === 0) {
    console.log('No eligible companies to process. Run ats_api_discovery.cjs first.');
    await pool.end();
    return;
  }

  // Launch browser
  console.log('Launching Chromium...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-gpu', '--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors'],
  });
  console.log('Browser ready.\n');

  let processed = 0, highConf = 0, medConf = 0, lowConf = 0, failed = 0;
  const limit = SAMPLE > 0 ? SAMPLE : Infinity;

  while (processed < limit) {
    const row = await claimNextCompany();
    if (!row) {
      console.log('\nNo more eligible companies.');
      break;
    }

    const name = row.company_name;
    const url = row.careers_url;
    console.log(`[${processed + 1}] ${name} — ${url}`);

    let page, context;
    try {
      // Render the page
      const startTime = Date.now();
      ({ page, context } = await renderPage(browser, url));
      const renderMs = Date.now() - startTime;

      // Check for login redirect
      const finalUrl = page.url();
      if (/login|signin|sso|auth|saml/i.test(finalUrl)) {
        console.log(`  ✗ Redirected to login: ${finalUrl}`);
        await updateCompanyResult(row.id, {
          ...row, selector_confidence: 'failed',
          selector_notes: `Playwright: redirected to login page (${finalUrl.slice(0, 80)})`,
        });
        failed++;
        processed++;
        await context.close();
        continue;
      }

      // Check for blank page
      const bodyLen = await page.evaluate(() => document.body?.innerText?.length || 0);
      if (bodyLen < 100) {
        console.log(`  ✗ Page is blank or too short (${bodyLen} chars)`);
        await updateCompanyResult(row.id, {
          ...row, selector_confidence: 'failed',
          selector_notes: `Playwright: page body too short (${bodyLen} chars)`,
        });
        failed++;
        processed++;
        await context.close();
        continue;
      }

      console.log(`  → Rendered in ${(renderMs / 1000).toFixed(1)}s (${bodyLen} chars)`);

      // Run DOM analysis
      const result = await page.evaluate(DOM_ANALYSIS_FN);
      await context.close();

      if (!result.found) {
        console.log(`  ✗ No job listings found (${result.candidates || 0} candidates, best score: ${result.bestScore || 0})`);
        await updateCompanyResult(row.id, {
          ...row, selector_confidence: 'failed',
          selector_notes: `Playwright: ${result.reason || 'no viable candidates'} (${result.candidates || 0} groups analyzed)`,
        });
        failed++;
      } else {
        const b = result.best;
        console.log(`  → ${result.candidates} candidate groups, best score: ${b.score}`);
        console.log(`  → Card: ${b.job_card_selector} (${b.cardCount} cards, ${b.validCount} valid)`);
        console.log(`  → Title: ${b.title_selector} | Location: ${b.location_selector} | Link: ${b.link_selector}`);
        console.log(`  → Confidence: ${b.confidence} | Samples: ${b.sampleTitles.join(', ')}`);

        const newEnabled = (b.confidence === 'high' || b.confidence === 'medium') ? 'true' : row.enabled;

        await updateCompanyResult(row.id, {
          careers_url: url,
          job_card_selector: b.job_card_selector,
          title_selector: b.title_selector,
          location_selector: b.location_selector,
          link_selector: b.link_selector,
          selector_confidence: b.confidence,
          selector_notes: `Playwright heuristic (score: ${b.score}, ${b.cardCount} cards, ${b.validRatio}% valid). ${b.notes}`.trim(),
          enabled: newEnabled,
          notes: row.notes || '',
        });

        if (b.confidence === 'high') highConf++;
        else if (b.confidence === 'medium') medConf++;
        else if (b.confidence === 'low') lowConf++;
        else failed++;
      }

    } catch (err) {
      console.log(`  ✗ Error: ${err.message.slice(0, 100)}`);
      try {
        await updateCompanyResult(row.id, {
          ...row, selector_confidence: 'failed',
          selector_notes: `Playwright error: ${err.message.slice(0, 120)}`,
        });
      } catch {
        await releaseCompany(row.id).catch(() => {});
      }
      failed++;
      if (context) await context.close().catch(() => {});
    }

    processed++;
    if (processed < limit) await sleep(DELAY_MS);
  }

  await browser.close();

  console.log('\n' + '='.repeat(60));
  console.log('Done!');
  console.log(`  Agent:     ${AGENT_ID}`);
  console.log(`  Processed: ${processed}`);
  console.log(`  High:      ${highConf}`);
  console.log(`  Medium:    ${medConf}`);
  console.log(`  Low:       ${lowConf}`);
  console.log(`  Failed:    ${failed}`);
  console.log('='.repeat(60));

  await pool.end();
}

main().catch(async (err) => {
  console.error('Fatal error:', err);
  await pool.end().catch(() => {});
  process.exit(1);
});

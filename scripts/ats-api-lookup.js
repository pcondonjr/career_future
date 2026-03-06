#!/usr/bin/env node
/**
 * ATS API Lookup — check public ATS APIs to discover hidden job boards.
 *
 * Many companies in companies-weekly.csv embed Greenhouse/Lever/Ashby/Workable
 * on their own domain, so hostname-based ATS detection missed them. This script
 * generates slug candidates from company names and domains, then hits public
 * APIs to find actual boards. Matches get correct URLs, selectors, and enabled=true.
 *
 * Usage:
 *   node scripts/ats-api-lookup.js              # Run lookup, update CSV
 *   node scripts/ats-api-lookup.js --dry-run    # Preview matches only
 *   node scripts/ats-api-lookup.js --resume     # Resume from checkpoint
 *   node scripts/ats-api-lookup.js --stats      # Show current progress
 */
import fsp from 'fs/promises';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse/sync';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// === File paths ===
const WEEKLY_CSV = path.join(ROOT, 'data', 'companies-weekly.csv');
const PROGRESS_FILE = path.join(__dirname, 'ats-lookup-progress.json');

// === Configuration ===
const CONCURRENCY = 5;
const HTTP_TIMEOUT = 8000;
const DELAY_BETWEEN_BATCHES = 300;

// === ATS Definitions ===
// Each ATS has: API check URL, board URL for CSV, selectors, and response validator.
const ATS_CONFIGS = {
  greenhouse: {
    name: 'Greenhouse',
    apiUrl: slug => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`,
    boardUrl: slug => `https://job-boards.greenhouse.io/${slug}`,
    selectors: { card: '.opening', title: 'a', location: '.location', link: 'a' },
    validate: async (res) => {
      if (!res.ok) return false;
      try {
        const data = await res.json();
        return data && Array.isArray(data.jobs);
      } catch { return false; }
    },
  },
  lever: {
    name: 'Lever',
    apiUrl: slug => `https://api.lever.co/v0/postings/${slug}`,
    boardUrl: slug => `https://jobs.lever.co/${slug}`,
    selectors: { card: '.posting', title: 'h5', location: '.sort-by-location', link: '.posting-title' },
    validate: async (res) => {
      if (!res.ok) return false;
      try {
        const data = await res.json();
        return Array.isArray(data) && data.length > 0;
      } catch { return false; }
    },
  },
  ashby: {
    name: 'Ashby',
    apiUrl: slug => `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
    boardUrl: slug => `https://jobs.ashbyhq.com/${slug}`,
    selectors: { card: '.job-card', title: '[itemprop="title"]', location: '[itemprop="addressLocality"]', link: 'a' },
    validate: async (res) => {
      if (!res.ok) return false;
      try {
        const data = await res.json();
        return data && (data.jobs || data.jobPostings || data.title);
      } catch { return false; }
    },
  },
  workable: {
    name: 'Workable',
    apiUrl: slug => `https://apply.workable.com/api/v1/widget/accounts/${slug}`,
    boardUrl: slug => `https://apply.workable.com/${slug}`,
    selectors: { card: '[data-ui="job"]', title: 'h3', location: '.job-details span', link: 'a' },
    validate: async (res) => {
      if (!res.ok) return false;
      try {
        const data = await res.json();
        return data && (data.jobs || data.name || data.id);
      } catch { return false; }
    },
  },
};

// ============================================================
// Utility helpers
// ============================================================
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function escapeCsvField(val) {
  if (!val) return '';
  val = String(val);
  if (val.includes(',') || val.includes('"') || val.includes('\n')) {
    return '"' + val.replace(/"/g, '""') + '"';
  }
  return val;
}

async function safeFetch(url, opts = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeout || HTTP_TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        ...(opts.headers || {}),
      },
    });
    return res;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================
// Slug generation
// ============================================================
function generateSlugs(companyName, careersUrl) {
  const slugs = new Set();

  // Clean company name: strip -Apollo suffix, Inc., Corp, LLC, etc.
  let clean = companyName
    .replace(/-Apollo$/i, '')
    .replace(/\b(Inc\.?|Corp\.?|LLC|Ltd\.?|AG|GmbH|Co\.?|PLC|S\.?A\.?|BV|NV|Pty|SE)\b/gi, '')
    .replace(/[,."'()]/g, '')
    .trim();

  // Variant 1: lowercase, no spaces/special chars
  const compressed = clean.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (compressed.length >= 3) slugs.add(compressed);

  // Variant 2: lowercase with hyphens for spaces
  const hyphenated = clean.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (hyphenated.length >= 3 && hyphenated !== compressed) slugs.add(hyphenated);

  // Variant 3: from domain name (most reliable slug source)
  try {
    const url = new URL(careersUrl);
    const hostname = url.hostname.replace(/^www\./, '');
    const domainSlug = hostname.split('.')[0].toLowerCase();
    if (domainSlug.length >= 3) slugs.add(domainSlug);

    // Also try without hyphens
    const domainCompressed = domainSlug.replace(/-/g, '');
    if (domainCompressed !== domainSlug && domainCompressed.length >= 3) slugs.add(domainCompressed);
  } catch { /* ignore */ }

  return [...slugs];
}

// Generic/common slugs that match real boards but aren't company-specific
const BLACKLISTED_SLUGS = new Set([
  'jobs', 'careers', 'career', 'hiring', 'team', 'work', 'apply', 'talent',
  'home', 'about', 'company', 'join', 'open', 'app', 'api', 'web',
  'dev', 'tech', 'data', 'cloud', 'digital', 'global', 'services',
  'opportunities', 'linkedin', 'google', 'microsoft', 'amazon', 'meta',
  'experian', 'oracle', 'sap', 'ibm',
]);

// ============================================================
// Core lookup logic
// ============================================================
async function checkAts(slug, atsKey) {
  if (BLACKLISTED_SLUGS.has(slug)) return null;

  const ats = ATS_CONFIGS[atsKey];
  const url = ats.apiUrl(slug);
  const res = await safeFetch(url);
  if (!res) return null;
  const valid = await ats.validate(res);
  return valid ? { ats: atsKey, slug, boardUrl: ats.boardUrl(slug) } : null;
}

// Track board URLs already claimed to prevent two companies matching the same board
const claimedBoards = new Set();

async function lookupCompany(companyName, careersUrl) {
  const slugs = generateSlugs(companyName, careersUrl);
  const atsKeys = Object.keys(ATS_CONFIGS);

  // Check all slug+ATS combinations, but stop on first match
  for (const slug of slugs) {
    const results = await Promise.all(atsKeys.map(ats => checkAts(slug, ats)));
    const match = results.find(r => r !== null);
    if (match) {
      // Prevent duplicate board claims
      if (claimedBoards.has(match.boardUrl)) continue;
      claimedBoards.add(match.boardUrl);
      return match;
    }
  }
  return null;
}

// ============================================================
// CSV reading/writing
// ============================================================
async function loadWeeklyCSV() {
  const content = await fsp.readFile(WEEKLY_CSV, 'utf-8');
  const lines = content.split('\n');
  const header = lines[0];
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    // Parse with csv-parse for proper quote handling
    try {
      const parsed = parse(line, { relax_column_count: true, relax_quotes: true });
      if (parsed.length > 0 && parsed[0].length >= 7) {
        rows.push({
          lineIndex: i,
          fields: parsed[0],
          raw: line,
        });
      }
    } catch {
      // Keep raw line for unparseable rows
      rows.push({ lineIndex: i, fields: null, raw: line });
    }
  }

  return { header, rows, originalContent: content };
}

function rowToCsvLine(fields) {
  return fields.map(f => escapeCsvField(f)).join(',');
}

async function writeWeeklyCSV(header, rows) {
  const lines = [header];
  for (const row of rows) {
    if (row.fields) {
      lines.push(rowToCsvLine(row.fields));
    } else {
      lines.push(row.raw);
    }
  }
  // Preserve trailing newline if present
  await fsp.writeFile(WEEKLY_CSV, lines.join('\n') + '\n');
}

// ============================================================
// Progress management
// ============================================================
async function loadProgress() {
  try {
    return JSON.parse(await fsp.readFile(PROGRESS_FILE, 'utf-8'));
  } catch { return { checked: {}, matches: {}, lastUpdated: null }; }
}

async function saveProgress(progress) {
  progress.lastUpdated = new Date().toISOString();
  await fsp.writeFile(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// ============================================================
// Main
// ============================================================
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const resume = args.includes('--resume');
  const statsOnly = args.includes('--stats');

  console.log('=== ATS API Lookup ===\n');

  const { header, rows } = await loadWeeklyCSV();
  const progress = resume ? await loadProgress() : { checked: {}, matches: {}, lastUpdated: null };

  // Seed claimedBoards from existing progress matches
  for (const m of Object.values(progress.matches)) {
    if (m.boardUrl) claimedBoards.add(m.boardUrl);
  }

  // Find candidates: disabled rows with "Needs manual review" or "needs verification"
  const candidates = rows.filter(row => {
    if (!row.fields) return false;
    const enabled = (row.fields[6] || '').toLowerCase();
    const notes = (row.fields[7] || '').toLowerCase();
    return enabled === 'false' && (notes.includes('needs manual review') || notes.includes('needs verification'));
  });

  console.log(`Total CSV rows: ${rows.length}`);
  console.log(`Candidates for lookup: ${candidates.length}`);
  console.log(`Already checked: ${Object.keys(progress.checked).length}`);
  console.log(`Matches found so far: ${Object.keys(progress.matches).length}`);

  if (statsOnly) {
    // Show breakdown by ATS
    const byAts = {};
    for (const m of Object.values(progress.matches)) {
      byAts[m.ats] = (byAts[m.ats] || 0) + 1;
    }
    console.log('\nMatches by ATS:');
    for (const [ats, count] of Object.entries(byAts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${ATS_CONFIGS[ats]?.name || ats}: ${count}`);
    }
    return;
  }

  // Filter to unchecked candidates
  const remaining = candidates.filter(row => {
    const key = row.fields[0].toLowerCase();
    return !progress.checked[key];
  });

  console.log(`Remaining to check: ${remaining.length}\n`);

  if (remaining.length === 0) {
    console.log('All candidates already checked.');
    if (Object.keys(progress.matches).length > 0 && !dryRun) {
      console.log('Applying matches to CSV...');
      applyMatches(rows, progress.matches);
      await writeWeeklyCSV(header, rows);
      console.log('CSV updated.');
    }
    return;
  }

  // Process in batches
  let processed = 0;
  let newMatches = 0;

  for (let i = 0; i < remaining.length; i += CONCURRENCY) {
    const batch = remaining.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (row) => {
        const name = row.fields[0];
        const url = row.fields[1];
        const match = await lookupCompany(name, url);
        return { row, name, match };
      })
    );

    for (const { row, name, match } of batchResults) {
      const key = name.toLowerCase();
      progress.checked[key] = true;
      if (match) {
        progress.matches[key] = match;
        newMatches++;
        const atsName = ATS_CONFIGS[match.ats].name;
        console.log(`  MATCH: ${name} → ${atsName} (${match.boardUrl})`);
      }
    }

    processed += batch.length;
    process.stdout.write(`\r  Progress: ${processed}/${remaining.length} checked, ${newMatches} new matches`);

    // Checkpoint every 25 companies
    if (processed % 25 < CONCURRENCY) {
      await saveProgress(progress);
    }

    if (i + CONCURRENCY < remaining.length) await delay(DELAY_BETWEEN_BATCHES);
  }

  await saveProgress(progress);
  console.log(`\n\nLookup complete.`);
  console.log(`Total matches: ${Object.keys(progress.matches).length}`);

  // Show breakdown
  const byAts = {};
  for (const m of Object.values(progress.matches)) {
    byAts[m.ats] = (byAts[m.ats] || 0) + 1;
  }
  console.log('\nMatches by ATS:');
  for (const [ats, count] of Object.entries(byAts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${ATS_CONFIGS[ats]?.name || ats}: ${count}`);
  }

  if (dryRun) {
    console.log('\n[DRY RUN] No CSV changes made. Run without --dry-run to apply.');
    return;
  }

  // Apply matches to CSV
  console.log('\nApplying matches to CSV...');
  const applied = applyMatches(rows, progress.matches);
  await writeWeeklyCSV(header, rows);
  console.log(`CSV updated. ${applied} rows modified.`);
}

function applyMatches(rows, matches) {
  let applied = 0;
  for (const row of rows) {
    if (!row.fields) continue;
    const key = row.fields[0].toLowerCase();
    const match = matches[key];
    if (!match) continue;

    const ats = ATS_CONFIGS[match.ats];

    // Update row fields
    row.fields[1] = match.boardUrl;                  // careers_url
    row.fields[2] = ats.selectors.card;              // job_card_selector
    row.fields[3] = ats.selectors.title;             // title_selector
    row.fields[4] = ats.selectors.location;          // location_selector
    row.fields[5] = ats.selectors.link;              // link_selector
    row.fields[6] = 'true';                          // enabled

    // Update notes: replace review status with ATS name
    let notes = row.fields[7] || '';
    notes = notes
      .replace(/Auto-detected selectors - needs verification/i, '')
      .replace(/Needs manual review/i, '')
      .replace(/\s*-\s*$/, '')
      .trim();
    notes = notes ? notes + ' - ' + ats.name + ' ATS' : ats.name + ' ATS';
    row.fields[7] = notes;

    applied++;
  }
  return applied;
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});

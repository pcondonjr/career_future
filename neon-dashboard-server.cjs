/**
 * neon-dashboard-server.cjs
 *
 * Standalone Express server for the Neon-backed job search dashboard.
 * Runs on port 3002 (existing dashboard_server.cjs uses 3001).
 *
 * Routes:
 *   GET  /                    — job postings (triaged YES results)
 *   GET  /pending-review      — companies needing selector verification
 *   GET  /ats-blocked         — ATS blocklist from Neon
 *   GET  /scrape-status       — company scrape status overview
 *   POST /api/approve/:id     — set company scrape_status = 'active'
 *   POST /api/skip/:id        — set company scrape_status = 'disabled'
 *   POST /api/mark-applied/:id — mark a job posting as applied
 *   POST /api/run-scraper     — trigger direct-scraper.cjs manually
 *   GET  /api/stats           — JSON stats for dashboard header
 *
 * Usage:
 *   node neon-dashboard-server.cjs
 *   node neon-dashboard-server.cjs --port 3003
 */

'use strict';

require('dotenv').config();
const express = require('express');
const path    = require('path');
const { Pool } = require('pg');
const { execFile } = require('child_process');

const PORT = parseInt(
  process.argv.find(a => a.startsWith('--port'))?.split('=')[1]
  || (process.argv.indexOf('--port') > -1
      ? process.argv[process.argv.indexOf('--port') + 1]
      : '3002')
) || 3002;

const pool = new Pool({
  connectionString: process.env.CAREER_NEON_URL || process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', '..', 'public')));
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// ── API: Stats ────────────────────────────────────────────────────────────────

app.get('/api/stats', async (req, res) => {
  try {
    const { rows: [co] } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE scrape_status = 'active')         AS active,
        COUNT(*) FILTER (WHERE scrape_status = 'ats_blocked')    AS ats_blocked,
        COUNT(*) FILTER (WHERE scrape_status = 'js_required')    AS js_required,
        COUNT(*) FILTER (WHERE scrape_status = 'pending_review') AS pending_review,
        COUNT(*) FILTER (WHERE scrape_status = 'no_careers')     AS no_careers,
        COUNT(*) FILTER (WHERE scrape_status = 'disabled')       AS disabled,
        COUNT(*)                                                  AS total
      FROM companies
    `);
    const { rows: [jp] } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE triage_result = 'yes')   AS yes_count,
        COUNT(*) FILTER (WHERE triage_result = 'no')    AS no_count,
        COUNT(*) FILTER (WHERE applied = true)          AS applied_count,
        COUNT(*)                                        AS total
      FROM job_postings
    `);
    res.json({ companies: co, job_postings: jp });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: Approve/Skip pending review companies ────────────────────────────────

app.post('/api/approve/:id', async (req, res) => {
  try {
    // enabled must be set alongside scrape_status — direct-scraper.cjs only
    // scrapes WHERE scrape_status='active' AND enabled=true. Approving
    // without this left companies silently unscraped (found 2026-07-05).
    await pool.query(
      `UPDATE companies SET scrape_status = 'active', enabled = true, updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/skip/:id', async (req, res) => {
  try {
    await pool.query(
      `UPDATE companies SET scrape_status = 'disabled', updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: Mark job as applied ──────────────────────────────────────────────────

app.post('/api/mark-applied/:id', async (req, res) => {
  try {
    const { rows: [job] } = await pool.query(
      `UPDATE job_postings SET applied = NOT applied WHERE id = $1 RETURNING applied`,
      [req.params.id]
    );
    res.json({ ok: true, applied: job.applied });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── API: Trigger scraper manually ────────────────────────────────────────────

let scraperRunning = false;

app.post('/api/run-scraper', async (req, res) => {
  if (scraperRunning) {
    return res.status(409).json({ error: 'Scraper already running' });
  }
  scraperRunning = true;
  res.json({ ok: true, message: 'Scraper started' });

  const scraperPath = path.join(__dirname, 'src', 'backend', 'direct-scraper.cjs');
  execFile('node', [scraperPath], { cwd: __dirname }, (err) => {
    scraperRunning = false;
    if (err) console.error('[neon-dashboard] scraper error:', err.message);
    else console.log('[neon-dashboard] scraper run complete');
  });
});

app.get('/api/scraper-status', (req, res) => {
  res.json({ running: scraperRunning });
});

// ── API: Trigger match harness manually ──────────────────────────────────────

let matcherRunning = false;

app.post('/api/run-matcher', async (req, res) => {
  if (matcherRunning) {
    return res.status(409).json({ error: 'Matcher already running' });
  }
  matcherRunning = true;
  res.json({ ok: true, message: 'Matcher started' });

  const matcherPath = path.join(__dirname, 'src', 'backend', 'match-harness.cjs');
  execFile('node', [matcherPath], { cwd: __dirname }, (err) => {
    matcherRunning = false;
    if (err) console.error('[neon-dashboard] matcher error:', err.message);
    else console.log('[neon-dashboard] matcher run complete');
  });
});

app.get('/api/matcher-status', (req, res) => {
  res.json({ running: matcherRunning });
});

// ── View: Job Postings (main dashboard) ───────────────────────────────────────

app.get('/', async (req, res) => {
  try {
    const filter  = req.query.filter || 'yes';   // 'yes' | 'all' | 'applied'
    const source  = req.query.source || 'all';   // 'all' | 'curated' | 'weekly' | 'legacy_daily' | 'legacy_weekly' | 'legacy_dorks'
    const days    = parseInt(req.query.days) || 30;
    const sort    = req.query.sort === 'match' ? 'match' : 'triage';

    const params = [days];
    let whereClause = `WHERE jp.first_seen > NOW() - INTERVAL '1 day' * $1`;
    if (filter === 'yes')     whereClause += ` AND jp.triage_result = 'yes'`;
    if (filter === 'applied') whereClause += ` AND jp.applied = true`;
    if (source !== 'all') {
      params.push(source);
      // Native scrapes carry their source on companies.source (joined); imported
      // legacy rows carry it directly on jp.origin since they have no companies row.
      whereClause += ` AND COALESCE(NULLIF(jp.origin, 'company_scrape'), c.source) = $${params.length}`;
    }

    const orderClause = sort === 'match'
      ? `ORDER BY jp.match_score DESC NULLS LAST, jp.first_seen DESC`
      : `ORDER BY jp.triage_result ASC, jp.first_seen DESC`;

    const { rows: jobs } = await pool.query(`
      SELECT
        jp.id,
        jp.company_name,
        jp.job_title,
        jp.location,
        jp.job_url,
        jp.first_seen,
        jp.last_seen,
        jp.triage_result,
        jp.triage_reason,
        jp.applied,
        jp.match_score,
        jp.match_tier,
        jp.match_reasoning,
        jp.match_skills_matched,
        jp.match_skills_missing,
        COALESCE(NULLIF(jp.origin, 'company_scrape'), c.source) AS source,
        c.notes AS company_notes
      FROM job_postings jp
      LEFT JOIN companies c ON c.company_name = jp.company_name
      ${whereClause}
      ${orderClause}
      LIMIT 200
    `, params);

    const { rows: [counts] } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE triage_result = 'yes' AND first_seen > NOW() - INTERVAL '30 days') AS yes_30d,
        COUNT(*) FILTER (WHERE triage_result = 'yes' AND first_seen > NOW() - INTERVAL '7 days')  AS yes_7d,
        COUNT(*) FILTER (WHERE applied = true)                                                      AS applied,
        COUNT(*) FILTER (WHERE match_score >= 70)                                                    AS strong_matches,
        COUNT(*)                                                                                    AS total
      FROM job_postings
    `);

    res.render('neon-jobs', { jobs, counts, filter, source, days, sort, scraperRunning, matcherRunning });
  } catch (err) {
    res.status(500).send(`<pre>Error: ${err.message}</pre>`);
  }
});

// ── View: Pending Review ──────────────────────────────────────────────────────

app.get('/pending-review', async (req, res) => {
  try {
    const page  = parseInt(req.query.page) || 1;
    const limit = 25;
    const offset = (page - 1) * limit;

    const { rows: companies } = await pool.query(`
      SELECT id, company_name, careers_url, notes, source, hq_state,
             job_card_selector, title_selector, location_selector
      FROM companies
      WHERE scrape_status = 'pending_review'
      ORDER BY source DESC, company_name ASC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    const { rows: [{ total }] } = await pool.query(
      `SELECT COUNT(*) AS total FROM companies WHERE scrape_status = 'pending_review'`
    );

    res.render('neon-pending', {
      companies,
      total: parseInt(total),
      page,
      limit,
      pages: Math.ceil(total / limit),
    });
  } catch (err) {
    res.status(500).send(`<pre>Error: ${err.message}</pre>`);
  }
});

// ── View: ATS Blocked ─────────────────────────────────────────────────────────

app.get('/ats-blocked', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT ab.id, ab.company_name, ab.careers_url, ab.ats_platform,
             ab.date_flagged, ab.source
      FROM ats_blocked ab
      ORDER BY ab.ats_platform, ab.company_name
    `);

    // Group by platform
    const grouped = {};
    rows.forEach(r => {
      const p = r.ats_platform || 'unknown';
      if (!grouped[p]) grouped[p] = [];
      grouped[p].push(r);
    });

    res.render('neon-ats', { grouped, total: rows.length });
  } catch (err) {
    res.status(500).send(`<pre>Error: ${err.message}</pre>`);
  }
});

// ── View: Scrape Status Overview ──────────────────────────────────────────────

app.get('/scrape-status', async (req, res) => {
  try {
    const { rows: statusBreakdown } = await pool.query(`
      SELECT scrape_status, source, COUNT(*) AS count
      FROM companies
      GROUP BY scrape_status, source
      ORDER BY scrape_status, source
    `);

    const { rows: recentlyScrapped } = await pool.query(`
      SELECT company_name, careers_url, scrape_status, source,
             last_scraped, last_job_found
      FROM companies
      WHERE last_scraped IS NOT NULL
      ORDER BY last_scraped DESC
      LIMIT 50
    `);

    const { rows: neverScraped } = await pool.query(`
      SELECT COUNT(*) AS count FROM companies
      WHERE scrape_status = 'active' AND last_scraped IS NULL
    `);

    res.render('neon-status', {
      statusBreakdown,
      recentlyScrapped,
      neverScraped: parseInt(neverScraped[0].count),
      scraperRunning,
    });
  } catch (err) {
    res.status(500).send(`<pre>Error: ${err.message}</pre>`);
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\nNeon Job Dashboard running at http://localhost:${PORT}`);
  console.log(`  Job postings:    http://localhost:${PORT}/`);
  console.log(`  Pending review:  http://localhost:${PORT}/pending-review`);
  console.log(`  ATS blocked:     http://localhost:${PORT}/ats-blocked`);
  console.log(`  Scrape status:   http://localhost:${PORT}/scrape-status\n`);
});

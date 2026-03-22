/**
 * dashboard_server.cjs
 *
 * Simple Express dashboard showing live Neon DB status for selector discovery.
 *
 * Usage:
 *   node dashboard_server.cjs
 *   node dashboard_server.cjs --port 3001
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const PORT = parseInt(process.argv.find(a => a.startsWith('--port'))?.split('=')[1]
              || process.argv[process.argv.indexOf('--port') + 1]
              || '3001') || 3001;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const app = express();

app.get('/api/stats', async (req, res) => {
  try {
    const { rows: [counts] } = await pool.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE status = 'pending') AS pending,
        COUNT(*) FILTER (WHERE status = 'processing') AS processing,
        COUNT(*) FILTER (WHERE status = 'done') AS done,
        COUNT(*) FILTER (WHERE status = 'failed') AS failed,
        COUNT(*) FILTER (WHERE selector_confidence = 'high') AS high_confidence,
        COUNT(*) FILTER (WHERE selector_confidence = 'medium') AS medium_confidence,
        COUNT(*) FILTER (WHERE selector_confidence = 'low') AS low_confidence,
        COUNT(*) FILTER (WHERE LOWER(enabled) = 'true') AS enabled
      FROM companies
    `);

    const { rows: agents } = await pool.query(`
      SELECT agent_id, COUNT(*) AS count, MAX(updated_at) AS last_active
      FROM companies
      WHERE status = 'processing' AND agent_id IS NOT NULL
      GROUP BY agent_id
      ORDER BY last_active DESC
    `);

    const { rows: recent } = await pool.query(`
      SELECT company_name, status, selector_confidence, agent_id, completed_at
      FROM companies
      WHERE status IN ('done', 'failed')
      ORDER BY completed_at DESC
      LIMIT 20
    `);

    res.json({ counts, agents, recent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.listen(PORT, () => {
  console.log(`Selector Discovery Dashboard: http://localhost:${PORT}`);
});

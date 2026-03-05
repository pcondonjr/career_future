#!/usr/bin/env node
/**
 * Compare companies-weekly.csv to enriched-companies-0306.csv
 * and append '-Apollo' to matching company names.
 */
import fs from 'fs';
import { parse } from 'csv-parse/sync';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Load enriched company names (strip -Apollo suffix for matching)
const enriched = parse(
  fs.readFileSync(path.join(ROOT, 'enriched-companies-0306.csv'), 'utf-8'),
  { columns: true, skip_empty_lines: true, relax_column_count: true }
);
const enrichedNames = new Set(
  enriched.map(r => (r['Company Name-Apollo'] || '').replace(/-Apollo$/, '').trim().toLowerCase())
);

console.log(`Enriched companies loaded: ${enrichedNames.size}`);

// Load and update weekly CSV
const weekly = fs.readFileSync(path.join(ROOT, 'data', 'companies-weekly.csv'), 'utf-8');
const lines = weekly.split('\n');
let matched = 0;

const updated = lines.map((line, i) => {
  // Skip header, comments, empty lines
  if (i === 0 || line.startsWith('#') || line.trim() === '') return line;

  // Extract company name (handle quoted names with commas)
  let name;
  let restStart;
  if (line.startsWith('"')) {
    const closeQuote = line.indexOf('"', 1);
    name = line.substring(1, closeQuote);
    restStart = closeQuote + 1; // includes the comma after closing quote
  } else {
    const comma = line.indexOf(',');
    name = line.substring(0, comma);
    restStart = comma;
  }

  // Check if this name matches an enriched company and doesn't already have -Apollo
  if (enrichedNames.has(name.toLowerCase()) && !name.endsWith('-Apollo')) {
    matched++;
    const rest = line.substring(restStart);
    // Re-quote if original was quoted, or if name+Apollo needs quoting
    const newName = name + '-Apollo';
    if (newName.includes(',') || newName.includes('"')) {
      return '"' + newName.replace(/"/g, '""') + '"' + rest;
    }
    return newName + rest;
  }
  return line;
});

console.log(`Matched and updated: ${matched} companies`);
fs.writeFileSync(path.join(ROOT, 'data', 'companies-weekly.csv'), updated.join('\n'));
console.log('Done — companies-weekly.csv updated');

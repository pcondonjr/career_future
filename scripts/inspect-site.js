#!/usr/bin/env node
/**
 * Quick site inspector for job board CSS selectors.
 * Usage: node scripts/inspect-site.js <url>
 */
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';

const url = process.argv[2];
if (!url) { console.error('Usage: node scripts/inspect-site.js <url>'); process.exit(1); }

// Find Chrome/Edge
const candidates = [
  path.join(process.env['PROGRAMFILES'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['LOCALAPPDATA'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  path.join(process.env['PROGRAMFILES'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
];
const chromePath = candidates.find(c => c && fs.existsSync(c));
if (!chromePath) { console.error('No Chrome/Edge found'); process.exit(1); }

console.log('Browser:', chromePath);
console.log('URL:', url, '\n');

const browser = await puppeteer.launch({ headless: 'new', executablePath: chromePath, args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
await new Promise(r => setTimeout(r, 4000));

const result = await page.evaluate(() => {
  const info = {};

  // Job links
  const jobLinks = document.querySelectorAll('a[href*="/jobs/"], a[href*="/job/"], a[href*="/careers/"], a[href*="/position"]');
  info.jobLinksCount = jobLinks.length;
  info.jobLinkSamples = Array.from(jobLinks).slice(0, 6).map(a => ({
    href: a.getAttribute('href'),
    text: a.textContent.trim().substring(0, 100),
    class: (typeof a.className === 'string' ? a.className : '').substring(0, 80),
    parentTag: a.parentElement?.tagName,
    parentClass: a.parentElement?.className?.substring(0, 80),
    gpClass: a.parentElement?.parentElement?.className?.substring(0, 80),
  }));

  // data-testid
  const testIds = document.querySelectorAll('[data-testid]');
  info.dataTestIds = [...new Set(Array.from(testIds).map(el => el.getAttribute('data-testid')))].slice(0, 25);

  // Helper to safely get className as string
  const cls = el => (typeof el.className === 'string' ? el.className : el.getAttribute?.('class') || '');

  // Classes with job/card/listing/item
  const patterns = ['job', 'card', 'listing', 'item', 'posting', 'position', 'result', 'opening'];
  for (const p of patterns) {
    const els = document.querySelectorAll(`[class*="${p}"]`);
    const unique = [...new Set(Array.from(els).map(el => el.tagName + '.' + cls(el).substring(0, 80)))];
    if (unique.length > 0) info[`class_${p}`] = unique.slice(0, 8);
  }

  // Repeating containers (likely job lists)
  const allEls = document.querySelectorAll('div, ul, ol, section');
  const repeating = [];
  for (const el of allEls) {
    if (el.children.length >= 3) {
      const childClasses = Array.from(el.children).map(c => c.className).filter(Boolean);
      const uniqueChildClasses = [...new Set(childClasses)];
      if (uniqueChildClasses.length === 1 && childClasses.length >= 3) {
        repeating.push({
          tag: el.tagName, class: cls(el).substring(0, 80), childCount: el.children.length,
          childTag: el.children[0].tagName, childClass: el.children[0].className?.substring(0, 80),
          sampleText: el.children[0].textContent.trim().substring(0, 120)
        });
      }
    }
  }
  info.repeatingContainers = repeating.slice(0, 8);

  // First 3 cards from most likely container
  if (repeating.length > 0) {
    const best = repeating.sort((a, b) => b.childCount - a.childCount)[0];
    const container = document.querySelector(best.tag + '.' + best.class.split(' ')[0]);
    if (container) {
      info.sampleCards = Array.from(container.children).slice(0, 3).map(card => ({
        fullText: card.innerText.substring(0, 200),
        links: Array.from(card.querySelectorAll('a')).map(a => ({
          href: a.getAttribute('href'), text: a.textContent.trim().substring(0, 80)
        })),
        headings: Array.from(card.querySelectorAll('h1,h2,h3,h4,h5')).map(h => ({
          tag: h.tagName, class: (typeof h.className === 'string' ? h.className : '').substring(0, 60), text: h.textContent.trim().substring(0, 80)
        })),
        spans: Array.from(card.querySelectorAll('span')).map(s => ({
          class: (typeof s.className === 'string' ? s.className : '').substring(0, 60), text: s.textContent.trim().substring(0, 80)
        })).filter(s => s.text)
      }));
    }
  }

  info.bodySnippet = document.body.innerText.substring(0, 500);
  return info;
});

console.log(JSON.stringify(result, null, 2));
await browser.close();

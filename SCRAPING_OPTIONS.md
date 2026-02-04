# Scraping Technology Options

Comparison of approaches for extracting job listings from career sites.

## CSS Selectors (Current Default)

How it works: Use `document.querySelectorAll()` with CSS selectors defined per-site in `companies.csv`.

**Pros:**
- Fast, no external API calls
- Zero cost per scrape
- Deterministic, predictable output
- Works well for sites with stable, semantic HTML

**Cons:**
- Breaks when sites change their DOM structure
- Requires manual selector maintenance per site
- Struggles with non-standard layouts (markdown-rendered pages, SPAs with dynamic classes)
- Each new site requires inspecting the DOM and writing custom selectors

**When to use:** Sites with stable, well-structured HTML and consistent CSS class names (e.g., Ashby-powered job boards, WordPress job plugins).

## XPath

How it works: Use `document.evaluate()` with XPath expressions to traverse the DOM tree.

**Pros:**
- More powerful than CSS selectors for complex traversals
- Can select by text content, position, and axis relationships
- Better at navigating deeply nested structures

**Cons:**
- More verbose and harder to read than CSS selectors
- Still breaks on DOM changes
- Slower than CSS selectors in most browsers
- Not natively supported in Puppeteer's `page.evaluate()` without helpers

**When to use:** When CSS selectors can't express the needed traversal (e.g., "find the `<td>` after the one containing 'Location'").

## AI Extraction (Current Alternative)

How it works: Send rendered page text to Claude API (Haiku) to extract structured job data. Enabled per-site via `use_ai_extraction=true` in `companies.csv`.

**Pros:**
- Resilient to DOM changes -- understands content semantically
- Works on pages with non-standard structures (markdown, plain text lists)
- No per-site selector maintenance
- Can extract data from formats that CSS/XPath can't handle

**Cons:**
- API cost (~$0.01-0.03 per page with Haiku)
- Slower than local DOM parsing (adds ~1-3s per page for API round-trip)
- Non-deterministic -- output may vary slightly between runs
- Requires `ANTHROPIC_API_KEY` in `.env`
- Token limits cap the amount of page text that can be processed

**When to use:** Sites with unreliable DOM structures, markdown-rendered content, or frequently changing layouts. Currently used for Watt's List sites.

## Playwright (Recommended Long-Term Migration)

How it works: Replace Puppeteer with Playwright for browser automation. Same scraping logic, different automation library.

**Pros:**
- Better maintained and more actively developed than Puppeteer
- Built-in auto-waiting and retry logic
- Multi-browser support (Chromium, Firefox, WebKit)
- Better handling of modern web apps (Shadow DOM, iframes)
- Superior debugging tools (trace viewer, codegen)
- `locator` API is more resilient than raw selectors

**Cons:**
- Migration effort from Puppeteer (API is similar but not identical)
- Slightly larger install size
- Still requires CSS/XPath selectors (but locators add resilience)

**When to use:** Consider migrating when Puppeteer limitations become a bottleneck, or during a major refactor. Playwright's `locator` API with auto-waiting would reduce flaky scrapes.

## Direct API Calls

How it works: Skip browser automation entirely. Fetch job data directly from the site's REST/GraphQL API endpoints.

**Pros:**
- Fastest approach -- no browser overhead
- Most reliable -- structured API responses don't change layout
- Lowest resource usage (no headless browser)
- Can paginate and filter server-side

**Cons:**
- Most sites don't expose public job APIs
- APIs may require authentication or API keys
- Undocumented APIs can change without notice
- May violate terms of service

**When to use:** When a site has a known, stable API (e.g., Ashby, Greenhouse, Lever all have public job board APIs). Worth investigating for high-value sites before writing CSS selectors.

## Summary

| Approach | Speed | Cost | Resilience | Maintenance |
|---|---|---|---|---|
| CSS Selectors | Fast | Free | Low | High |
| XPath | Fast | Free | Low | High |
| AI Extraction | Moderate | ~$0.01-0.03/page | High | Low |
| Playwright | Fast | Free | Medium | Medium |
| Direct API | Fastest | Free | Highest | Low |

**Recommended strategy:** Use CSS selectors as the default. Enable AI extraction for sites with unstable DOM. Investigate direct API calls for sites powered by known ATS platforms. Consider migrating from Puppeteer to Playwright when feasible.

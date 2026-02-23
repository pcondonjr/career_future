/**
 * enrich-with-apollo.js
 *
 * Takes your Apify export (CSV or JSON) and enriches each company with
 * employee count data from Apollo.io (free tier)
 *
 * Usage:
 *   1. Sign up at app.apollo.io (free)
 *   2. Get API key from developer.apollo.io/keys/
 *   3. Add APOLLO_API_KEY to your .env
 *   4. Export Apify results as CSV and save to this folder
 *   5. node enrich-with-apollo.js [input-file] [output-file]
 *
 * Accepts both .csv and .json input files
 *
 * Defaults:
 *   input:  ./apify-results.csv
 *   output: ./enriched-companies.csv
 */

import dotenv from 'dotenv';
dotenv.config();

import fs from 'fs';
import csvParser from 'csv-parser';

const APOLLO_API_KEY = process.env.APOLLO_API_KEY;
const INPUT_FILE = process.argv[2] || './apify-results.csv';
const OUTPUT_FILE = process.argv[3] || './enriched-companies.csv';

const MIN_EMPLOYEES = 200;
const MAX_EMPLOYEES = 5000;

if (!APOLLO_API_KEY) {
    console.error('❌ Missing APOLLO_API_KEY in .env');
    console.error('   Get your key from: developer.apollo.io/keys/');
    process.exit(1);
}

/**
 * Read input file - supports both CSV and JSON
 */
async function readInput(filePath) {
    const ext = filePath.toLowerCase().split('.').pop();

    if (ext === 'json') {
        const raw = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(raw);
    }

    // CSV parsing
    return new Promise((resolve, reject) => {
        const rows = [];
        fs.createReadStream(filePath)
            .pipe(csvParser())
            .on('data', (row) => {
                // Normalize common Apify CSV column names
                rows.push({
                    name: row.title || row.name || row.company_name || row.Name || row.Title || '',
                    website: row.website || row.url || row.Website || row.URL || '',
                    address: row.address || row.Address || row.location || '',
                    phone: row.phone || row.Phone || row.telephone || '',
                    placeId: row.placeId || row.place_id || row.PlaceId || '',
                });
            })
            .on('end', () => resolve(rows))
            .on('error', reject);
    });
}

/**
 * Look up a company on Apollo by domain
 */
async function enrichCompany(company) {
    const domain = company.website
        ? company.website.replace(/https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '')
        : null;

    if (domain) {
        try {
            const res = await fetch('https://api.apollo.io/api/v1/organizations/enrich', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Cache-Control': 'no-cache',
                    'x-api-key': APOLLO_API_KEY,
                },
                body: JSON.stringify({ domain: domain }),
            });

            if (res.ok) {
                const data = await res.json();
                if (data.organization) {
                    return {
                        employeeCount: data.organization.estimated_num_employees || null,
                        industry: data.organization.industry || null,
                        revenue: data.organization.annual_revenue_printed || null,
                        linkedinUrl: data.organization.linkedin_url || null,
                        founded: data.organization.founded_year || null,
                        description: data.organization.short_description || null,
                    };
                }
            }
        } catch (err) {
            console.error(`   Apollo API error for ${domain}: ${err.message}`);
        }
    }

    // Fallback: search by company name
    try {
        const res = await fetch('https://api.apollo.io/api/v1/organizations/search', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache',
                'x-api-key': APOLLO_API_KEY,
            },
            body: JSON.stringify({
                q_organization_name: company.name,
                organization_locations: ['South Carolina'],
                page: 1,
                per_page: 1,
            }),
        });

        if (res.ok) {
            const data = await res.json();
            if (data.organizations && data.organizations.length > 0) {
                const org = data.organizations[0];
                return {
                    employeeCount: org.estimated_num_employees || null,
                    industry: org.industry || null,
                    revenue: org.annual_revenue_printed || null,
                    linkedinUrl: org.linkedin_url || null,
                    founded: org.founded_year || null,
                    description: org.short_description || null,
                };
            }
        }
    } catch (err) {
        console.error(`   Apollo search error for ${company.name}: ${err.message}`);
    }

    return null;
}

/**
 * Escape a value for CSV
 */
function csvEscape(val) {
    if (val === null || val === undefined) return '';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
}

async function main() {
    console.log(`\n📂 Reading: ${INPUT_FILE}`);

    if (!fs.existsSync(INPUT_FILE)) {
        console.error(`❌ File not found: ${INPUT_FILE}`);
        process.exit(1);
    }

    const companies = await readInput(INPUT_FILE);
    console.log(`   Found ${companies.length} companies to enrich\n`);

    const results = [];
    let enriched = 0;
    let filtered = 0;
    let noData = 0;

    for (let i = 0; i < companies.length; i++) {
        const company = companies[i];
        const name = company.name || company.title || 'Unknown';

        process.stdout.write(`[${i + 1}/${companies.length}] ${name}... `);

        // Rate limit: ~4 req/sec to be safe
        await new Promise(r => setTimeout(r, 300));

        const apollo = await enrichCompany(company);

        if (apollo && apollo.employeeCount) {
            if (apollo.employeeCount >= MIN_EMPLOYEES && apollo.employeeCount <= MAX_EMPLOYEES) {
                results.push({
                    name: name,
                    website: company.website || '',
                    address: company.address || '',
                    phone: company.phone || '',
                    placeId: company.placeId || '',
                    employeeCount: apollo.employeeCount,
                    industry: apollo.industry || '',
                    revenue: apollo.revenue || '',
                    linkedinUrl: apollo.linkedinUrl || '',
                    founded: apollo.founded || '',
                    description: apollo.description || '',
                });
                enriched++;
                console.log(`✅ ${apollo.employeeCount} employees`);
            } else {
                filtered++;
                console.log(`⏭️  ${apollo.employeeCount} employees (outside 200-5000)`);
            }
        } else {
            noData++;
            console.log(`❓ No employee data found`);
            results.push({
                name: name,
                website: company.website || '',
                address: company.address || '',
                phone: company.phone || '',
                placeId: company.placeId || '',
                employeeCount: 'UNKNOWN',
                industry: apollo?.industry || '',
                revenue: apollo?.revenue || '',
                linkedinUrl: apollo?.linkedinUrl || '',
                founded: apollo?.founded || '',
                description: apollo?.description || '',
            });
        }
    }

    // Write CSV
    const headers = [
        'name', 'website', 'address', 'phone', 'placeId',
        'employeeCount', 'industry', 'revenue', 'linkedinUrl',
        'founded', 'description'
    ];

    const csvLines = [headers.join(',')];
    for (const row of results) {
        csvLines.push(headers.map(h => csvEscape(row[h])).join(','));
    }

    fs.writeFileSync(OUTPUT_FILE, csvLines.join('\n'), 'utf-8');

    console.log(`\n${'='.repeat(50)}`);
    console.log(`📊 Enrichment Results:`);
    console.log(`   ✅ In range (200-5000):  ${enriched}`);
    console.log(`   ⏭️  Filtered out:         ${filtered}`);
    console.log(`   ❓ No employee data:      ${noData}`);
    console.log(`   📄 Output: ${OUTPUT_FILE}`);
    console.log(`${'='.repeat(50)}\n`);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});

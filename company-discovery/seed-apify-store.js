/**
 * seed-apify-store.js
 *
 * Pre-seeds the Apify Key Value Store "scraped-companies-master-list"
 * with companies from your companies-weekly.csv so the Google Maps
 * actor skips them (deduplication) and backfills Place IDs on future runs.
 *
 * Usage:
 *   1. npm install apify-client csv-parser
 *   2. Set APIFY_API_TOKEN in your .env or environment
 *   3. node seed-apify-store.js [path-to-csv]
 *
 * Default CSV path: ./companies-weekly.csv
 */

import dotenv from 'dotenv';
dotenv.config();
import { ApifyClient } from 'apify-client';
import fs from 'fs';
import csvParser from 'csv-parser';

// --- Configuration ---
const APIFY_TOKEN = process.env.APIFY_API_TOKEN || process.env.APIFY_TOKEN;
const STORE_NAME = 'scraped-companies-master-list';
const CSV_PATH = process.argv[2] || './companies-weekly.csv';

if (!APIFY_TOKEN) {
    console.error('❌ Missing APIFY_API_TOKEN in .env or environment');
    console.error('   Get your token from: https://console.apify.com/account#/integrations');
    process.exit(1);
}

const client = new ApifyClient({ token: APIFY_TOKEN });

/**
 * Normalize a company name into a consistent store key
 * e.g. "Prisma Health" -> "name_prisma_health"
 */
function nameToKey(name) {
    return 'name_' + name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/(^_|_$)/g, '');
}

/**
 * Read companies from CSV, skipping comment lines
 */
async function readCSV(csvPath) {
    const companies = [];

    return new Promise((resolve, reject) => {
        fs.createReadStream(csvPath)
            .pipe(csvParser())
            .on('data', (row) => {
                const name = (row.company_name || '').trim();
                // Skip comment lines and empty rows
                if (!name || name.startsWith('#')) return;

                companies.push({
                    name: name,
                    careers_url: (row.careers_url || '').trim(),
                    enabled: (row.enabled || '').trim().toLowerCase() === 'true',
                    notes: (row.notes || '').trim(),
                });
            })
            .on('end', () => resolve(companies))
            .on('error', reject);
    });
}

async function main() {
    console.log(`\n📂 Reading companies from: ${CSV_PATH}`);

    if (!fs.existsSync(CSV_PATH)) {
        console.error(`❌ File not found: ${CSV_PATH}`);
        process.exit(1);
    }

    const companies = await readCSV(CSV_PATH);
    console.log(`   Found ${companies.length} companies (excluding comments)\n`);

    // Open (or create) the Key Value Store
    console.log(`🔗 Connecting to Apify store: "${STORE_NAME}"...`);
    const store = await client.keyValueStores().getOrCreate(STORE_NAME);
    const storeClient = client.keyValueStore(store.id);

    let seeded = 0;
    let skipped = 0;
    let errors = 0;

    for (const company of companies) {
        const key = nameToKey(company.name);

        try {
            // Check if this company already exists in the store
            const existing = await storeClient.getRecord(key);

            if (existing) {
                skipped++;
                continue;
            }

            // Seed the record (no placeId yet — actor will backfill)
            const record = {
                name: company.name,
                placeId: null,
                careersUrl: company.careers_url,
                dateSeeded: new Date().toISOString(),
                source: 'companies-weekly-csv',
                enabled: company.enabled,
                notes: company.notes,
            };

            await storeClient.setRecord({
                key: key,
                value: record,
                contentType: 'application/json',
            });

            seeded++;
            console.log(`   ✅ ${company.name} → ${key}`);
        } catch (err) {
            errors++;
            console.error(`   ❌ ${company.name}: ${err.message}`);
        }
    }

    console.log(`\n${'='.repeat(50)}`);
    console.log(`📊 Results:`);
    console.log(`   ✅ Seeded:  ${seeded}`);
    console.log(`   ⏭️  Skipped: ${skipped} (already in store)`);
    console.log(`   ❌ Errors:  ${errors}`);
    console.log(`   📦 Store:   ${STORE_NAME}`);
    console.log(`${'='.repeat(50)}\n`);

    // Optional: list what's in the store now
    if (process.argv.includes('--list')) {
        console.log('📋 Current store contents:');
        const keys = await storeClient.listKeys();
        for (const item of keys.items) {
            const record = await storeClient.getRecord(item.key);
            const val = record.value;
            const pid = val.placeId ? `✅ ${val.placeId}` : '⏳ pending';
            console.log(`   ${item.key} → ${val.name} [PlaceID: ${pid}]`);
        }
        console.log(`\n   Total keys: ${keys.items.length}`);
    }
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});

/**
 * migrate-existing-stores.js
 *
 * Migrates companies from unnamed Apify KV stores into the named
 * "scraped-companies-master-list" store for deduplication.
 *
 * Two modes:
 *   1. Auto mode (default): Reads the _run_log from the master store
 *      to find all stores that need migrating
 *   2. Manual mode: Pass store IDs as arguments
 *
 * Usage:
 *   node migrate-existing-stores.js                     # auto from run log
 *   node migrate-existing-stores.js ID1 ID2 ID3         # manual store IDs
 *   node migrate-existing-stores.js --list               # show run log only
 */

import dotenv from 'dotenv';
dotenv.config();

import { ApifyClient } from 'apify-client';
import fs from 'fs';

const APIFY_TOKEN = process.env.APIFY_API_TOKEN || process.env.APIFY_TOKEN;
const STORE_NAME = 'scraped-companies-master-list';
const LOG_FILE = './migration-log.txt';

if (!APIFY_TOKEN) {
    console.error('❌ Missing APIFY_API_TOKEN in .env');
    process.exit(1);
}

const client = new ApifyClient({ token: APIFY_TOKEN });

function nameToKey(name) {
    return 'name_' + name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/(^_|_$)/g, '');
}

function logToFile(message) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${message}\n`;
    fs.appendFileSync(LOG_FILE, line);
    console.log(message);
}

async function getStoreIds() {
    const args = process.argv.slice(2).filter(a => !a.startsWith('--'));

    // Manual mode: store IDs passed as arguments
    if (args.length > 0) {
        console.log(`📋 Manual mode: ${args.length} store IDs provided\n`);
        return args;
    }

    // Auto mode: read _run_log from master store
    console.log(`🔍 Auto mode: checking _run_log in "${STORE_NAME}"...\n`);

    try {
        const masterStore = await client.keyValueStores().getOrCreate(STORE_NAME);
        const masterClient = client.keyValueStore(masterStore.id);
        const logRecord = await masterClient.getRecord('_run_log');

        if (!logRecord || !logRecord.value || logRecord.value.length === 0) {
            console.log('   No run log found. Use manual mode:');
            console.log('   node migrate-existing-stores.js STORE_ID_1 STORE_ID_2\n');

            // Also list all KV stores to help identify which ones to migrate
            console.log('📦 All Key-Value stores in your account:');
            const stores = await client.keyValueStores().list();
            for (const s of stores.items) {
                const name = s.name || '(unnamed)';
                console.log(`   ${s.id} | ${name} | ${s.createdAt}`);
            }
            process.exit(0);
        }

        const runLog = logRecord.value;
        console.log(`📋 Found ${runLog.length} runs in log:\n`);
        for (const entry of runLog) {
            console.log(`   ${entry.timestamp} | ${entry.storeId} | ${entry.search}`);
        }
        console.log('');

        // Check which ones have already been migrated
        const migratedRecord = await masterClient.getRecord('_migrated_stores');
        const alreadyMigrated = migratedRecord?.value || [];

        const newStores = runLog
            .map(r => r.storeId)
            .filter(id => id !== 'unknown' && !alreadyMigrated.includes(id));

        if (newStores.length === 0) {
            console.log('✅ All stores already migrated. Nothing to do.\n');
            process.exit(0);
        }

        console.log(`🆕 ${newStores.length} new stores to migrate\n`);
        return newStores;

    } catch (err) {
        console.error(`❌ Could not read run log: ${err.message}`);
        console.log('\nFalling back: listing all KV stores...\n');

        const stores = await client.keyValueStores().list();
        for (const s of stores.items) {
            const name = s.name || '(unnamed)';
            console.log(`   ${s.id} | ${name} | ${s.createdAt}`);
        }
        console.log('\nPass store IDs manually:');
        console.log('   node migrate-existing-stores.js STORE_ID_1 STORE_ID_2\n');
        process.exit(1);
    }
}

async function main() {
    // --list mode: just show the run log
    if (process.argv.includes('--list')) {
        const masterStore = await client.keyValueStores().getOrCreate(STORE_NAME);
        const masterClient = client.keyValueStore(masterStore.id);

        const logRecord = await masterClient.getRecord('_run_log');
        const runLog = logRecord?.value || [];

        const migratedRecord = await masterClient.getRecord('_migrated_stores');
        const migrated = migratedRecord?.value || [];

        console.log(`\n📋 Run Log (${runLog.length} entries):\n`);
        for (const entry of runLog) {
            const status = migrated.includes(entry.storeId) ? '✅ migrated' : '🆕 pending';
            console.log(`   ${entry.timestamp} | ${entry.storeId} | ${status}`);
        }

        console.log(`\n📦 All Key-Value stores:\n`);
        const stores = await client.keyValueStores().list();
        for (const s of stores.items) {
            const name = s.name || '(unnamed)';
            console.log(`   ${s.id} | ${name} | ${s.createdAt}`);
        }
        console.log('');
        process.exit(0);
    }

    const storeIds = await getStoreIds();

    logToFile(`=== Migration started ===`);
    logToFile(`Stores to migrate: ${storeIds.join(', ')}`);

    // Open destination store
    const destStore = await client.keyValueStores().getOrCreate(STORE_NAME);
    const destClient = client.keyValueStore(destStore.id);

    let totalMigrated = 0;
    let totalSkipped = 0;
    let totalErrors = 0;

    for (const storeId of storeIds) {
        logToFile(`\n📦 Reading from store: ${storeId}`);
        const sourceClient = client.keyValueStore(storeId);

        try {
            const keys = await sourceClient.listKeys();
            logToFile(`   Found ${keys.items.length} records`);

            for (const item of keys.items) {
                try {
                    const record = await sourceClient.getRecord(item.key);
                    if (!record || !record.value) continue;

                    const val = record.value;
                    const companyName = val.name || val.title || '';
                    const placeId = val.placeId || item.key;

                    if (!companyName && !placeId) continue;

                    let alreadyExists = false;

                    if (placeId) {
                        const existing = await destClient.getRecord(placeId);
                        if (existing) alreadyExists = true;
                    }

                    if (companyName) {
                        const nKey = nameToKey(companyName);
                        const existingByName = await destClient.getRecord(nKey);
                        if (existingByName) alreadyExists = true;
                    }

                    if (alreadyExists) {
                        totalSkipped++;
                        continue;
                    }

                    const newRecord = {
                        name: companyName,
                        placeId: placeId || null,
                        dateScraped: val.dateScraped || val.dateSeeded || new Date().toISOString(),
                        source: `migrated-from-${storeId}`,
                    };

                    if (placeId && !placeId.startsWith('name_')) {
                        await destClient.setRecord({
                            key: placeId,
                            value: newRecord,
                            contentType: 'application/json',
                        });
                    }

                    if (companyName) {
                        const nKey = nameToKey(companyName);
                        await destClient.setRecord({
                            key: nKey,
                            value: newRecord,
                            contentType: 'application/json',
                        });
                    }

                    totalMigrated++;
                    logToFile(`   ✅ ${companyName || placeId}`);

                } catch (err) {
                    totalErrors++;
                    logToFile(`   ❌ Key "${item.key}": ${err.message}`);
                }
            }

            // Mark this store as migrated
            const migratedRecord = await destClient.getRecord('_migrated_stores');
            const migrated = migratedRecord?.value || [];
            if (!migrated.includes(storeId)) {
                migrated.push(storeId);
                await destClient.setRecord({
                    key: '_migrated_stores',
                    value: migrated,
                    contentType: 'application/json',
                });
            }

        } catch (err) {
            logToFile(`   ❌ Could not read store ${storeId}: ${err.message}`);
        }
    }

    logToFile(`\n${'='.repeat(50)}`);
    logToFile(`📊 Migration Results:`);
    logToFile(`   ✅ Migrated: ${totalMigrated}`);
    logToFile(`   ⏭️  Skipped:  ${totalSkipped} (already in destination)`);
    logToFile(`   ❌ Errors:   ${totalErrors}`);
    logToFile(`   📄 Log file: ${LOG_FILE}`);
    logToFile(`${'='.repeat(50)}\n`);

    const finalKeys = await destClient.listKeys();
    logToFile(`📋 Total records in ${STORE_NAME}: ${finalKeys.items.length}\n`);
}

main().catch(err => {
    logToFile(`Fatal error: ${err.message}`);
    process.exit(1);
});

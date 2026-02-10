#!/usr/bin/env node
/**
 * License Key Generator for Career Future
 *
 * Usage:
 *   node scripts/generate-license.js --email user@example.com [--type pro] [--expires 2027-01-01]
 *
 * First run generates an RSA key pair in scripts/keys/.
 * The public key must be copied into src/main/license.js for verification.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const KEYS_DIR = path.join(__dirname, 'keys');
const PRIVATE_KEY_PATH = path.join(KEYS_DIR, 'license-private.pem');
const PUBLIC_KEY_PATH = path.join(KEYS_DIR, 'license-public.pem');

function ensureKeyPair() {
  if (!fs.existsSync(KEYS_DIR)) {
    fs.mkdirSync(KEYS_DIR, { recursive: true });
  }

  if (fs.existsSync(PRIVATE_KEY_PATH) && fs.existsSync(PUBLIC_KEY_PATH)) {
    return {
      privateKey: fs.readFileSync(PRIVATE_KEY_PATH, 'utf-8'),
      publicKey: fs.readFileSync(PUBLIC_KEY_PATH, 'utf-8')
    };
  }

  console.log('Generating new RSA key pair...');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  });

  fs.writeFileSync(PRIVATE_KEY_PATH, privateKey);
  fs.writeFileSync(PUBLIC_KEY_PATH, publicKey);

  console.log(`Keys saved to ${KEYS_DIR}/`);
  console.log('IMPORTANT: Copy the public key into src/main/license.js');
  console.log(`Public key path: ${PUBLIC_KEY_PATH}\n`);

  return { privateKey, publicKey };
}

function toBase64Url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateLicense(email, type, expiresAt, privateKey) {
  const payload = {
    email,
    type: type || 'pro',
    issuedAt: new Date().toISOString()
  };

  if (expiresAt) {
    payload.expiresAt = new Date(expiresAt).toISOString();
  }

  const payloadStr = JSON.stringify(payload);
  const payloadB64 = toBase64Url(Buffer.from(payloadStr));

  const signature = crypto.sign('sha256', Buffer.from(payloadB64), privateKey);
  const signatureB64 = toBase64Url(signature);

  return `${payloadB64}.${signatureB64}`;
}

// --- CLI ---

function parseArgs(args) {
  const parsed = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--email' && args[i + 1]) {
      parsed.email = args[++i];
    } else if (args[i] === '--type' && args[i + 1]) {
      parsed.type = args[++i];
    } else if (args[i] === '--expires' && args[i + 1]) {
      parsed.expires = args[++i];
    } else if (args[i] === '--help' || args[i] === '-h') {
      parsed.help = true;
    }
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));

if (args.help || !args.email) {
  console.log(`
Career Future License Generator

Usage:
  node scripts/generate-license.js --email <email> [--type pro] [--expires YYYY-MM-DD]

Options:
  --email     Required. Licensee email address
  --type      License type (default: "pro")
  --expires   Expiration date (optional, no expiry if omitted)
  --help      Show this help message

Examples:
  node scripts/generate-license.js --email user@example.com
  node scripts/generate-license.js --email user@example.com --type pro --expires 2027-01-01
`);
  process.exit(args.help ? 0 : 1);
}

const { privateKey, publicKey } = ensureKeyPair();
const licenseKey = generateLicense(args.email, args.type, args.expires, privateKey);

console.log('='.repeat(60));
console.log('LICENSE KEY GENERATED');
console.log('='.repeat(60));
console.log(`Email:   ${args.email}`);
console.log(`Type:    ${args.type || 'pro'}`);
console.log(`Expires: ${args.expires || 'Never'}`);
console.log('');
console.log('License Key:');
console.log(licenseKey);
console.log('');
console.log('='.repeat(60));

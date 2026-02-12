import crypto from 'crypto';

function toBase64Url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Generate an RSA-signed license key compatible with src/main/license.js.
 *
 * @param {string} email - Buyer's email address
 * @param {string} privateKeyPem - RSA private key (PEM format)
 * @param {object} [options]
 * @param {string} [options.type='pro'] - License type
 * @param {string} [options.expiresAt] - ISO date string (omit for lifetime)
 * @returns {string} License key in format: <base64url-payload>.<base64url-signature>
 */
export function generateLicenseKey(email, privateKeyPem, options = {}) {
  const payload = {
    email,
    type: options.type || 'pro',
    issuedAt: new Date().toISOString()
  };

  if (options.expiresAt) {
    payload.expiresAt = new Date(options.expiresAt).toISOString();
  }

  const payloadB64 = toBase64Url(Buffer.from(JSON.stringify(payload)));
  const signature = crypto.sign('sha256', Buffer.from(payloadB64), privateKeyPem);
  const signatureB64 = toBase64Url(signature);

  return `${payloadB64}.${signatureB64}`;
}

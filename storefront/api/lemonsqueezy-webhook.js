import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { generateLicenseKey } from './generate-key.js';

/**
 * Lemon Squeezy Webhook Handler for Vercel Serverless Functions.
 *
 * Listens for order_created events, generates an RSA-signed license key,
 * and emails it to the buyer.
 *
 * Required env vars:
 *   LEMONSQUEEZY_WEBHOOK_SECRET - Webhook signing secret from LS dashboard
 *   LICENSE_PRIVATE_KEY          - RSA private key PEM (paste full key, newlines as \n)
 *   SMTP_HOST                    - e.g. smtp.gmail.com
 *   SMTP_USER                    - e.g. you@gmail.com
 *   SMTP_PASS                    - App password
 */

export const config = {
  api: { bodyParser: false }
};

async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

function verifySignature(rawBody, signatureHeader, secret) {
  const hmac = crypto.createHmac('sha256', secret);
  const digest = hmac.update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signatureHeader));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 1. Verify HMAC signature
  const rawBody = await getRawBody(req);
  const sig = req.headers['x-signature'];

  if (!sig || !verifySignature(rawBody, sig, process.env.LEMONSQUEEZY_WEBHOOK_SECRET)) {
    console.error('Webhook signature verification failed');
    return res.status(400).json({ error: 'Invalid signature' });
  }

  const event = JSON.parse(rawBody.toString('utf-8'));

  // 2. Only handle successful orders
  if (event.meta?.event_name !== 'order_created') {
    return res.status(200).json({ received: true });
  }

  const email = event.data?.attributes?.user_email;

  if (!email) {
    console.error('No customer email in order:', event.data?.id);
    return res.status(400).json({ error: 'No customer email' });
  }

  // 3. Generate license key
  const privateKey = process.env.LICENSE_PRIVATE_KEY.replace(/\\n/g, '\n');
  const licenseKey = generateLicenseKey(email, privateKey);

  // 4. Email the key
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });

    await transporter.sendMail({
      from: `"Career Future" <${process.env.SMTP_USER}>`,
      to: email,
      subject: 'Your Career Future License Key',
      html: `
        <h2>Thank you for your purchase!</h2>
        <p>Here is your Career Future license key:</p>
        <pre style="background:#f4f4f4;padding:16px;border-radius:8px;font-size:14px;word-break:break-all;">${licenseKey}</pre>
        <h3>How to activate:</h3>
        <ol>
          <li>Open Career Future</li>
          <li>Go to Settings → License</li>
          <li>Paste the key above and click Activate</li>
        </ol>
        <p>If you have any issues, reply to this email.</p>
      `
    });

    console.log(`License key sent to ${email} (order: ${event.data?.id})`);
  } catch (err) {
    console.error('Failed to send license email:', err.message);
    return res.status(200).json({ received: true, emailError: err.message });
  }

  return res.status(200).json({ received: true });
}

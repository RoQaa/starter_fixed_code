const crypto = require('crypto');
const express = require('express');
const config = require('./config');
const { handleIncomingMessage } = require('./handler');
const { FileClaimStore } = require('./dedupe');

const store = new FileClaimStore(config.dedupeDir);
const app = express();

// Keep the exact raw bytes: the signature is computed over them, not over
// re-serialized JSON.
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));

function safeEqual(a, b) {
  const ab = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function hasValidSignature(req) {
  const header = req.get('X-Hub-Signature-256') || '';
  if (!header.startsWith('sha256=') || !req.rawBody) return false;
  // Key = the app secret as a plain UTF-8 string. Do NOT hex-decode it.
  const expected = 'sha256=' + crypto
    .createHmac('sha256', Buffer.from(config.metaAppSecret, 'utf8'))
    .update(req.rawBody)
    .digest('hex');
  return safeEqual(header.toLowerCase(), expected);
}

// Meta webhook verification: must echo hub.challenge back.
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' &&
      typeof req.query['hub.verify_token'] === 'string' &&
      safeEqual(req.query['hub.verify_token'], config.metaVerifyToken) &&
      typeof req.query['hub.challenge'] === 'string') {
    return res.status(200).type('text/plain').send(req.query['hub.challenge']);
  }
  return res.sendStatus(403);
});

// Incoming WhatsApp messages
app.post('/webhook', (req, res) => {
  if (!hasValidSignature(req)) {
    console.warn('Rejected webhook POST with missing/invalid X-Hub-Signature-256');
    return res.sendStatus(403);
  }

  const body = req.body || {};
  if (body.object !== 'whatsapp_business_account') return res.sendStatus(200);

  // Meta may batch several entries / changes / messages in one delivery.
  const work = [];
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== 'messages') continue;
      const value = change.value || {};
      for (const message of value.messages || []) {
        if (!message?.id || !message?.from) continue;
        const contact = (value.contacts || []).find((c) => c.wa_id === message.from) || value.contacts?.[0];
        work.push({ message, contact, phoneNumberId: value.metadata?.phone_number_id });
      }
    }
  }

  // Claim each id atomically BEFORE acknowledging or sending anything.
  const claimed = [];
  try {
    for (const item of work) {
      if (store.claim(item.message.id)) claimed.push(item);
      else console.log(`[${item.message.id}] duplicate delivery, skipped`);
    }
  } catch (err) {
    // Storage failure: let Meta retry. Ids already claimed here will be skipped
    // as duplicates on the retry, the rest will be picked up then.
    console.error(`Claim store failure: ${err.message}`);
    claimed.forEach((item) => runInBackground(item));
    return res.sendStatus(500);
  }

  // Ack immediately so Meta doesn't time out (e.g. while Resend is slow) and retry.
  res.sendStatus(200);
  claimed.forEach((item) => runInBackground(item));
});

function runInBackground(item) {
  handleIncomingMessage({ ...item, store }).catch((err) =>
    console.error(`[${item.message.id}] unexpected error: ${err.message}`));
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(config.port, () => console.log(`Listening on ${config.port}`));

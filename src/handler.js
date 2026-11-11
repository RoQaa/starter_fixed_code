const { Resend } = require('resend');
const config = require('./config');
const { sendWhatsAppText } = require('./whatsapp');

const resend = new Resend(config.resendApiKey);

// Every label after the @ must be non-empty, and the TLD must be letters, so a
// sentence-ending period ("... fatima@example.com.") is not captured.
const EMAIL_REGEX = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Per-sender email cap (in memory; resets on restart — see README).
const sentLog = new Map(); // wa_id -> [timestamps]
function overRateLimit(sender) {
  const hourAgo = Date.now() - 60 * 60 * 1000;
  const recent = (sentLog.get(sender) || []).filter((t) => t > hourAgo);
  sentLog.set(sender, recent);
  return recent.length >= config.maxEmailsPerSenderPerHour;
}
function recordSend(sender) {
  sentLog.get(sender).push(Date.now());
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Classifies a Resend error:
 *  - 'transient': worth retrying (rate limit, 5xx, network, concurrent idempotent request)
 *  - 'address':   the recipient address was rejected — the client should check it
 *  - 'permanent': our side is wrong (bad key, unverified/testing sender, quota) — retrying won't help
 *
 * Note: Resend also uses `validation_error` with HTTP 403 for "you can only send
 * testing emails to your own address" / unverified domain. That is a sender
 * problem, not a bad client address, so 403 is never classified as 'address'.
 */
function classifyResendError(error) {
  const name = error?.name;
  const status = Number(error?.statusCode) || undefined;
  if (/quota/i.test(name || '') || /quota/i.test(error?.message || '')) return 'permanent';
  if (status === 429 || (status && status >= 500)) return 'transient';
  if (['rate_limit_exceeded', 'application_error', 'internal_server_error',
    'concurrent_idempotent_requests'].includes(name)) return 'transient';
  if (['validation_error', 'invalid_parameter'].includes(name) && status !== 403) return 'address';
  return 'permanent';
}

/** Sends with retries on transient errors. Safe because the idempotencyKey is
 *  identical on every attempt, so Resend never delivers the email twice. */
async function sendEmailWithRetry(payload, idempotencyKey, messageId) {
  let last;
  for (let attempt = 1; attempt <= config.resendMaxAttempts; attempt++) {
    let result;
    try {
      result = await resend.emails.send(payload, { idempotencyKey });
    } catch (err) {
      result = { data: null, error: { name: 'application_error', message: err.message } };
    }
    if (!result.error) return { data: result.data, attempts: attempt };

    const kind = classifyResendError(result.error);
    last = { error: result.error, kind, attempts: attempt };
    console.warn(`[${messageId}] Resend attempt ${attempt} failed (${kind}): ${result.error.name}`);
    if (kind !== 'transient' || attempt === config.resendMaxAttempts) break;
    await sleep(config.resendRetryBaseMs * 3 ** (attempt - 1)); // 500ms, 1.5s, ...
  }
  return last;
}

/**
 * Processes one inbound WhatsApp message. The caller MUST have already won
 * store.claim(message.id) — the claim happens before any side effect, so
 * retries and duplicate deliveries from Meta never send a second email/reply.
 */
async function handleIncomingMessage({ message, contact, phoneNumberId, store }) {
  const reply = (body) => sendWhatsAppText(message.from, body, phoneNumberId);

  try {
    const text = message.text?.body || '';
    const name = contact?.profile?.name || 'Client';
    const email = (text.match(EMAIL_REGEX) || [])[0];

    if (!email) {
      await reply('Please send your email address so we can confirm your request.');
      store.mark(message.id, 'asked_for_email');
      return;
    }

    if (overRateLimit(message.from)) {
      store.mark(message.id, 'rate_limited');
      console.warn(`[${message.id}] sender over email rate limit, no email sent`);
      await reply('We have already received your recent requests. Our team will contact you soon.');
      return;
    }

    const { data, error, kind, attempts } = await sendEmailWithRetry(
      {
        from: config.resendFrom,
        to: email,
        subject: 'We received your request',
        html: `<p>Dear ${escapeHtml(name)},</p><p>We received your message: "${escapeHtml(text)}". Our team will contact you within one working day.</p>`,
        text: `Dear ${name},\n\nWe received your message: "${text}". Our team will contact you within one working day.`,
      },
      // Same key on every attempt: Resend drops repeats within 24h.
      `whatsapp-msg/${message.id}`,
      message.id,
    );

    if (error) {
      store.mark(message.id, `email_failed_${kind}`, `${error.name} after ${attempts} attempt(s)`);
      console.error(`[${message.id}] email not sent (${kind}) after ${attempts} attempt(s): ${error.name}: ${error.message}`);
      await reply(kind === 'address'
        ? `We received your request, but we could not send a confirmation email to ${email}. Please check the address and send it again.`
        : 'We received your request, but we could not send the confirmation email right now. Our team will contact you within one working day.');
      return;
    }

    recordSend(message.from);
    store.mark(message.id, 'email_sent', data?.id);
    await reply('Thank you. A confirmation email has been sent.');
    store.mark(message.id, 'done', data?.id);
  } catch (err) {
    // Claim is intentionally NOT released: at-most-once. Failed ones are visible
    // in the store for manual follow-up.
    store.mark(message.id, 'error', err.message);
    console.error(`[${message.id}] processing failed: ${err.message}`);
  }
}

module.exports = { handleIncomingMessage, classifyResendError, EMAIL_REGEX, escapeHtml };

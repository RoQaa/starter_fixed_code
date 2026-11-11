const fs = require('fs');
const path = require('path');

// Minimal .env loader (no dependency). Values already present in the real
// environment (e.g. set in the Render dashboard) always win over the file.
// ENV_FILE lets tests point at a specific env file.
function loadDotEnv(file = process.env.ENV_FILE || path.join(__dirname, '..', '.env')) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return; // no .env file (normal on Render)
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

// Every value is trimmed: a CRLF .env file or a value pasted into a dashboard
// with a trailing newline/space must not silently break HMAC or auth headers.
function env(name, fallback) {
  const v = process.env[name];
  if (v === undefined) return fallback;
  const trimmed = v.trim();
  process.env[name] = trimmed; // so libraries that read process.env (Resend) also get the clean value
  return trimmed === '' ? fallback : trimmed;
}

loadDotEnv();

const config = {
  port: Number(env('PORT', '3000')),
  metaVerifyToken: env('META_VERIFY_TOKEN'),
  // Used as a plain UTF-8 string for the HMAC key. It LOOKS like hex but must
  // NOT be hex-decoded — Meta signs with the literal secret string.
  metaAppSecret: env('META_APP_SECRET'),
  metaAccessToken: env('META_ACCESS_TOKEN'),
  whatsappPhoneNumberId: env('WHATSAPP_PHONE_NUMBER_ID'),
  graphApiBase: env('GRAPH_API_BASE', 'https://graph.facebook.com'),
  graphApiVersion: env('GRAPH_API_VERSION', 'v21.0'),
  resendApiKey: env('RESEND_API_KEY'),
  // Optional so the original 5-variable .env still boots. The fallback only
  // delivers to the Resend account owner — set a verified-domain sender in production.
  resendFrom: env('RESEND_FROM', 'Top Delmon <onboarding@resend.dev>'),
  resendMaxAttempts: Number(env('RESEND_MAX_ATTEMPTS', '3')),
  resendRetryBaseMs: Number(env('RESEND_RETRY_BASE_MS', '500')),
  resendBaseUrl: env('RESEND_BASE_URL'), // read by the Resend SDK itself; only set for tests
  dedupeDir: env('DEDUPE_DIR', path.join(__dirname, '..', 'data', 'processed')),
  maxEmailsPerSenderPerHour: Number(env('MAX_EMAILS_PER_SENDER_PER_HOUR', '3')),
};

const REQUIRED = {
  META_VERIFY_TOKEN: config.metaVerifyToken,
  META_APP_SECRET: config.metaAppSecret,
  META_ACCESS_TOKEN: config.metaAccessToken,
  WHATSAPP_PHONE_NUMBER_ID: config.whatsappPhoneNumberId,
  RESEND_API_KEY: config.resendApiKey,
};
const missing = Object.entries(REQUIRED).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}
if (/@resend\.dev>?$/i.test(config.resendFrom)) {
  console.warn(`WARNING: RESEND_FROM is ${process.env.RESEND_FROM ? '' : 'not set, using '}${config.resendFrom} — Resend only delivers resend.dev mail to your own account address. Set RESEND_FROM to a verified domain in production.`);
}

module.exports = config;

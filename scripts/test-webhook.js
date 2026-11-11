#!/usr/bin/env node
// End-to-end webhook test.
//
// Starts a local mock of the Resend API and the Meta Graph API, boots the real
// server pointed at those mocks, then checks:
//   A. samples/incoming-message.json signed with META_APP_SECRET, sent twice -> exactly ONE email
//   B. bad / hex-decoded-key / missing signature                            -> 403
//   C. restart on the same dedupe dir and re-send                           -> still ONE email
//   D. Resend 500 then 429 then OK  -> retried, one email, same Idempotency-Key on every attempt
//   E. Resend 5xx on every attempt  -> 3 attempts, client NOT told to check address
//   F. Resend 422 validation_error  -> 1 attempt, client told to check the address
//   G. Resend 403 validation_error (testing sender) -> 1 attempt, NOT "check address"
//   H. server started with ONLY the original 5-variable .env (no RESEND_FROM)
//      -> boots, warns, sends from onboarding@resend.dev
//
// Usage: npm test   (reads META_APP_SECRET / META_VERIFY_TOKEN from env or .env)

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'samples', 'incoming-message.json');
const ORIGINAL_VARS = ['META_VERIFY_TOKEN', 'META_APP_SECRET', 'META_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID', 'RESEND_API_KEY'];
const ALL_APP_VARS = [...ORIGINAL_VARS, 'RESEND_FROM', 'PORT', 'DEDUPE_DIR', 'ENV_FILE', 'RESEND_BASE_URL', 'GRAPH_API_BASE'];

// --- env: same rules as src/config.js (real env wins, values trimmed) --------
function parseEnvFile(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m) out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch { /* no .env */ }
  return out;
}
const fileEnv = parseEnvFile(path.join(ROOT, '.env'));
const pick = (k) => (process.env[k] ?? fileEnv[k] ?? '').trim();
const APP_SECRET = pick('META_APP_SECRET');
const VERIFY_TOKEN = pick('META_VERIFY_TOKEN');
if (!APP_SECRET) { console.error('META_APP_SECRET not set'); process.exit(1); }

// --- helpers -------------------------------------------------------------------
let failures = 0;
function check(label, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (!pred() && Date.now() < until) await sleep(25);
  return pred();
}
const tmpDirs = [];
const tmpDir = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmpDirs.push(d); return d; };

// --- mock Resend + Graph API ---------------------------------------------------
// resendPlan: queue of failure responses to return before succeeding.
const calls = { attempts: [], emails: [], whatsapp: [] };
let resendPlan = [];
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/emails') {
      const call = { headers: req.headers, body: JSON.parse(body) };
      calls.attempts.push(call);
      const fail = resendPlan.shift();
      if (fail) {
        res.statusCode = fail.statusCode;
        return res.end(JSON.stringify(fail));
      }
      calls.emails.push(call);
      return res.end(JSON.stringify({ id: `email_${calls.emails.length}` }));
    }
    if (req.method === 'POST' && /\/messages$/.test(req.url)) {
      calls.whatsapp.push({ url: req.url, body: JSON.parse(body) });
      return res.end(JSON.stringify({ messages: [{ id: `wamid.reply${calls.whatsapp.length}` }] }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
});
const err = (statusCode, name, message = name) => ({ statusCode, name, message });

// --- app process management ----------------------------------------------------
function startApp({ mockPort, dedupeDir, envFile, extraEnv = {} }) {
  const port = 40000 + Math.floor(Math.random() * 20000);
  const env = { ...process.env };
  if (envFile) for (const k of ALL_APP_VARS) delete env[k]; // only the file may supply config
  Object.assign(env, {
    PORT: String(port),
    RESEND_BASE_URL: `http://127.0.0.1:${mockPort}`,
    GRAPH_API_BASE: `http://127.0.0.1:${mockPort}`,
    DEDUPE_DIR: dedupeDir,
    RESEND_RETRY_BASE_MS: '50',
    MAX_EMAILS_PER_SENDER_PER_HOUR: '100',
    ...(envFile ? { ENV_FILE: envFile } : {}),
    ...extraEnv,
  });
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.output = '';
  const onData = (d) => { child.output += d; process.stdout.write(`    [app] ${d}`); };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.port = port;
  return child;
}
async function waitForHealth(app) {
  for (let i = 0; i < 50; i++) {
    if (app.exitCode !== null) throw new Error(`server exited with code ${app.exitCode}`);
    try { if ((await fetch(`http://127.0.0.1:${app.port}/health`)).ok) return; } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('server did not become healthy');
}
function stopApp(app) {
  if (!app || app.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => { app.once('exit', resolve); app.kill(); });
}

// --- payloads & signing --------------------------------------------------------
const sampleRaw = fs.readFileSync(SAMPLE); // exact bytes that get signed AND sent
function variant(id, text) {
  const p = JSON.parse(sampleRaw.toString('utf8'));
  p.entry[0].changes[0].value.messages[0].id = id;
  if (text) p.entry[0].changes[0].value.messages[0].text.body = text;
  return Buffer.from(JSON.stringify(p));
}
const sign = (raw, key = Buffer.from(APP_SECRET, 'utf8')) =>
  'sha256=' + crypto.createHmac('sha256', key).update(raw).digest('hex');

function post(app, raw, signature = sign(raw)) {
  const headers = { 'Content-Type': 'application/json' };
  if (signature) headers['X-Hub-Signature-256'] = signature;
  return fetch(`http://127.0.0.1:${app.port}/webhook`, { method: 'POST', headers, body: raw });
}

/** Posts one new message with a scripted Resend plan; waits for the WhatsApp reply. */
async function scenario(app, id, plan) {
  resendPlan = [...plan];
  const before = { attempts: calls.attempts.length, emails: calls.emails.length, wa: calls.whatsapp.length };
  const r = await post(app, variant(id));
  await waitFor(() => calls.whatsapp.length > before.wa);
  await sleep(300); // settle: catch any extra (wrong) attempts
  return {
    status: r.status,
    attempts: calls.attempts.slice(before.attempts),
    emails: calls.emails.length - before.emails,
    replies: calls.whatsapp.slice(before.wa).map((c) => c.body.text.body),
  };
}

// --- run -------------------------------------------------------------------------
(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const mockPort = mock.address().port;
  const dedupeDir = tmpDir('wa-dedupe-');
  let app = startApp({ mockPort, dedupeDir, extraEnv: { RESEND_FROM: 'Test Sender <test@example.com>' } });
  try {
    await waitForHealth(app);

    // GET verification
    const challenge = 'challenge-' + crypto.randomBytes(4).toString('hex');
    const v = await fetch(`http://127.0.0.1:${app.port}/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(VERIFY_TOKEN)}&hub.challenge=${challenge}`);
    check('GET verify echoes hub.challenge', v.status === 200 && (await v.text()) === challenge);

    console.log('\n-- A. signed sample sent twice');
    const r1 = await post(app, sampleRaw);
    const r2 = await post(app, sampleRaw);
    check('1st signed POST -> 200', r1.status === 200, `got ${r1.status}`);
    check('2nd signed POST (same message.id) -> 200', r2.status === 200, `got ${r2.status}`);
    await waitFor(() => calls.emails.length >= 1);
    await sleep(750);
    check('exactly one email sent', calls.emails.length === 1, `got ${calls.emails.length}`);
    check('exactly one WhatsApp reply sent', calls.whatsapp.length === 1, `got ${calls.whatsapp.length}`);
    const email = calls.emails[0];
    if (email) {
      check('email sent to address from message', JSON.stringify(email.body.to).includes('fatima@example.com'), JSON.stringify(email.body.to));
      check('Idempotency-Key header sent to Resend', !!email.headers['idempotency-key'], email.headers['idempotency-key']);
    }

    console.log('\n-- B. signature rejection');
    const bad = await post(app, sampleRaw, 'sha256=' + '0'.repeat(64));
    check('bad signature -> 403', bad.status === 403, `got ${bad.status}`);
    const hx = await post(app, sampleRaw, sign(sampleRaw, Buffer.from(APP_SECRET, 'hex')));
    check('signature made with hex-decoded secret -> 403', hx.status === 403, `got ${hx.status}`);
    const none = await post(app, sampleRaw, null);
    check('missing signature -> 403', none.status === 403, `got ${none.status}`);

    console.log('\n-- C. restart keeps the claim');
    await stopApp(app);
    app = startApp({ mockPort, dedupeDir, extraEnv: { RESEND_FROM: 'Test Sender <test@example.com>' } });
    await waitForHealth(app);
    const r3 = await post(app, sampleRaw);
    check('signed POST after restart -> 200', r3.status === 200, `got ${r3.status}`);
    await sleep(1000);
    check('still exactly one email after restart', calls.emails.length === 1, `got ${calls.emails.length}`);

    console.log('\n-- D. transient errors are retried');
    const d = await scenario(app, 'wamid.TEST_TRANSIENT', [err(500, 'internal_server_error'), err(429, 'rate_limit_exceeded')]);
    check('3 attempts (500, 429, ok)', d.attempts.length === 3, `got ${d.attempts.length}`);
    check('email delivered once', d.emails === 1, `got ${d.emails}`);
    const keys = new Set(d.attempts.map((a) => a.headers['idempotency-key']));
    check('same Idempotency-Key on every attempt', keys.size === 1 && !keys.has(undefined), [...keys].join(','));
    check('client told email was sent', /confirmation email has been sent/.test(d.replies[0] || ''), d.replies[0]);

    console.log('\n-- E. transient errors exhaust retries');
    const e = await scenario(app, 'wamid.TEST_EXHAUST', [err(500, 'internal_server_error'), err(503, 'application_error'), err(502, 'application_error')]);
    check('stops after 3 attempts', e.attempts.length === 3, `got ${e.attempts.length}`);
    check('no email delivered', e.emails === 0, `got ${e.emails}`);
    check('client NOT told to check address', !/check the address/.test(e.replies[0] || '') && !!e.replies[0], e.replies[0]);
    check('client NOT told email was sent', !/has been sent/.test(e.replies[0] || ''), e.replies[0]);

    console.log('\n-- F. 422 validation error = bad address');
    const f = await scenario(app, 'wamid.TEST_INVALID_TO', [err(422, 'validation_error', 'Invalid `to` field.')]);
    check('no retry on validation error', f.attempts.length === 1, `got ${f.attempts.length}`);
    check('client told to check the address', /check the address/.test(f.replies[0] || ''), f.replies[0]);

    console.log('\n-- G. 403 testing-sender restriction is NOT a bad address');
    const g = await scenario(app, 'wamid.TEST_TESTING_SENDER', [err(403, 'validation_error', 'You can only send testing emails to your own email address.')]);
    check('no retry on 403', g.attempts.length === 1, `got ${g.attempts.length}`);
    check('client NOT told to check address', !/check the address/.test(g.replies[0] || '') && !!g.replies[0], g.replies[0]);
    await stopApp(app);

    console.log('\n-- H. original 5-variable .env (no RESEND_FROM)');
    const envDir = tmpDir('wa-env-');
    const originalEnvFile = path.join(envDir, '.env');
    fs.writeFileSync(originalEnvFile, ORIGINAL_VARS.map((k) => `${k}=${pick(k)}`).join('\n') + '\n');
    app = startApp({ mockPort, dedupeDir: tmpDir('wa-dedupe-'), envFile: originalEnvFile });
    try {
      await waitForHealth(app);
      check('server boots with original .env', true);
    } catch (e2) {
      check('server boots with original .env', false, e2.message);
    }
    check('warns about resend.dev fallback', /WARNING: RESEND_FROM is not set/.test(app.output));
    const h = await scenario(app, 'wamid.TEST_ORIGINAL_ENV', []);
    const last = calls.emails[calls.emails.length - 1];
    check('email sent from onboarding@resend.dev', h.emails === 1 && /onboarding@resend\.dev/.test(last?.body.from), last?.body.from);
  } catch (e) {
    check('test run completed', false, e.message);
  } finally {
    await stopApp(app);
    mock.close();
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
})();

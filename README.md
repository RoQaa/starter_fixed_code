# td-whatsapp-intake

A small Node/Express service that receives client WhatsApp messages through the Meta
Cloud API webhook. If a message contains an email address, it sends the client a
confirmation email through Resend and replies on WhatsApp. If not, it asks for an email
address. It is meant to run as a web service on Render.

## Run locally

Requires Node 20 or newer.

1. Put the provided `.env` file in the project root. It is git-ignored, so it is not in the repo.
2. Install and start:

   ```bash
   npm install
   npm start
   ```

The server listens on `http://localhost:3000`, with endpoints `GET /webhook`, `POST /webhook`
and `GET /health`.

`.env` is read by `src/config.js` with no extra dependency. Real environment variables take
precedence over the file, and every value is trimmed, so CRLF line endings or a trailing
space don't break anything. If a required variable is missing, the server exits at startup
and names it.

**Required:** only the original 5 variables.

| Variable | Purpose |
|---|---|
| `META_VERIFY_TOKEN` | Token you enter in the Meta webhook settings |
| `META_APP_SECRET` | Meta app secret, used to verify `X-Hub-Signature-256` |
| `META_ACCESS_TOKEN` | Token for sending WhatsApp replies |
| `WHATSAPP_PHONE_NUMBER_ID` | Fallback sender number (replies use the number the message arrived on) |
| `RESEND_API_KEY` | Resend API key |

**Optional:**

| Variable | Default | Notes |
|---|---|---|
| `RESEND_FROM` | `Top Delmon <onboarding@resend.dev>` | Prints a warning at startup. This sender only delivers to the Resend account owner |
| `PORT` | `3000` | Render sets this automatically |
| `GRAPH_API_VERSION` | `v21.0` | |
| `DEDUPE_DIR` | `./data/processed` | Where message-id claim files are stored |
| `MAX_EMAILS_PER_SENDER_PER_HOUR` | `3` | |
| `RESEND_MAX_ATTEMPTS` | `3` | Attempts on transient Resend errors |
| `RESEND_RETRY_BASE_MS` | `500` | Backoff is 500ms, then 1.5s |
| `RESEND_BASE_URL`, `GRAPH_API_BASE`, `ENV_FILE` | — | Test-only overrides (mock endpoints, alternate env file) |

## Test

```bash
npm test
```

`scripts/test-webhook.js` starts a local mock of Resend and the Graph API and runs the real
server against it, so no real email or WhatsApp message is sent. It checks:

- **Signature:** a valid signature is accepted. A bad, missing or hex-decoded-key signature gets `403`.
  `GET /webhook` echoes `hub.challenge`.
- **Duplicates:** the sample is sent twice, and exactly one email and one WhatsApp reply go out.
  The `Idempotency-Key` is present.
- **Restart:** after a server restart on the same claim directory, a resend still produces one email.
- **Retries:**
  - 500, then 429, then success: 3 attempts, the same key each time, one email.
  - 5xx three times: the client is never told "sent" or "check your address".
  - 422: no retry, and the client is asked to check the address.
  - 403 (testing sender): no retry, and the client is not asked to check the address.
- **Original `.env`:** with only the 5 variables, the server boots, warns, and sends from
  `onboarding@resend.dev`.

### Sending the sample manually

With the server running (`npm start`), run this from the project root in a second terminal.
It works in PowerShell, cmd and bash. It signs `samples/incoming-message.json` with
`META_APP_SECRET` (read from `.env` through `src/config.js`) and prints the HTTP status:

```bash
node -e "const c=require('./src/config'),b=require('fs').readFileSync('samples/incoming-message.json'),s='sha256='+require('crypto').createHmac('sha256',c.metaAppSecret).update(b).digest('hex');fetch('http://localhost:'+c.port+'/webhook',{method:'POST',headers:{'Content-Type':'application/json','X-Hub-Signature-256':s},body:b}).then(r=>console.log(r.status))"
```

Expect `200`. Changing one character of the signature gives `403`. Things to know:

- **Real API calls:** this calls the real Resend and Graph APIs, so with the sample keys both
  calls fail. The server log shows the attempts and how each error was classified.
- **Duplicates:** a second send of the same file is logged as `duplicate delivery, skipped`.
  To resend it, delete `data/processed/` or change `messages[0].id` in the sample.

## Problems found and fixed

**Deployment on Render**
- The port was hardcoded to 3000. It now uses `PORT`.
- Nothing loaded `.env`, and a missing key crashed the app inside the Resend SDK. There is
  now a small loader and a clear startup check.
- `.env` was not git-ignored. No Node version was pinned, and there was no lockfile.

**Security**
- `X-Hub-Signature-256` was never verified (`META_APP_SECRET` was unused). Anyone could POST
  fake messages and use the service to send email to any address.
- The client's text and WhatsApp profile name were inserted unescaped into the email HTML.
- There was no per-sender limit on emails. The verify-token comparison was not constant-time.
- Message text and email addresses were written to the logs. Logs now contain message ids only.

**Meta behavior**
- Webhook verification returned `OK` instead of echoing `hub.challenge`, so Meta could never
  verify the URL.
- Only the first entry, change and message of each delivery was processed. Batches were dropped.
- Work was done before the 200 response, and errors returned 500. Meta's timeouts and retries,
  plus its own duplicate deliveries, caused duplicate emails.
- WhatsApp send errors were ignored because `res.ok` was never checked.
- `object` and `field` were not checked. Replies didn't use the receiving `phone_number_id`.
  The Graph API version was hardcoded.

**Resend behavior**
- Every client got the false message "A confirmation email has been sent":
  - The SDK returns `{ error }` instead of throwing, and the code ignored it.
  - The sender was `onboarding@resend.dev`, which Resend rejects for anyone but the account owner.
- There was no retry on 429 or 5xx errors and no idempotency key.
- The email regex captured a sentence-ending period (`a@b.com.`), producing an invalid address.
- There was no plain-text version of the email.

## Key design decisions

- **The secret is a plain string.** `META_APP_SECRET` looks like hex, but Meta signs with the
  literal string, so the HMAC key is its UTF-8 bytes. A hex-decoded key would produce a
  different signature. The tests check that it is rejected.
- **The signature is checked against the raw body.** The HMAC is computed over the exact bytes
  Meta sent, kept through `express.json({ verify })`. Re-serialized JSON can differ in spacing,
  key order or Unicode escaping, and would fail.
- **Each message is processed at most once.** Each `message.id` is claimed atomically, before
  the 200 response and before any email or reply is sent. The claim creates one file with
  `O_EXCL`, so only one request can win. Duplicates and retries are skipped.
  - *Trade-off:* if something fails after the claim (a crash, or Resend still failing after
    retries), the message is **not** processed again automatically. Its outcome is recorded
    in the claim file for manual follow-up. A missed confirmation was judged better than a
    duplicate one.
  - If the claim itself fails (a disk error), the route returns `500` so Meta retries.
- **Meta is acknowledged first, the work happens afterwards.** The 200 goes back as soon as
  the ids are claimed. Resend and the Graph API are called after that, so a slow API or a cold
  start doesn't trigger Meta timeouts and redeliveries.
- **Resend errors fall into three kinds:**
  - **Transient** (429 rate limit, 5xx, network error, a clash with an idempotent request still
    in progress): retried up to 3 attempts with backoff. This is safe because every attempt
    carries the same `Idempotency-Key`, so Resend never sends twice.
  - **Address** (`validation_error` / `invalid_parameter`, but not 403): the client is asked to
    check their address.
  - **Permanent** (bad API key, quota exceeded, and `validation_error` **with 403**): no retry.
    Resend returns that 403 when the sender is `resend.dev` or a domain that hasn't been verified.
    That is a problem with our setup, not the client's address, so the client is only told the
    team will follow up.

  The client is never told the email was sent unless Resend accepted it.

## Before going to production on Render

- [ ] Set all environment variables in the Render dashboard. Don't deploy a `.env` file.
- [ ] Set `RESEND_FROM` to a sender on a **verified Resend domain**.
- [ ] Use a **permanent System User token** for `META_ACCESS_TOKEN`. Console tokens expire after about 24h.
- [ ] **Move the claim store to Redis or Postgres.** Render's filesystem is ephemeral (wiped on
      deploy and restart) and isn't shared between instances. Replace `FileClaimStore.claim()`
      with Redis `SET <id> 1 NX EX 604800`, or Postgres `INSERT … ON CONFLICT (message_id) DO NOTHING`
      and check the row count. Move the per-sender rate limit to the same store.
- [ ] Check that Graph API `v21.0` is still supported, and set `GRAPH_API_VERSION` if not.
- [ ] Use a paid instance, or accept free-tier cold starts. The free tier sleeps when idle, so
      the first message after a pause is slow and Meta may retry. Duplicates are absorbed.
- [ ] Rotate any secret that was ever shared, committed or sent around. That includes the `.env` values.

## Known limitations

- **Non-text messages** (images, voice notes, stickers, reactions, locations, button replies)
  have no text, so they get the "Please send your email address" reply.
- **No conversation state.** "Thanks" after a confirmation triggers the request for an email
  again, and every later message that contains an email sends another confirmation
  (each is a new `message.id`).
- **Claim files are never cleaned up.** `DEDUPE_DIR` grows by one small file per message. In
  production, Redis `SET … NX EX <ttl>` expires keys automatically.
- **The per-sender rate limit has a small race and is in memory.** The check happens before the
  Resend call and the count is recorded after it succeeds, so messages from the same sender
  processed at the same moment can exceed the limit by a few. The count also resets on restart.
- **`/health` is shallow.** It doesn't check configuration or reachability of Resend and Meta.
  There is no process-level `unhandledRejection` handler and no alerting.

## Not tested

- The **real Meta and Resend APIs**. All tests run against local mocks, which return the error
  formats documented in the Resend SDK.
- The **WhatsApp send error paths**: a Graph API error, an expired token, or the WhatsApp reply
  failing after the email was sent.

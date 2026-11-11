const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// At-most-once claim of a WhatsApp message id, persisted on disk.
//
// One file per message id, created with the 'wx' flag (O_CREAT | O_EXCL).
// The OS guarantees only one creator wins, even across concurrent requests or
// multiple processes sharing the directory, so the claim is atomic.
//
// PRODUCTION NOTE: Render's filesystem is ephemeral (wiped on every deploy and
// restart, and not shared between instances). This file store is only good for
// local runs. On Render, replace claim() with Redis `SET key 1 NX EX <ttl>` or a
// Postgres `INSERT ... ON CONFLICT DO NOTHING` on a unique message_id column.

class FileClaimStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  fileFor(messageId) {
    // wamid values are base64-ish and can contain characters unsafe for filenames.
    const name = crypto.createHash('sha256').update(messageId).digest('hex');
    return path.join(this.dir, `${name}.json`);
  }

  /** Returns true if this caller won the claim, false if it was already claimed. */
  claim(messageId) {
    const record = JSON.stringify({ messageId, claimedAt: new Date().toISOString(), status: 'claimed' });
    try {
      fs.writeFileSync(this.fileFor(messageId), record, { flag: 'wx' });
      return true;
    } catch (err) {
      if (err.code === 'EEXIST') return false;
      throw err;
    }
  }

  /** Records the outcome for later inspection. Never releases the claim. */
  mark(messageId, status, detail) {
    const record = JSON.stringify({ messageId, status, detail, updatedAt: new Date().toISOString() });
    fs.writeFileSync(this.fileFor(messageId), record);
  }
}

module.exports = { FileClaimStore };

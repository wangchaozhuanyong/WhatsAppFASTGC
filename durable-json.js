const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// A temporary transaction file is removed on success and failure. No backup is
// retained. EXDEV can occur even within the same Windows encrypted directory.
function writeTextDurably(file, text, { fsImpl = fs } = {}) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const content = Buffer.from(String(text), 'utf8');
  const sync = target => {
    const descriptor = fsImpl.openSync(target, 'r+');
    try { fsImpl.fsyncSync(descriptor); } finally { fsImpl.closeSync(descriptor); }
  };
  try {
    fsImpl.writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
    sync(temporary);
    try { fsImpl.renameSync(temporary, file); }
    catch (error) {
      if (error.code !== 'EXDEV') throw error;
      const previous = fsImpl.existsSync(file) ? fsImpl.readFileSync(file) : null;
      try {
        fsImpl.copyFileSync(temporary, file);
        sync(file);
        if (!fsImpl.readFileSync(file).equals(content)) throw new Error('SAVE_VERIFICATION_FAILED');
      } catch (saveError) {
        try {
          if (previous !== null) { fsImpl.writeFileSync(file, previous); sync(file); }
          else if (fsImpl.existsSync(file)) fsImpl.unlinkSync(file);
        } catch (_) { throw Object.assign(new Error('SAVE_ROLLBACK_FAILED'), { cause: saveError }); }
        throw saveError;
      }
    }
  } finally {
    try { if (fsImpl.existsSync(temporary)) fsImpl.unlinkSync(temporary); } catch (_) {}
  }
}

const writeJsonDurably = (file, value, options) => {
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error('INVALID_JSON_VALUE');
  return writeTextDurably(file, text, options);
};
module.exports = { writeTextDurably, writeJsonDurably };

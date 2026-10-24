const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeJsonDurably } = require('./durable-json');

function createSeatEnvironmentStore({ userDataDir, writeJson = writeJsonDurably }) {
  let root;
  function readRoot() {
    if (root) return root;
    const file = path.join(userDataDir(), 'fastgc-seat-environments.json');
    if (fs.existsSync(file)) {
      let saved;
      try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('SEAT_ENVIRONMENT_CONFIG_UNREADABLE'); }
      if (saved.v !== 1 || !/^[a-f0-9]{64}$/.test(saved.key)) throw new Error('SEAT_ENVIRONMENT_CONFIG_UNREADABLE');
      root = saved;
    } else {
      const next = { v: 1, key: crypto.randomBytes(32).toString('hex') };
      writeJson(file, next);
      root = next;
    }
    return root;
  }
  function profile(partition) {
    const match = /^fastgc-wa-seat-([1-9]\d?)(?:-([a-f0-9]{32}))?$/.exec(String(partition));
    if (!match || Number(match[1]) > 50) throw new Error('INVALID_SEAT_PARTITION');
    const saved = readRoot();
    const digest = purpose => crypto.createHmac('sha256', Buffer.from(saved.key, 'hex')).update(purpose + '\0' + partition).digest();
    const bytes = digest('privacy-noise-v1');
    return { v: 1, id: digest('display-id-v1').toString('hex').slice(0, 16), seat: match[1], seed: [0, 4, 8, 12].map(offset => bytes.readUInt32LE(offset)) };
  }
  return { profile };
}
module.exports = { createSeatEnvironmentStore };

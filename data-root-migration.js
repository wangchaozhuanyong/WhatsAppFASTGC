const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const hashFile = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const contained = (parent, child) => {
  const relative = path.relative(parent, child);
  return !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
};
function validateDataTarget(source, target) {
  const from = fs.realpathSync(source);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const to = path.join(fs.realpathSync(path.dirname(target)), path.basename(target));
  if (contained(from, to) || contained(to, from)) throw new Error('DATA_DIRECTORIES_OVERLAP');
  if (fs.existsSync(to) && fs.readdirSync(to).length) throw new Error('TARGET_NOT_EMPTY');
  return { from, to };
}
function migrateDataRootSync(source, target) {
  const { from, to } = validateDataTarget(source, target);
  let files = 0, bytes = 0;
  const ignoredRootFiles = new Set(['lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort']);
  const walk = relative => {
    const current = path.join(from, relative);
    fs.mkdirSync(path.join(to, relative), { recursive: true });
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (!relative && ignoredRootFiles.has(entry.name)) continue;
      if (entry.isSymbolicLink()) throw new Error('SYMLINK_IN_DATA_DIRECTORY');
      const next = path.join(relative, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile()) {
        const src = path.join(from, next), dst = path.join(to, next);
        fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
        const descriptor = fs.openSync(dst, 'r+');
        try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
        if (hashFile(src) !== hashFile(dst)) throw new Error('MIGRATION_VERIFY_FAILED');
        files += 1; bytes += fs.statSync(src).size;
      }
    }
  };
  walk('');
  return { ok: true, files, bytes };
}
module.exports = { validateDataTarget, migrateDataRootSync };

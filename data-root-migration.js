const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const hashFile = file => {
  const hash = crypto.createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024);
  const descriptor = fs.openSync(file, 'r');
  try {
    let size;
    while ((size = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, size));
    return hash.digest('hex');
  } finally { fs.closeSync(descriptor); }
};
const contained = (parent, child) => {
  const relative = path.relative(parent, child);
  return !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
};
function validateDataTarget(source, target) {
  const from = fs.realpathSync(source);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const to = path.join(fs.realpathSync(path.dirname(target)), path.basename(target));
  if (contained(from, to) || contained(to, from)) throw new Error('DATA_DIRECTORIES_OVERLAP');
  if (fs.existsSync(to) && fs.lstatSync(to).isSymbolicLink()) throw new Error('SYMLINK_DATA_TARGET');
  if (fs.existsSync(to) && fs.readdirSync(to).length) throw new Error('TARGET_NOT_EMPTY');
  return { from, to };
}
function migrateDataRootSync(source, target) {
  const { from, to } = validateDataTarget(source, target);
  let files = 0, bytes = 0;
  const createdFiles = [], createdDirectories = [];
  const ignoredRootFiles = new Set(['lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort']);
  const walk = relative => {
    const current = path.join(from, relative);
    const destinationDirectory = path.join(to, relative);
    if (!fs.existsSync(destinationDirectory)) { fs.mkdirSync(destinationDirectory); createdDirectories.push(destinationDirectory); }
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (!relative && ignoredRootFiles.has(entry.name)) continue;
      if (entry.isSymbolicLink()) throw new Error('SYMLINK_IN_DATA_DIRECTORY');
      const next = path.join(relative, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile()) {
        const src = path.join(from, next), dst = path.join(to, next);
        const ownedFile = fs.openSync(dst, 'wx');
        createdFiles.push(dst);
        fs.closeSync(ownedFile);
        fs.copyFileSync(src, dst);
        const descriptor = fs.openSync(dst, 'r+');
        try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
        if (hashFile(src) !== hashFile(dst)) throw new Error('MIGRATION_VERIFY_FAILED');
        files += 1; bytes += fs.statSync(src).size;
      }
    }
  };
  try { walk(''); }
  catch (error) {
    let rollbackFailed = false;
    for (const file of createdFiles.reverse()) {
      try {
        if (!contained(to, fs.realpathSync(path.dirname(file)))) throw new Error('ROLLBACK_PATH_CHANGED');
        fs.unlinkSync(file);
      } catch (_) { rollbackFailed = true; }
    }
    for (const directory of createdDirectories.reverse()) { try { fs.rmdirSync(directory); } catch (_) { rollbackFailed = true; } }
    if (rollbackFailed) throw Object.assign(new Error('MIGRATION_ROLLBACK_INCOMPLETE'), { cause: error });
    throw error;
  }
  return { ok: true, files, bytes };
}
module.exports = { validateDataTarget, migrateDataRootSync, hashFile };

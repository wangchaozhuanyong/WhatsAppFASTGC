import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projRoot = path.resolve(scriptDir, '..');
const outDir = path.join(projRoot, 'dist');
const outfile = path.join(outDir, 'build-meta.json');

function tryExec(cmd) {
  try {
    return String(execSync(cmd, { cwd: projRoot, stdio: ['ignore', 'pipe', 'ignore'] }) || '')
      .trim();
  } catch {
    return '';
  }
}

const gitCommit = tryExec('git rev-parse --short HEAD');
const gitDirty = tryExec('git status --porcelain') ? true : false;
const builtAt = new Date().toISOString();
const buildId = `${builtAt.replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')}${gitCommit ? `-${gitCommit}` : ''}${gitDirty ? '-dirty' : ''}`;

await fs.promises.mkdir(outDir, { recursive: true });
await fs.promises.writeFile(
  outfile,
  JSON.stringify(
    {
      builtAt,
      gitCommit: gitCommit || null,
      gitDirty,
      buildId,
    },
    null,
    2,
  ),
  'utf8',
);

console.log('[build-meta] wrote', outfile, 'buildId=', buildId);


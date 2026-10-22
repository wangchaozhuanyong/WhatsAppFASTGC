const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { armWindowsShutdownGuard } = require('../shutdown-guard');

(async () => {
  if (process.platform !== 'win32') { console.log('Shutdown guard: Windows-only integration skipped'); return; }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fastgc-shutdown-guard-'));
  const logFile = path.join(directory, 'guard.jsonl');
  const stuck = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
  const stuckExit = once(stuck, 'exit');
  const started = Date.now();
  const result = await armWindowsShutdownGuard({ pid: stuck.pid, executable: process.execPath, logFile, timeoutMs: 1000 });
  assert.equal(result.armed, true);
  await Promise.race([stuckExit, new Promise((_, reject) => setTimeout(() => reject(new Error('Guard did not terminate synthetic child')), 9000).unref())]);
  assert.equal(JSON.parse(fs.readFileSync(logFile, 'utf8').trim()).pid, stuck.pid);
  const normal = spawn(process.execPath, ['-e', 'setTimeout(()=>process.exit(0),2500)'], { windowsHide: true, stdio: 'ignore' });
  const normalExit = once(normal, 'exit');
  await armWindowsShutdownGuard({ pid: normal.pid, executable: process.execPath, logFile, timeoutMs: 5000 });
  const [code] = await normalExit;
  assert.equal(code, 0);
  assert.equal(fs.readFileSync(logFile, 'utf8').trim().split('\n').length, 1);
  await assert.rejects(armWindowsShutdownGuard({pid:-1,executable:process.execPath,logFile}), /INVALID/);
  console.log(JSON.stringify({passed:true,forcedSyntheticChildOnly:true,normalExitUntouched:true,elapsedMs:Date.now()-started}));
})().catch(error => { console.error(error); process.exitCode=1; });

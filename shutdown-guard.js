const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Windows Chromium can remain in native teardown after all guests are destroyed.
// Arm only AFTER SQLite/cache/session persistence has completed. The helper holds
// a handle to this exact, still-running process before reporting ARMED, so a new
// application instance (or a reused PID) can never become the termination target.
function armWindowsShutdownGuard({ pid = process.pid, executable = process.execPath, logFile, timeoutMs = 8000, spawnImpl = spawn } = {}) {
  if (process.platform !== 'win32') return Promise.resolve({ armed: false });
  if (!Number.isSafeInteger(pid) || pid <= 0 || !path.isAbsolute(executable) || !path.isAbsolute(logFile || '') || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) {
    return Promise.reject(new Error('INVALID_SHUTDOWN_GUARD'));
  }
  let readyDirectory;
  try { readyDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'fastgc-exit-ready-')); }
  catch (error) { return Promise.reject(error); }
  const readyFile = path.join(readyDirectory, 'armed');
  const literal = value => "'" + String(value).replace(/'/g, "''") + "'";
  const script = `
$ErrorActionPreference = 'Stop'
$target = [Diagnostics.Process]::GetProcessById(${pid})
if ($target.MainModule.FileName -ine ${literal(executable)}) { exit 2 }
$processHandle = $target.Handle
if ($target.HasExited) { exit 0 }
[IO.File]::WriteAllText(${literal(readyFile)}, 'ARMED')
if (-not $target.WaitForExit(${timeoutMs})) {
  $entry = @{ts=[DateTime]::UtcNow.ToString('o');event='shutdown-native-timeout';pid=${pid};timeoutMs=${timeoutMs}} | ConvertTo-Json -Compress
  try { [IO.File]::AppendAllText(${literal(logFile)}, $entry + [Environment]::NewLine, [Text.UTF8Encoding]::new($false)) } catch {}
  $target.Kill()
  $target.WaitForExit(3000) | Out-Null
}
$target.Dispose()
`;
  const powerShell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    // No inherited or piped stdio handles may connect this waiting child back
    // to Electron's native teardown. A private file confirms the held handle.
    // Keep detached false: Windows PowerShell 5 otherwise skips the command.
    const child = spawnImpl(powerShell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore' });
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      try { fs.unlinkSync(readyFile); } catch (_) {}
      try { fs.rmdirSync(readyDirectory); } catch (_) {}
      child.unref();
      error ? reject(error) : resolve({ armed: true, timeoutMs });
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error('SHUTDOWN_GUARD_HANDSHAKE_TIMEOUT')); }, 5000);
    const poll = setInterval(() => {
      try { if (fs.readFileSync(readyFile, 'utf8') === 'ARMED') finish(); }
      catch (_) {}
    }, 20);
    child.once('error', finish);
    child.once('exit', code => { if (!settled) finish(new Error(`SHUTDOWN_GUARD_EXIT_${code}`)); });
  });
}

module.exports = { armWindowsShutdownGuard };

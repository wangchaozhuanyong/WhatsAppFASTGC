const { spawn } = require('node:child_process');
const path = require('node:path');

// Windows Chromium can remain in native teardown after all guests are destroyed.
// Arm only AFTER SQLite/cache/session persistence has completed. The helper holds
// a handle to this exact, still-running process before reporting ARMED, so a new
// application instance (or a reused PID) can never become the termination target.
function armWindowsShutdownGuard({ pid = process.pid, executable = process.execPath, logFile, timeoutMs = 8000, spawnImpl = spawn } = {}) {
  if (process.platform !== 'win32') return Promise.resolve({ armed: false });
  if (!Number.isSafeInteger(pid) || pid <= 0 || !path.isAbsolute(executable) || !path.isAbsolute(logFile || '') || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000) {
    return Promise.reject(new Error('INVALID_SHUTDOWN_GUARD'));
  }
  const literal = value => "'" + String(value).replace(/'/g, "''") + "'";
  const script = `
$ErrorActionPreference = 'Stop'
$target = [Diagnostics.Process]::GetProcessById(${pid})
if ($target.MainModule.FileName -ine ${literal(executable)}) { exit 2 }
$processHandle = $target.Handle
if ($target.HasExited) { exit 0 }
[Console]::Out.WriteLine('ARMED')
[Console]::Out.Flush()
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
    // Windows PowerShell 5 exits without executing commands when launched with
    // DETACHED_PROCESS. Windows child processes survive their parent's exit;
    // hide the window and unref after the handshake instead of detaching here.
    const child = spawnImpl(powerShell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let settled = false, output = '';
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      child.unref();
      error ? reject(error) : resolve({ armed: true, timeoutMs });
    };
    const timer = setTimeout(() => { child.kill(); finish(new Error('SHUTDOWN_GUARD_HANDSHAKE_TIMEOUT')); }, 5000);
    child.once('error', finish);
    child.once('exit', code => { if (!settled) finish(new Error(`SHUTDOWN_GUARD_EXIT_${code}`)); });
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('ARMED')) finish(); });
  });
}

module.exports = { armWindowsShutdownGuard };

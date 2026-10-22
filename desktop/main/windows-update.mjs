import { win32 } from 'node:path';

export function windowsInstallCommand({ directory, appPath, pid, systemRoot = 'C:\\Windows' }) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Wait-Process -Id ([int]$env:OTTO_UPDATE_PID) -Timeout 300 -ErrorAction SilentlyContinue',
    `$installer = Start-Process -FilePath (Join-Path $env:OTTO_UPDATE_DIRECTORY 'Otto-Setup-x64.exe') -ArgumentList ('/S /D=' + $env:OTTO_UPDATE_TARGET) -Wait -PassThru`,
    'if ($installer.ExitCode -ne 0) { exit $installer.ExitCode }',
    "Start-Process -FilePath (Join-Path $env:OTTO_UPDATE_TARGET 'Otto.exe')",
  ].join('\n');
  return {
    command: win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    env: {
      OTTO_UPDATE_PID: String(pid),
      OTTO_UPDATE_DIRECTORY: directory,
      OTTO_UPDATE_TARGET: win32.dirname(appPath),
    },
  };
}

import { spawn } from 'node:child_process';
import { win32 } from 'node:path';

export function windowsInstallCommand({ directory, appPath, pid, systemRoot = 'C:\\Windows' }) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    'Wait-Process -Id ([int]$env:NOD_UPDATE_PID) -Timeout 300 -ErrorAction SilentlyContinue',
    `$installer = Start-Process -FilePath (Join-Path $env:NOD_UPDATE_DIRECTORY 'nod-Setup-x64.exe') -ArgumentList ('/S /D=' + $env:NOD_UPDATE_TARGET) -Wait -PassThru`,
    'if ($installer.ExitCode -ne 0) { exit $installer.ExitCode }',
    "Start-Process -FilePath (Join-Path $env:NOD_UPDATE_TARGET 'nod.exe')",
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
      NOD_UPDATE_PID: String(pid),
      NOD_UPDATE_DIRECTORY: directory,
      NOD_UPDATE_TARGET: win32.dirname(appPath),
    },
  };
}

export function startWindowsInstall(options) {
  const { command, args, env } = windowsInstallCommand(options);
  return new Promise((resolve, reject) => {
    const launcher = spawn(
      command,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$ErrorActionPreference = 'Stop'; Start-Process -FilePath $env:NOD_UPDATE_POWERSHELL -WindowStyle Hidden -ArgumentList $env:NOD_UPDATE_ARGUMENTS",
      ],
      {
        stdio: 'ignore',
        windowsHide: true,
        env: {
          ...process.env,
          ...env,
          NOD_UPDATE_POWERSHELL: command,
          NOD_UPDATE_ARGUMENTS: args.join(' '),
        },
      },
    );
    launcher.once('error', reject);
    launcher.once('exit', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Nod could not start the Windows installer (${code}).`)),
    );
  });
}

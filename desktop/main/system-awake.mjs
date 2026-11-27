import { spawn } from 'node:child_process';
import { join } from 'node:path';

const script = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NodAwake {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Reason { public uint Version; public uint Flags; public string Text; }
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr PowerCreateRequest(ref Reason reason);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool PowerSetRequest(IntPtr request, int type);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool PowerClearRequest(IntPtr request, int type);
}
'@
$reason = New-Object NodAwake+Reason
$reason.Version = 0
$reason.Flags = 1
$reason.Text = 'Nod is keeping this computer awake for its work and schedules'
$request = [NodAwake]::PowerCreateRequest([ref]$reason)
if ($request -eq [IntPtr]::new(-1)) { throw "Windows refused a power request (error $([Runtime.InteropServices.Marshal]::GetLastWin32Error()))." }
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $done = if ($line -eq 'hold') { [NodAwake]::PowerSetRequest($request, 1) } else { [NodAwake]::PowerClearRequest($request, 1) }
  if (-not $done) { throw "Windows refused to $line the power request (error $([Runtime.InteropServices.Marshal]::GetLastWin32Error()))." }
}
`;

export function createSystemAwake({ onFailure, environment = process.env }) {
  let child;
  let held = false;
  function start() {
    const current = spawn(
      join(
        environment.SYSTEMROOT || 'C:\\Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      ),
      [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true },
    );
    let errors = '';
    current.stderr.on('data', (chunk) => {
      errors = (errors + chunk).slice(-2000);
    });
    current.stdin.on('error', () => {});
    current.on('error', (error) => {
      if (child !== current) return;
      child = undefined;
      onFailure(error.message);
    });
    current.on('exit', (code) => {
      if (child !== current) return;
      child = undefined;
      onFailure(`The helper stopped with code ${code}. ${errors.trim()}`.trim());
    });
    return current;
  }
  return {
    set(hold) {
      if (hold === held) return;
      held = hold;
      if (hold && !child) child = start();
      child?.stdin.write(hold ? 'hold\n' : 'release\n');
    },
    close() {
      const current = child;
      child = undefined;
      held = false;
      current?.stdin.end();
    },
  };
}

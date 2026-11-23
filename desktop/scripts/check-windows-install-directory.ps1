$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
  throw 'Use a disposable GitHub Windows runner.'
}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class InstallerWindow {
  [StructLayout(LayoutKind.Sequential)]
  public struct Rectangle { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")]
  public static extern bool PostMessage(IntPtr window, uint message, IntPtr command, IntPtr value);
  [DllImport("user32.dll")]
  public static extern IntPtr GetLastActivePopup(IntPtr window);
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr window, out Rectangle rectangle);
  [DllImport("user32.dll")]
  public static extern bool PrintWindow(IntPtr window, IntPtr target, uint flags);
}
'@
function Wait-For($state, $read) {
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    $process.Refresh()
    if ($process.HasExited) { throw 'The installer closed before the folder check completed.' }
    $value = & $read
    if ($value) { return $value }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "The installer did not reach this state: $state."
}
$process = Start-Process -FilePath $env:NOD_INSTALLER_PATH -PassThru
try {
  $handle = Wait-For 'window opened' { if ($process.MainWindowHandle -ne [IntPtr]::Zero) { $process.MainWindowHandle } }
  $window = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Edit
  )
  $edit = Wait-For 'folder field shown' { $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition) }
  $value = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  $value.SetValue($env:NOD_INSTALLER_REJECT)
  [void][InstallerWindow]::PostMessage($handle, 0x111, [IntPtr]1, [IntPtr]::Zero)
  $popup = Wait-For 'occupied folder refused' {
    $active = [InstallerWindow]::GetLastActivePopup($handle)
    if ($active -ne $handle -and $active -ne [IntPtr]::Zero) { $active }
  }
  [void][InstallerWindow]::PostMessage($popup, 0x111, [IntPtr]1, [IntPtr]::Zero)
  [void](Wait-For 'folder page restored' { [InstallerWindow]::GetLastActivePopup($handle) -eq $handle })
  $edit = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
  $value = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  $value.SetValue($env:NOD_INSTALLER_TARGET)
  $bounds = New-Object InstallerWindow+Rectangle
  if (-not [InstallerWindow]::GetWindowRect($handle, [ref]$bounds)) { throw 'The installer window has no bounds.' }
  $bitmap = New-Object System.Drawing.Bitmap(($bounds.Right - $bounds.Left), ($bounds.Bottom - $bounds.Top), [System.Drawing.Imaging.PixelFormat]::Format32bppRgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $target = $graphics.GetHdc()
  try {
    if (-not [InstallerWindow]::PrintWindow($handle, $target, 2)) { throw 'The installer window could not be captured.' }
  } finally {
    $graphics.ReleaseHdc($target)
    $graphics.Dispose()
  }
  try { $bitmap.Save($env:NOD_INSTALLER_SCREENSHOT, [System.Drawing.Imaging.ImageFormat]::Png) }
  finally { $bitmap.Dispose() }
  [void][InstallerWindow]::PostMessage($handle, 0x111, [IntPtr]1, [IntPtr]::Zero)
  if (-not $process.WaitForExit(120000)) { throw 'The installer did not finish.' }
  if ($process.ExitCode -ne 0) { throw "The installer failed with code $($process.ExitCode)." }
  $registered = Get-ItemPropertyValue -LiteralPath 'HKCU:\Software\nod' -Name InstallDir
  if ([System.IO.Path]::GetFullPath($registered) -ne [System.IO.Path]::GetFullPath($env:NOD_INSTALLER_TARGET)) {
    throw 'The installer did not save the chosen folder.'
  }
} finally {
  if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
}

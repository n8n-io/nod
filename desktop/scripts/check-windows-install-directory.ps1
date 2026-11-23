$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
  throw 'Use a disposable GitHub Windows runner.'
}
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
  public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")]
  public static extern bool IsWindowEnabled(IntPtr window);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string name, string title);
  [DllImport("user32.dll")]
  public static extern IntPtr GetDlgItem(IntPtr window, int id);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr command, string value);
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr window, out Rectangle rectangle);
  [DllImport("user32.dll")]
  public static extern bool PrintWindow(IntPtr window, IntPtr target, uint flags);
}
'@
function Wait-For($state, $read) {
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  do {
    $process.Refresh()
    if ($process.HasExited) { throw 'The installer closed before the folder check completed.' }
    $value = & $read
    if ($value) { return $value }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "The installer did not reach this state: $state."
}
function Get-FolderPage {
  Wait-For 'folder field shown' {
    $handle = $process.MainWindowHandle
    if ($handle -eq [IntPtr]::Zero) { return }
    $page = [InstallerWindow]::FindWindowEx($handle, [IntPtr]::Zero, '#32770', $null)
    $field = [InstallerWindow]::GetDlgItem($page, 1019)
    if ($field -ne [IntPtr]::Zero) { @{ Window = $handle; Field = $field } }
  }
}
function Save-InstallerWindow($handle) {
  $bounds = New-Object InstallerWindow+Rectangle
  if (-not [InstallerWindow]::GetWindowRect($handle, [ref]$bounds)) { throw 'The installer window has no bounds.' }
  $bitmap = New-Object System.Drawing.Bitmap(($bounds.Right - $bounds.Left), ($bounds.Bottom - $bounds.Top), [System.Drawing.Imaging.PixelFormat]::Format32bppRgb)
  try {
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $target = $graphics.GetHdc()
    try {
      if (-not [InstallerWindow]::PrintWindow($handle, $target, 2)) { throw 'The installer window could not be captured.' }
    } finally {
      $graphics.ReleaseHdc($target)
      $graphics.Dispose()
    }
    $bitmap.Save($env:NOD_INSTALLER_SCREENSHOT, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally { $bitmap.Dispose() }
}
$process = Start-Process -FilePath $env:NOD_INSTALLER_PATH -PassThru
try {
  $page = Get-FolderPage
  $handle = $page.Window
  if ([InstallerWindow]::SendMessage($page.Field, 0xC, [IntPtr]::Zero, $env:NOD_INSTALLER_REJECT) -eq [IntPtr]::Zero) {
    throw 'The installer did not accept the occupied folder input.'
  }
  [void][InstallerWindow]::PostMessage($handle, 0x111, [IntPtr]1, [IntPtr]::Zero)
  $popup = Wait-For 'occupied folder refused' {
    $active = [InstallerWindow]::GetLastActivePopup($handle)
    if ($active -ne $handle -and $active -ne [IntPtr]::Zero -and [InstallerWindow]::IsWindowVisible($active)) { $active }
  }
  [void][InstallerWindow]::PostMessage($popup, 0x10, [IntPtr]::Zero, [IntPtr]::Zero)
  [void](Wait-For 'folder page restored' { -not [InstallerWindow]::IsWindowVisible($popup) -and [InstallerWindow]::IsWindowEnabled($handle) })
  $page = Get-FolderPage
  $handle = $page.Window
  if ([InstallerWindow]::SendMessage($page.Field, 0xC, [IntPtr]::Zero, $env:NOD_INSTALLER_TARGET) -eq [IntPtr]::Zero) {
    throw 'The installer did not accept the chosen folder input.'
  }
  Save-InstallerWindow $handle
  [void][InstallerWindow]::PostMessage($handle, 0x111, [IntPtr]1, [IntPtr]::Zero)
  if (-not $process.WaitForExit(120000)) { throw 'The installer did not finish.' }
  if ($process.ExitCode -ne 0) { throw "The installer failed with code $($process.ExitCode)." }
  $registered = Get-ItemPropertyValue -LiteralPath 'HKCU:\Software\nod' -Name InstallDir
  if ([System.IO.Path]::GetFullPath($registered) -ne [System.IO.Path]::GetFullPath($env:NOD_INSTALLER_TARGET)) {
    throw 'The installer did not save the chosen folder.'
  }
} catch {
  $failure = $_
  try {
    $process.Refresh()
    if (-not $process.HasExited) {
      [Console]::Error.WriteLine("Installer window: $($process.MainWindowTitle)")
      $active = [InstallerWindow]::GetLastActivePopup($process.MainWindowHandle)
      if ($active -ne [IntPtr]::Zero -and [InstallerWindow]::IsWindowVisible($active)) { Save-InstallerWindow $active }
      else { Save-InstallerWindow $process.MainWindowHandle }
    }
  } catch { [Console]::Error.WriteLine("Installer capture failed: $($_.Exception.Message)") }
  throw $failure
} finally {
  if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
}

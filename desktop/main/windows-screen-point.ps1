param([int]$X=0,[int]$Y=0,[switch]$Point,[int]$Left,[int]$Top,[int]$Width,[int]$Height)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,WindowsBase
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class NodScreen {
  [StructLayout(LayoutKind.Sequential)] struct Rect {public int left,top,right,bottom;}
  delegate bool WindowCallback(IntPtr window, IntPtr unused);
  [DllImport("user32")] static extern bool EnumWindows(WindowCallback callback, IntPtr unused);
  [DllImport("user32")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32")] static extern bool IsIconic(IntPtr window);
  [DllImport("user32")] static extern bool GetWindowRect(IntPtr window, out Rect bounds);
  [DllImport("dwmapi")] static extern int DwmGetWindowAttribute(IntPtr window, uint attribute, out int value, int size);
  public static uint[] VisibleProcesses(int x,int y,int w,int h) {
    var pids=new System.Collections.Generic.HashSet<uint>();
    if(!EnumWindows(delegate(IntPtr window, IntPtr unused) {
      Rect r; int cloaked; uint pid;
      if(IsWindowVisible(window) && !IsIconic(window) && GetWindowRect(window,out r) &&
        r.left < x+w && r.right > x && r.top < y+h && r.bottom > y && r.right>r.left && r.bottom>r.top &&
        (DwmGetWindowAttribute(window,14,out cloaked,4)!=0 || cloaked==0) &&
        GetWindowThreadProcessId(window,out pid)!=0) pids.Add(pid);
      return true;
    },IntPtr.Zero)) throw new InvalidOperationException("Cannot check the visible windows.");
    var result=new uint[pids.Count];pids.CopyTo(result);return result;
  }
  [StructLayout(LayoutKind.Sequential)] public struct Pt {public int x,y;}
  [DllImport("user32")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32")] public static extern IntPtr WindowFromPhysicalPoint(Pt pt);
  [DllImport("user32")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint kind);
  [DllImport("user32")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32",SetLastError=true)] public static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
  [DllImport("user32",CharSet=CharSet.Unicode)] public static extern bool GetUserObjectInformation(IntPtr h,int index,StringBuilder value,int bytes,out int needed);
  [DllImport("user32")] public static extern bool CloseDesktop(IntPtr h);
}
"@
$desktop=[NodScreen]::OpenInputDesktop(0,$false,1)
if ($desktop -eq [IntPtr]::Zero) {throw 'Desktop capture is unavailable on this Windows desktop.'}
try {
  $label=[Text.StringBuilder]::new(256);$needed=0
  if (-not [NodScreen]::GetUserObjectInformation($desktop,2,$label,512,[ref]$needed) -or $label.ToString() -ne 'Default') {throw 'Protected Windows desktop.'}
} finally {[void][NodScreen]::CloseDesktop($desktop)}
[void][NodScreen]::SetThreadDpiAwarenessContext([IntPtr]::new(-4))
$element=[System.Windows.Automation.AutomationElement]
$focus=$element::FocusedElement
if ($null -eq $focus -or $focus.Current.IsPassword) {throw 'The current keyboard focus cannot be shared.'}
if (!$Point) {
  $programs=@(foreach ($processId in [NodScreen]::VisibleProcesses($Left,$Top,$Width,$Height)) {
    [Diagnostics.Process]::GetProcessById($processId).ProcessName+'.exe'
  })
  [Console]::Write((@{programs=$programs}|ConvertTo-Json -Compress))
  exit
}
$pt=[NodScreen+Pt]::new();$pt.x=$X;$pt.y=$Y
$hwnd=[NodScreen]::GetAncestor([NodScreen]::WindowFromPhysicalPoint($pt),2)
[uint32]$ownerId=0
if ($hwnd -eq [IntPtr]::Zero -or -not [NodScreen]::GetWindowThreadProcessId($hwnd,[ref]$ownerId)){throw 'The selected window changed.'}
$item=$element::FromPoint([Windows.Point]::new($X,$Y))
if ($null -eq $item -or $item.Current.IsPassword){throw 'The selected control cannot be shared.'}
$program=[Diagnostics.Process]::GetProcessById($ownerId).ProcessName+'.exe'
$result=@{pid=[int64]$ownerId;window=('w-'+$hwnd.ToInt64());app=$program;role=$item.Current.ControlType.ProgrammaticName.Replace('ControlType.','').ToLowerInvariant();name=([string]$item.Current.Name)}
if ($result.name.Length -gt 250){$result.name=''}
[Console]::Write(($result|ConvertTo-Json -Compress))

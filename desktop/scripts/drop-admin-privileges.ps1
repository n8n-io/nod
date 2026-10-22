param([Parameter(Mandatory)][int]$ProcessId)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class NodTokenPrivilege {
  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  struct Privileges { public int Count; public long Luid; public int Attributes; }
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool OpenProcessToken(IntPtr process, int access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool LookupPrivilegeValue(string system, string name, out long luid);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref Privileges state, int length, IntPtr previous, IntPtr returned);
  public static void Remove(IntPtr process, string name) {
    IntPtr token;
    Privileges state = new Privileges { Count = 1, Attributes = 4 };
    if (!OpenProcessToken(process, 0x20, out token) || !LookupPrivilegeValue(null, name, out state.Luid) || !AdjustTokenPrivileges(token, false, ref state, 0, IntPtr.Zero, IntPtr.Zero))
      throw new Win32Exception();
    int error = Marshal.GetLastWin32Error();
    if (error != 0 && error != 1300) throw new Win32Exception(error);
  }
}
'@
$process = [Diagnostics.Process]::GetProcessById($ProcessId).Handle
foreach ($name in 'SeSecurityPrivilege', 'SeRestorePrivilege', 'SeBackupPrivilege', 'SeTakeOwnershipPrivilege') {
  [NodTokenPrivilege]::Remove($process, $name)
}

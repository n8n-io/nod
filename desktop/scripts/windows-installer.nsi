Unicode true
!include "MUI2.nsh"
!include "x64.nsh"
Name "Nod"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\nod"
InstallDirRegKey HKCU "Software\nod" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID zlib
ShowInstDetails show
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\nod.exe"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${IfNot} ${IsNativeAMD64}
    MessageBox MB_ICONSTOP "Nod needs Windows 11 on an x64 computer." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
  ReadRegStr $0 HKLM "Software\Microsoft\Windows NT\CurrentVersion" "CurrentBuildNumber"
  ${If} $0 < 22000
    MessageBox MB_ICONSTOP "Nod needs Windows 11 or later." /SD IDOK
    SetErrorLevel 1
    Abort
  ${EndIf}
FunctionEnd

Function CheckInstallDirectory
  IfFileExists "$INSTDIR\.nod-installation" directory_ready
  FindFirst $0 $1 "$INSTDIR\*"
  directory_next:
    StrCmp $1 "" directory_empty
    StrCmp $1 "." directory_continue
    StrCmp $1 ".." directory_continue
    FindClose $0
    MessageBox MB_ICONSTOP "Choose an empty folder for Nod. The selected folder contains other files." /SD IDOK
    SetErrorLevel 1
    Abort
  directory_continue:
    FindNext $0 $1
    Goto directory_next
  directory_empty:
    FindClose $0
  directory_ready:
    ClearErrors
FunctionEnd

Function .onVerifyInstDir
  Call CheckInstallDirectory
FunctionEnd

Section "nod"
  Call CheckInstallDirectory
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  FileOpen $0 "$INSTDIR\.nod-installation" w
  FileWrite $0 "nod-win32-x64"
  FileClose $0
  IfErrors 0 directory_marked
    SetErrorLevel 1
    Abort
  directory_marked:
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  File /r "${APP_DIR}\*"
  IfFileExists "$EXEDIR\nod-Runtime-win32-x64.tar.gz" 0 runtime_copied
    ClearErrors
    CopyFiles /SILENT "$EXEDIR\nod-Runtime-win32-x64.tar.gz" "$INSTDIR\resources\engine\windows-runtime\guest.tar.gz"
    IfErrors 0 runtime_copied
      MessageBox MB_ICONSTOP "Nod could not copy its runtime. Check free disk space, then run this installer again." /SD IDOK
      SetErrorLevel 1
      Abort
  runtime_copied:
  CreateDirectory "$SMPROGRAMS\Nod"
  CreateShortcut "$SMPROGRAMS\Nod\Nod.lnk" "$INSTDIR\nod.exe"
  CreateShortcut "$SMPROGRAMS\Nod\Uninstall.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortcut "$DESKTOP\Nod.lnk" "$INSTDIR\nod.exe"
  WriteRegStr HKCU "Software\nod" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\nod" "DisplayName" "Nod"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\nod" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\nod" "Publisher" "n8n GmbH"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\nod" "UninstallString" '$"$INSTDIR\Uninstall.exe$"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\nod" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\nod" "NoRepair" 1
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  Delete "$DESKTOP\Nod.lnk"
  Delete "$SMPROGRAMS\Nod\Nod.lnk"
  Delete "$SMPROGRAMS\Nod\Uninstall.lnk"
  RMDir "$SMPROGRAMS\Nod"
  IfFileExists "$INSTDIR\.nod-installation" 0 files_removed
    RMDir /r "$INSTDIR"
  files_removed:
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\nod"
  DeleteRegKey HKCU "Software\nod"
SectionEnd

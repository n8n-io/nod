Unicode true
!include "MUI2.nsh"
!include "x64.nsh"
Name "Otto"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\Otto"
InstallDirRegKey HKCU "Software\Otto" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
ShowInstDetails show
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\Otto.exe"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_ICONSTOP "Otto needs Windows 11 on an x64 computer."
    Abort
  ${EndIf}
  IfFileExists "$EXEDIR\Otto-Runtime-win32-x64.tar.gz" runtime_found
    MessageBox MB_ICONSTOP "Extract both download files into one folder, then run this installer again."
    Abort
  runtime_found:
FunctionEnd

Section "Otto"
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  File /r "${APP_DIR}\*"
  SetOutPath "$INSTDIR\resources\engine\windows-runtime"
  CopyFiles /SILENT "$EXEDIR\Otto-Runtime-win32-x64.tar.gz" "$INSTDIR\resources\engine\windows-runtime\guest.tar.gz"
  IfErrors 0 runtime_copied
    MessageBox MB_ICONSTOP "Otto could not copy its runtime. Check free disk space, then run this installer again."
    Abort
  runtime_copied:
  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\Otto"
  CreateShortcut "$SMPROGRAMS\Otto\Otto.lnk" "$INSTDIR\Otto.exe"
  CreateShortcut "$SMPROGRAMS\Otto\Uninstall.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortcut "$DESKTOP\Otto.lnk" "$INSTDIR\Otto.exe"
  WriteRegStr HKCU "Software\Otto" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Otto" "DisplayName" "Otto"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Otto" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Otto" "Publisher" "n8n GmbH"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Otto" "UninstallString" '$"$INSTDIR\Uninstall.exe$"'
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Otto" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Otto" "NoRepair" 1
SectionEnd

Section "Uninstall"
  SetShellVarContext current
  Delete "$DESKTOP\Otto.lnk"
  Delete "$SMPROGRAMS\Otto\Otto.lnk"
  Delete "$SMPROGRAMS\Otto\Uninstall.lnk"
  RMDir "$SMPROGRAMS\Otto"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Otto"
  DeleteRegKey HKCU "Software\Otto"
SectionEnd

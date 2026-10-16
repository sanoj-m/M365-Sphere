; M365-Sphere NSIS installer
; Builds M365Sphere-Setup.exe from the staged tree in installer\stage.
; User-level install to %LOCALAPPDATA%\M365-Sphere (the app writes ./data).

Unicode true
!define APPNAME "M365-Sphere"
!ifndef APPVER
  !define APPVER "1.0.0"
!endif
!define PUBLISHER "M365-Sphere"
!define OUTFILE "M365Sphere-Setup.exe"

Name "${APPNAME} ${APPVER}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\M365-Sphere"
RequestExecutionLevel user
SetCompressor /SOLID lzma

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!insertmacro GetParent

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$SYSDIR\cmd.exe"
!define MUI_FINISHPAGE_RUN_PARAMETERS "/c start $\"M365-Sphere$\" /D $\"$INSTDIR$\" $\"$INSTDIR\Start-M365-Sphere.bat$\""
!define MUI_FINISHPAGE_RUN_TEXT "Start ${APPNAME} and open the dashboard (first run: connect your tenant)"
!define MUI_FINISHPAGE_SHOWREADME "$INSTDIR\README.md"
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Open the README (setup guide)"
!define MUI_FINISHPAGE_LINK "Dashboard (after the server is running): http://localhost:8080"
!define MUI_FINISHPAGE_LINK_LOCATION "http://localhost:8080"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
Page custom StartupPageCreate StartupPageLeave
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Var NodeExe
Var NodeDir
Var StartWithWindows
Var StartWithWindowsCtrl

Function RefreshPath
  ; Rebuild PATH in this process from the registry so a freshly winget-installed
  ; node/npm is visible to us and to child processes.
  ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Control\Session Manager\Environment" "Path"
  ReadRegStr $1 HKCU "Environment" "Path"
  System::Call 'Kernel32::SetEnvironmentVariable(t "PATH", t "$0;$1")'
FunctionEnd

Function FindNode
  StrCpy $NodeExe ""
  SearchPath $NodeExe "node.exe"
  ${If} $NodeExe != ""
    ${GetParent} $NodeExe $NodeDir
  ${EndIf}
FunctionEnd

Function EnsureNode
  Call RefreshPath
  Call FindNode
  ${If} $NodeExe == ""
    MessageBox MB_YESNO|MB_ICONQUESTION \
      "Node.js was not found on this PC.$\r$\n$\r$\n${APPNAME} needs Node.js 22 LTS or newer. Install it now with winget (a UAC prompt may appear)?" \
      IDYES +2
      Abort "Node.js is required. Install Node.js 22 LTS and run this installer again."
    DetailPrint "Installing Node.js LTS via winget..."
    ExecWait 'winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements' $0
    Call RefreshPath
    Call FindNode
    ${If} $NodeExe == ""
      MessageBox MB_OK|MB_ICONSTOP \
        "Node.js is still not on PATH after the winget install.$\r$\n$\r$\nClose this installer, sign out and back in (or reboot) so PATH refreshes, then run the installer again. Or install Node.js 22 LTS manually from https://nodejs.org and retry."
      Abort "Node.js not found after winget install."
    ${EndIf}
  ${EndIf}
  DetailPrint "Found node at $NodeExe"
  ; Hard stop on Node < 22: npm install runs with --ignore-scripts and relies on
  ; the better-sqlite3 N-API prebuilt, which only exists for Node 22+.
  nsExec::ExecToStack '"$NodeExe" -e "process.exit(+process.versions.node.split(String.fromCharCode(46))[0] < 22 ? 1 : 0)"'
  Pop $0
  ${If} $0 != "0"
    MessageBox MB_OK|MB_ICONSTOP \
      "The installed Node.js is older than v22. ${APPNAME} requires Node.js 22 LTS or newer — the npm install during setup would fail without it.$\r$\n$\r$\nUpgrade from https://nodejs.org and run this installer again."
    Abort "Node.js 22 LTS or newer is required."
  ${EndIf}
FunctionEnd

Function StartupPageCreate
  !insertmacro MUI_HEADER_TEXT "Start with Windows" "Optionally start ${APPNAME} when you sign in."
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == "error"
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 24u "The app runs in a console window while you are signed in. It does not install a Windows service."
  ${NSD_CreateCheckbox} 0 30u 100% 12u "Start ${APPNAME} automatically when I sign in (shortcut in the Startup folder)"
  Pop $StartWithWindowsCtrl
  nsDialogs::Show
FunctionEnd

Function StartupPageLeave
  ${NSD_GetState} $StartWithWindowsCtrl $StartWithWindows
FunctionEnd

Section "Install"
  Call EnsureNode

  SetOutPath $INSTDIR
  File /r "stage\*"

  DetailPrint "Installing npm dependencies (this can take a few minutes)..."
  SetOutPath $INSTDIR
  ExecWait "$\"$SYSDIR\cmd.exe$\" /c $\"$\"$NodeDir\npm.cmd$\" install --omit=dev --no-audit --no-fund --ignore-scripts > $\"$INSTDIR\npm-install.log$\" 2>&1$\"" $0
  ${If} $0 != "0"
    MessageBox MB_OK|MB_ICONSTOP \
      "'npm install' failed (exit code $0).$\r$\n$\r$\nSee $INSTDIR\npm-install.log for details. Check your internet connection, then open a terminal in $INSTDIR and run:$\r$\n  npm install --omit=dev$\r$\n$\r$\nThe app files are installed; the setup is incomplete until npm install succeeds."
    Abort "npm install failed (exit $0)."
  ${EndIf}

  CreateDirectory "$SMPROGRAMS\M365-Sphere"
  CreateShortcut "$SMPROGRAMS\M365-Sphere\M365-Sphere.lnk" "$INSTDIR\Start-M365-Sphere.bat" "" "$INSTDIR\web\favicon.ico"
  CreateShortcut "$SMPROGRAMS\M365-Sphere\Uninstall M365-Sphere.lnk" "$INSTDIR\Uninstall.exe"

  ${If} $StartWithWindows == ${BST_CHECKED}
    CreateShortcut "$SMSTARTUP\M365-Sphere.lnk" "$INSTDIR\Start-M365-Sphere.bat" "" "$INSTDIR\web\favicon.ico"
  ${EndIf}

  ; Add/Remove Programs entry (HKCU — user-level install).
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\M365-Sphere" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\M365-Sphere" "DisplayVersion" "${APPVER}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\M365-Sphere" "Publisher" "${PUBLISHER}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\M365-Sphere" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\M365-Sphere" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\M365-Sphere" "QuietUninstallString" "$INSTDIR\Uninstall.exe /S"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\M365-Sphere" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\M365-Sphere" "NoRepair" 1

  WriteUninstaller "$INSTDIR\Uninstall.exe"
SectionEnd

Section "Uninstall"
  ; Shortcuts + startup entry
  Delete "$SMSTARTUP\M365-Sphere.lnk"
  Delete "$SMPROGRAMS\M365-Sphere\M365-Sphere.lnk"
  Delete "$SMPROGRAMS\M365-Sphere\Uninstall M365-Sphere.lnk"
  RMDir "$SMPROGRAMS\M365-Sphere"

  ; Application files (everything the installer put down, except user data).
  RMDir /r "$INSTDIR\lib"
  RMDir /r "$INSTDIR\web"
  RMDir /r "$INSTDIR\web-react"
  RMDir /r "$INSTDIR\ps"
  RMDir /r "$INSTDIR\scripts"
  RMDir /r "$INSTDIR\node_modules"
  Delete "$INSTDIR\server.js"
  Delete "$INSTDIR\package.json"
  Delete "$INSTDIR\package-lock.json"
  Delete "$INSTDIR\config.example.json"
  Delete "$INSTDIR\README.md"
  Delete "$INSTDIR\run-console.bat"
  Delete "$INSTDIR\install.bat"
  Delete "$INSTDIR\install.ps1"
  Delete "$INSTDIR\AGENTS.md"
  Delete "$INSTDIR\install-service.js"
  Delete "$INSTDIR\uninstall-service.js"
  Delete "$INSTDIR\Start-M365-Sphere.bat"
  Delete "$INSTDIR\npm-install.log"

  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON1 \
    "Keep your backup data and configuration?$\r$\n$\r$\nYes (recommended): keep $INSTDIR\data, pst-export, pst-import and config.json (your mailbox backups and Entra credentials).$\r$\nNo: delete EVERYTHING, including all backups." \
    IDYES keep_data
    RMDir /r "$INSTDIR\data"
    RMDir /r "$INSTDIR\pst-export"
    RMDir /r "$INSTDIR\pst-import"
    Delete "$INSTDIR\config.json"
  keep_data:

  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\M365-Sphere"
SectionEnd

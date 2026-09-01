!include "LogicLib.nsh"

; Asked on upgrade: replace the previous Desk, or keep a copy then install.
; The copy must happen in customInit. electron-builder uninstalls the old
; app before customInstall runs.
;
; Do not declare NSIS Var here. The uninstaller also includes this file and
; does not call these macros, so an unused Var is warning 6001, which
; electron-builder treats as an error. Write the copy path to PLUGINSDIR.

!macro customInit
  ${IfNot} ${UAC_IsInnerInstance}
    Push $R0
    Push $R1
    Push $R2
    StrCpy $R0 ""
    StrCpy $R1 ""
    StrCpy $R2 ""

    ReadRegStr $R0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${If} $R0 == ""
      ReadRegStr $R0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${EndIf}
    ReadRegStr $R1 HKCU "${UNINSTALL_REGISTRY_KEY}" DisplayVersion
    ${If} $R1 == ""
      ReadRegStr $R1 HKLM "${UNINSTALL_REGISTRY_KEY}" DisplayVersion
    ${EndIf}

    ${If} $R0 != ""
    ${AndIf} ${FileExists} "$R0\${APP_EXECUTABLE_FILENAME}"
      MessageBox MB_YESNOCANCEL|MB_ICONQUESTION \
        "Job Search Desk is already installed.$\r$\n$\r$\nYes = replace it with this version (recommended).$\r$\nNo = keep a copy of the old app, then install this version.$\r$\nCancel = quit." \
        /SD IDYES IDYES replace_desk IDNO keep_desk
        Pop $R2
        Pop $R1
        Pop $R0
        Quit
      keep_desk:
        ${If} $R1 == ""
          StrCpy $R2 "$LOCALAPPDATA\Job Search Desk previous"
        ${Else}
          StrCpy $R2 "$LOCALAPPDATA\Job Search Desk $R1"
        ${EndIf}
        ; CopyFiles with a wildcard skips subdirectories, which would leave a
        ; shortcut to an app missing resources\app.asar. robocopy /E copies the
        ; whole tree; exit codes below 8 are success. The destination and the
        ; exit code must not share a register.
        nsExec::ExecToLog 'robocopy "$R0" "$R2" /E /NFL /NDL /NJH /NJS /R:2 /W:2'
        Pop $R1
        ${If} $R1 < 8
          FileOpen $R1 "$PLUGINSDIR\desk-previous-copy.txt" w
          FileWrite $R1 "$R2"
          FileClose $R1
        ${EndIf}
      replace_desk:
    ${EndIf}

    Pop $R2
    Pop $R1
    Pop $R0
  ${EndIf}
!macroend

!macro customInstall
  Push $R0
  Push $R1
  ${If} ${FileExists} "$PLUGINSDIR\desk-previous-copy.txt"
    FileOpen $R0 "$PLUGINSDIR\desk-previous-copy.txt" r
    FileRead $R0 $R1
    FileClose $R0
    ${If} $R1 != ""
    ${AndIf} ${FileExists} "$R1\${APP_EXECUTABLE_FILENAME}"
      CreateShortCut "$SMPROGRAMS\Job Search Desk (previous).lnk" "$R1\${APP_EXECUTABLE_FILENAME}"
      DetailPrint "Kept the previous Desk at $R1"
    ${EndIf}
  ${EndIf}
  Pop $R1
  Pop $R0
!macroend

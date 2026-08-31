!include "LogicLib.nsh"

; Asked on upgrade: replace the previous Desk, or keep a copy then install.
; The copy must happen in customInit — electron-builder uninstalls the old
; app before customInstall runs.
Var KeepPreviousDesk
Var PreviousDeskCopy

!macro customInit
  StrCpy $KeepPreviousDesk "0"
  StrCpy $PreviousDeskCopy ""

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
      StrCpy $KeepPreviousDesk "1"
      ${If} $R1 == ""
        StrCpy $R2 "$LOCALAPPDATA\Job Search Desk previous"
      ${Else}
        StrCpy $R2 "$LOCALAPPDATA\Job Search Desk $R1"
      ${EndIf}
      CreateDirectory "$R2"
      CopyFiles /SILENT "$R0\*.*" "$R2"
      StrCpy $PreviousDeskCopy "$R2"
    replace_desk:
  ${EndIf}

  Pop $R2
  Pop $R1
  Pop $R0
!macroend

!macro customInstall
  ${If} $KeepPreviousDesk == "1"
  ${AndIf} $PreviousDeskCopy != ""
  ${AndIf} ${FileExists} "$PreviousDeskCopy\${APP_EXECUTABLE_FILENAME}"
    CreateShortCut "$SMPROGRAMS\Job Search Desk (previous).lnk" "$PreviousDeskCopy\${APP_EXECUTABLE_FILENAME}"
    DetailPrint "Kept the previous Desk at $PreviousDeskCopy"
  ${EndIf}
!macroend

; HiBuddy installer pre-kill (electron-builder nsis.include, runs inside .onInit
; BEFORE the CHECK_APP_RUNNING flow).
;
; Why: the desktop host runs as ELECTRON_RUN_AS_NODE — it is the SAME HiBuddy.exe
; image as the shell but WINDOWLESS. The installer's close-application flow can
; only close windowed instances, so an orphaned host (shell crashed or killed,
; host shutdown raced) keeps files under resources\host\ locked and the copy
; phase loops on "file in use". Killing the image tree deterministically clears
; every case; the installer itself (HiBuddy-Setup-*.exe) is a different image and
; is not affected.
;
; soffice.exe: libreoffice-kit ships its LibreOffice binaries INSIDE the install
; tree and dsh spawns them for document conversion — a leftover conversion locks
; resources\host\node_modules\@deepseek-ai\libreoffice-kit-win32-x64\... too.
!macro customInit
  nsExec::Exec 'taskkill /F /IM HiBuddy.exe /T'
  Pop $0
  nsExec::Exec 'taskkill /F /IM soffice.exe /T'
  Pop $0
  Sleep 1000
!macroend

; Same reasoning on the uninstall path: deleting resources\host\ while a
; windowless host (or soffice) still holds files fails the same way.
; The uninstaller's own image is "Uninstall HiBuddy.exe" — not matched.
!macro customUnInit
  nsExec::Exec 'taskkill /F /IM HiBuddy.exe /T'
  Pop $0
  nsExec::Exec 'taskkill /F /IM soffice.exe /T'
  Pop $0
  Sleep 1000
!macroend

;=============================================================================
; customCheckAppRunning REPLACES the template's CHECK_APP_RUNNING flow (both
; installSection.nsh and uninstaller.nsh call sites). Runs right before
; uninstallOldVersion + extraction — the exact point where the stock flow
; previously failed: it relied on PowerShell CIM (can hang) and tried a gentle
; close first, which for our shell triggers the in-app "task in progress"
; dialog so processes linger; files stayed locked and the 7z CopyFiles phase
; popped "HiBuddy cannot be closed" (~35%) mid-install, and clicking Retry
; fell through to the template's last-resort extract that ignores errors —
; silently producing a broken install tree.
;
; Here: force-kill the image tree up front, verify via tasklist|findstr (no
; PowerShell), 3 rounds max, and only then offer retry/cancel — Cancel QUITS
; instead of proceeding to the destructive extract. $CmdPath / $(appClosing) /
; $(appCannotBeClosed) are prepared by the template's CHECK_APP_RUNNING wrapper
; before this macro is inserted. The installer image (HiBuddy-Setup-*.exe) and
; the uninstaller image ("Uninstall HiBuddy.exe") never match the filter.
;=============================================================================
!macro customCheckAppRunning
  DetailPrint "$(appClosing)"
  StrCpy $R9 0
  checkAppLoop:
    IntOp $R9 $R9 + 1
    nsExec::Exec `"$CmdPath" /C taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}" /FI "USERNAME eq %USERNAME%"`
    Pop $0
    nsExec::Exec `"$CmdPath" /C taskkill /F /T /IM soffice.exe /FI "USERNAME eq %USERNAME%"`
    Pop $0
    Sleep 800
    nsExec::Exec `"$CmdPath" /C tasklist /FI "USERNAME eq %USERNAME%" /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /FO CSV /NH | "$SYSDIR\findstr.exe" /B /I /C:"\"${APP_EXECUTABLE_FILENAME}\""`
    Pop $R0
    ${If} $R0 != 0
      Goto checkAppDone
    ${EndIf}
    ${If} $R9 < 3
      Sleep 1000
      Goto checkAppLoop
    ${EndIf}
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY checkAppLoop
    Quit
  checkAppDone:
!macroend

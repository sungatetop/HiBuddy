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

; LibreTracks NSIS installer hooks.
;
; Tauri's bundled file-association code points every associated extension at the
; main app icon (`MAINBINARY.exe,0`). We want a DISTINCT icon per file type
; (.ltsession / .ltpkg / .ltset), so after Tauri has registered the associations
; we overwrite each ProgID's DefaultIcon to point at the per-type .ico we ship as
; a resource. The ProgID is the `name` field from each fileAssociations entry in
; tauri.conf.json (LibreTracks.Session / LibreTracks.SongPackage / LibreTracks.Set).
;
; SHELL_CONTEXT is set by Tauri to HKLM (all-users) or HKCU (per-user) to match
; the install mode, so writing under "Software\Classes" lands in the same hive
; Tauri used for the association itself.

!macro NSIS_HOOK_POSTINSTALL
  ; Point each file type at its own icon (the ,0 index selects the first/only
  ; icon in the .ico). Resources land under $INSTDIR mirroring their bundle path.
  WriteRegStr SHELL_CONTEXT "Software\Classes\LibreTracks.Session\DefaultIcon" "" "$INSTDIR\file-types\ltsession.ico,0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\LibreTracks.SongPackage\DefaultIcon" "" "$INSTDIR\file-types\ltpkg.ico,0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\LibreTracks.Set\DefaultIcon" "" "$INSTDIR\file-types\ltset.ico,0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\LibreTracks.Template\DefaultIcon" "" "$INSTDIR\file-types\lttemplate.ico,0"

  ; Tell the shell to drop its per-extension icon cache so the new icons show up
  ; without a logoff/reboot (SHCNE_ASSOCCHANGED).
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'

  ; Allow LibreTracks Remote (phone control over the LAN) through Windows
  ; Firewall so users don't have to accept a UAC/firewall prompt or run a
  ; PowerShell command by hand. This is a per-PROGRAM inbound rule (not a raw
  ; open port): it only permits the LibreTracks binary to accept inbound
  ; connections, only while the app is running, and survives us changing the
  ; remote port later. The installer already runs elevated, so netsh succeeds
  ; without a further prompt. netsh is present on every supported Windows.
  ;
  ; Delete any prior rule of the same name first so upgrades/repairs don't
  ; stack duplicate rules, then (re)create it for all profiles.
  nsExec::Exec 'netsh advfirewall firewall delete rule name="LibreTracks Remote"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="LibreTracks Remote" dir=in action=allow program="$INSTDIR\LibreTracks.exe" enable=yes profile=any description="Permite conectar la app LibreTracks Remote desde el movil en la red local."'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; Tauri's APP_UNASSOCIATE removes the ProgIDs; just refresh the icon cache so
  ; stale custom icons don't linger in Explorer.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'

  ; Remove the firewall rule we added at install time so it doesn't linger
  ; after the app is gone.
  nsExec::Exec 'netsh advfirewall firewall delete rule name="LibreTracks Remote"'
!macroend

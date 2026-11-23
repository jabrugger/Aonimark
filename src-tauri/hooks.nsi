; NSIS installer hooks, included by the bundler template
; (crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi) and inserted from
; `!ifmacrodef NSIS_HOOK_POSTINSTALL` / `!ifmacrodef NSIS_HOOK_POSTUNINSTALL`.
; There is no underscore between POST and INSTALL, and `!ifmacrodef` is a
; compile-time conditional, so any other spelling is skipped in silence.
;
; Everything a hook does here has to be something the template does not already
; do. The template creates the desktop shortcut from the finish-page checkbox
; (and automatically for silent and passive installs), registers every extension
; in `bundle.fileAssociations` via APP_ASSOCIATE, and writes every
; key through SHCTX so it follows `installMode`. Duplicating any of that from
; here overrides a choice the user was already given.

; The ProgID the bundler template registers the Markdown extensions under. It is
; `bundle.fileAssociations[].name` from tauri.conf.json verbatim -- the template
; expands `{{or association.name ext}}` into the APP_ASSOCIATE FILECLASS
; argument -- and nothing in the build exports it as a define, so it is repeated
; here. scripts/release.workflows.test.ts fails if the two ever disagree.
!define AONIMARK_PROGID "Markdown File"

; Make Aonimark selectable from Explorer's "Open with" list (#756).
;
; APP_ASSOCIATE writes one thing: `.md`'s default value, meaning "Aonimark is the
; handler for .md". Since Windows 8 that value is not the handler -- an existing
; `.md\UserChoice`, written by the shell when the user or another installer last
; picked something, wins over it, and no installer may write UserChoice itself.
; So on a machine that already had a Markdown handler the association silently
; loses, which is the whole of what the reporter sees.
;
; The way back is the Open With dialog, and that dialog does not enumerate
; default-value handlers. It reads `OpenWithProgids` on the extension and
; `Software\Classes\Applications\<exe>` entries carrying a matching
; SupportedTypes. The template writes neither, so Aonimark appears in that list
; only while it already is the default -- exactly when it is not needed. These
; four keys are what put it there in the case that matters.
;
; SupportedTypes is what filters the Applications entry into the list for a
; given extension; FriendlyAppName is the label, without which the row reads
; "Aonimark.exe".
!macro AONIMARK_REGISTER_OPEN_WITH
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe" "FriendlyAppName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".md" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".markdown" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".mdown" ""
  WriteRegStr SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\SupportedTypes" ".mkd" ""
  WriteRegStr SHCTX "Software\Classes\.md\OpenWithProgids" "${AONIMARK_PROGID}" ""
  WriteRegStr SHCTX "Software\Classes\.markdown\OpenWithProgids" "${AONIMARK_PROGID}" ""
  WriteRegStr SHCTX "Software\Classes\.mdown\OpenWithProgids" "${AONIMARK_PROGID}" ""
  WriteRegStr SHCTX "Software\Classes\.mkd\OpenWithProgids" "${AONIMARK_PROGID}" ""
!macroend

; And hand them back. The Applications key is addressed by executable *name*,
; not path, so a portable copy the user pointed Explorer at by hand owns the
; same key -- deleting it outright would take that association down with this
; install. Matching the command against $INSTDIR first is what the template
; already does for deep links, and it is the same rule #255 asked for.
;
; The OpenWithProgids values name ${AONIMARK_PROGID}, a ProgID APP_UNASSOCIATE
; has just deleted, so they point at nothing by the time this runs either way.
!macro AONIMARK_UNREGISTER_OPEN_WITH
  Push $0
  ReadRegStr $0 SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe\shell\open\command" ""
  ${If} $0 == "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
    DeleteRegKey SHCTX "Software\Classes\Applications\${MAINBINARYNAME}.exe"
  ${EndIf}
  Pop $0
  DeleteRegValue SHCTX "Software\Classes\.md\OpenWithProgids" "${AONIMARK_PROGID}"
  DeleteRegValue SHCTX "Software\Classes\.markdown\OpenWithProgids" "${AONIMARK_PROGID}"
  DeleteRegValue SHCTX "Software\Classes\.mdown\OpenWithProgids" "${AONIMARK_PROGID}"
  DeleteRegValue SHCTX "Software\Classes\.mkd\OpenWithProgids" "${AONIMARK_PROGID}"
!macroend

; Give the Markdown extensions a document icon of their own (#975).
;
; APP_ASSOCIATE points the ProgID's DefaultIcon at `Aonimark.exe,0`, so Explorer
; draws every Markdown file with the app icon. The bundler embeds one icon in
; the executable and has no per-association icon option, so the file icon is
; shipped next to the executable and DefaultIcon is pointed at it.
;
; `${__FILEDIR__}` has to be read here, at the top level: inside a macro body it
; would expand where the macro is inserted, which is the bundler's script.
!define AONIMARK_FILE_ICON_SOURCE "${__FILEDIR__}\icons\markdown-file.ico"
!define AONIMARK_FILE_ICON "$INSTDIR\markdown-file.ico"

!macro AONIMARK_REGISTER_FILE_ICON
  File "/oname=${AONIMARK_FILE_ICON}" "${AONIMARK_FILE_ICON_SOURCE}"
  WriteRegStr SHCTX "Software\Classes\${AONIMARK_PROGID}\DefaultIcon" "" "${AONIMARK_FILE_ICON}"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro AONIMARK_REGISTER_OPEN_WITH
  !insertmacro AONIMARK_REGISTER_FILE_ICON

  ; The template registers the file associations through FileAssociation.nsh but
  ; never inserts that header's own UPDATEFILEASSOC, so Explorer can go on
  ; serving the previous handler and icon for `.md` until the next logon.
  ; Broadcasting SHCNE_ASSOCCHANGED (0x08000000) with SHCNF_IDLIST (0) and two
  ; null items is the documented way to tell it to re-read them. It covers the
  ; keys above too.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'

!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro AONIMARK_UNREGISTER_OPEN_WITH

  ; APP_UNASSOCIATE already removed the ProgID with its DefaultIcon. The template
  ; tried to remove $INSTDIR before this hook ran, which fails while the icon is
  ; still in it, so retry once the icon is gone.
  Delete "${AONIMARK_FILE_ICON}"
  RMDir "$INSTDIR"

  ; And again once APP_UNASSOCIATE has handed `.md` back.
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

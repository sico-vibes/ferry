# Lane U round 4: NSIS compile error (no commit)

Progress: the packaged app is down to **118 files** (from 12,937) and `resources/cli` to 6 files. Now makensis fails:
```
Error in macro _StdU_TestParameter on macroline 2
Error in macro _isUpdated on macroline 1
Error in macro _If on macroline 9
!include: error in script: "apps/desktop/nsis/installer.nsh" on line 51
```
`${isUpdated}` (electron-builder's macro built on StdUtils `${StdUtils.TestParameter}`) isn't usable at that point. It's probably used in `customInit` or a page/leave callback before electron-builder's StdUtils include, in a scope where the macro's dependencies aren't defined, or in the uninstaller pass. Check how electron-builder's own `installer.nsi` and `installSection.nsh` use `${isUpdated}`, and where custom macros (`customInit`, `customWelcomePage`, `customInstall`) are inserted relative to the StdUtils include. Use it only where it's valid, or fall back to parsing `--updated` from `${GetParameters}` (as you did for `/TEST_UPDATED`), which works anywhere. Keep both passes (installer and uninstaller) free of warnings: warnings are errors in this build. Typecheck, lint and prettier; no commit. The orchestrator rebuilds.

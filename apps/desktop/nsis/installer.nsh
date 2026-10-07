!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "WinMessages.nsh"
!include "FileFunc.nsh"

!macro FerryDeleteUserData
  SetShellVarContext current
  RMDir /r "$APPDATA\@ferry\desktop"
  RMDir /r "$APPDATA\Ferry"
  ; The desktop/CLI engine lives under Ferry\engine and is removed with Ferry.
!macroend

!ifndef BUILD_UNINSTALLER
Var AddToPathCheckbox
Var ExplorerCheckbox
Var ForceAddToPath
Var AddToPathState
Var ExplorerState
Var FerryIsUpdated
Var FerryInstallerParams
Var FerryInstalledVersion
Var FerryInstalledLocation
Var FerryUpdateRadio
Var FerryReinstallRadio
Var FerryCleanRadio
Var FerryCleanReinstall

!macro customInit
  StrCpy $FerryCleanReinstall 0
  ReadRegStr $FerryInstalledVersion HKCU "${UNINSTALL_REGISTRY_KEY}" "DisplayVersion"
  ; electron-builder keeps InstallLocation under INSTALL_REGISTRY_KEY, not the uninstall entry.
  ReadRegStr $FerryInstalledLocation HKCU "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  StrCpy $FerryIsUpdated 0
  StrCpy $ForceAddToPath 0
  ${GetParameters} $FerryInstallerParams
  ReadRegDWORD $AddToPathState HKCU "Software\Ferry" "AddToPath"
  ReadRegDWORD $ExplorerState HKCU "Software\Ferry" "ExplorerMenu"
  ClearErrors
  ${GetOptions} $FerryInstallerParams "/ADD_TO_PATH" $1
  ${IfNot} ${Errors}
    StrCpy $ForceAddToPath 1
  ${EndIf}
  ClearErrors
  ${GetOptions} $FerryInstallerParams "/TEST_OPTIONS" $1
  ${IfNot} ${Errors}
    StrCpy $0 ${BST_CHECKED}
    StrCpy $1 ${BST_CHECKED}
    Call FerryStoreInstallOptions
  ${EndIf}
  ClearErrors
  ${GetOptions} $FerryInstallerParams "--updated" $1
  ${IfNot} ${Errors}
    StrCpy $FerryIsUpdated 1
  ${EndIf}
  ClearErrors
  ${GetOptions} $FerryInstallerParams "/UPDATED" $1
  ${IfNot} ${Errors}
    StrCpy $FerryIsUpdated 1
  ${EndIf}
  ClearErrors
  ${GetOptions} $FerryInstallerParams "/TEST_UPDATED" $1
  ${IfNot} ${Errors}
    StrCpy $FerryIsUpdated 1
  ${EndIf}
  ${If} $FerryIsUpdated == 1
    SetSilent silent
  ${EndIf}
!macroend

!macro customWelcomePage
  Page custom FerryExistingInstallPage FerryExistingInstallPageLeave
  Page custom FerryInstallOptionsPage FerryInstallOptionsPageLeave
!macroend

Function FerryExistingInstallPage
  IfSilent ferry_existing_skip
  ${If} $FerryIsUpdated == 1
    Abort
  ${EndIf}
  ${If} $FerryInstalledVersion == ""
    Abort
  ${EndIf}
  ${If} $FerryInstalledLocation == ""
    Abort
  ${EndIf}
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 24u "Ferry $FerryInstalledVersion is already installed."
  Pop $0
  ${NSD_CreateRadioButton} 0 34u 100% 14u "Update (keep my data)"
  Pop $FerryUpdateRadio
  ${NSD_CreateRadioButton} 0 56u 100% 14u "Reinstall (keep my data)"
  Pop $FerryReinstallRadio
  ${NSD_CreateRadioButton} 0 78u 100% 28u "Clean reinstall (delete chats, keys and settings)"
  Pop $FerryCleanRadio
  ${NSD_SetState} $FerryUpdateRadio ${BST_CHECKED}
  nsDialogs::Show
  Return
ferry_existing_skip:
  Abort
FunctionEnd

Function FerryExistingInstallPageLeave
  ${NSD_GetState} $FerryCleanRadio $FerryCleanReinstall
FunctionEnd

Function FerryInstallOptionsPage
  ${If} $FerryIsUpdated == 1
    Abort
  ${EndIf}
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 24u "Choose optional Windows integrations."
  Pop $0
  ${NSD_CreateCheckbox} 0 34u 100% 14u "Add ferry CLI to my user PATH"
  Pop $AddToPathCheckbox
  ${If} $AddToPathState == 1
    ${NSD_SetState} $AddToPathCheckbox ${BST_CHECKED}
  ${Else}
    ${NSD_SetState} $AddToPathCheckbox ${BST_UNCHECKED}
  ${EndIf}
  ${NSD_CreateCheckbox} 0 56u 100% 14u "Add Open in Ferry to folder menus"
  Pop $ExplorerCheckbox
  ${If} $ExplorerState == 1
    ${NSD_SetState} $ExplorerCheckbox ${BST_CHECKED}
  ${Else}
    ${NSD_SetState} $ExplorerCheckbox ${BST_UNCHECKED}
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function FerryStoreInstallOptions
  StrCpy $AddToPathState $0
  StrCpy $ExplorerState $1
FunctionEnd

Function FerryInstallOptionsPageLeave
  ${NSD_GetState} $AddToPathCheckbox $0
  ${NSD_GetState} $ExplorerCheckbox $1
  Call FerryStoreInstallOptions
FunctionEnd

Function FerryPathContainsEntry
  StrCpy $0 0
  StrCpy $4 ""
  StrCpy $5 0
ferry_path_contains_loop:
  StrCpy $6 $1 1 $5
  ${If} $6 == ";"
    StrCmp $4 $3 ferry_path_contains_found
    StrCpy $4 ""
  ${ElseIf} $6 == ""
    StrCmp $4 $3 ferry_path_contains_found
    Return
  ${Else}
    StrCpy $4 "$4$6"
  ${EndIf}
  IntOp $5 $5 + 1
  Goto ferry_path_contains_loop
ferry_path_contains_found:
  StrCpy $0 1
FunctionEnd

Function FerryRemovePathEntry
  StrCpy $7 ""
  StrCpy $4 ""
  StrCpy $5 0
ferry_path_remove_loop:
  StrCpy $6 $1 1 $5
  ${If} $6 == ";"
    StrCmp $4 $3 ferry_path_remove_skip
    Goto ferry_path_remove_append
  ${ElseIf} $6 == ""
    StrCmp $4 $3 ferry_path_remove_done
    Goto ferry_path_remove_append_final
  ${Else}
    StrCpy $4 "$4$6"
    IntOp $5 $5 + 1
    Goto ferry_path_remove_loop
  ${EndIf}
ferry_path_remove_skip:
  StrCpy $4 ""
  IntOp $5 $5 + 1
  Goto ferry_path_remove_loop
ferry_path_remove_append:
  StrCmp $4 "" ferry_path_remove_next
  StrCmp $7 "" 0 ferry_path_remove_add_separator
  StrCpy $7 $4
  Goto ferry_path_remove_next
ferry_path_remove_add_separator:
  StrCpy $7 "$7;$4"
ferry_path_remove_next:
  StrCpy $4 ""
  IntOp $5 $5 + 1
  Goto ferry_path_remove_loop
ferry_path_remove_append_final:
  StrCmp $4 "" ferry_path_remove_done
  StrCmp $7 "" 0 ferry_path_remove_add_final_separator
  StrCpy $7 $4
  Goto ferry_path_remove_done
ferry_path_remove_add_final_separator:
  StrCpy $7 "$7;$4"
ferry_path_remove_done:
  StrCpy $1 $7
FunctionEnd

!macro customInstall
  ${If} $FerryCleanReinstall == ${BST_CHECKED}
    !insertmacro FerryDeleteUserData
  ${EndIf}
  ${If} $ForceAddToPath == 1
    StrCpy $AddToPathState ${BST_CHECKED}
  ${EndIf}
  ${If} $AddToPathState == ${BST_CHECKED}
    WriteRegDWORD HKCU "Software\Ferry" "AddToPath" 1
    ReadRegStr $1 HKCU "Environment" "Path"
    StrCpy $3 "$INSTDIR\resources\cli"
    Call FerryPathContainsEntry
    ${If} $0 == 0
      ${If} $1 == ""
        StrCpy $1 $3
      ${Else}
        StrCpy $1 "$1;$3"
      ${EndIf}
      WriteRegExpandStr HKCU "Environment" "Path" "$1"
    ${EndIf}
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=2000
  ${Else}
    ReadRegStr $1 HKCU "Environment" "Path"
    StrCpy $3 "$INSTDIR\resources\cli"
    Call FerryRemovePathEntry
    WriteRegExpandStr HKCU "Environment" "Path" "$1"
    DeleteRegValue HKCU "Software\Ferry" "AddToPath"
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=2000
  ${EndIf}
  ${If} $ExplorerState == ${BST_CHECKED}
    WriteRegStr HKCU "Software\Classes\Directory\shell\Ferry" "" "Open in Ferry"
    WriteRegStr HKCU "Software\Classes\Directory\shell\Ferry\command" "" "$\"$INSTDIR\Ferry.exe$\" --open-folder $\"%1$\""
    WriteRegDWORD HKCU "Software\Ferry" "ExplorerMenu" 1
  ${Else}
    DeleteRegValue HKCU "Software\Ferry" "ExplorerMenu"
  ${EndIf}
!macroend
!endif

!ifdef BUILD_UNINSTALLER
Var DeleteUserDataCheckbox
Var ForceDeleteUserData
Var UnFerryIsUpdated

!macro customUnInit
  StrCpy $DeleteUserDataCheckbox 0
  StrCpy $ForceDeleteUserData 0
  StrCpy $UnFerryIsUpdated 0
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "--updated" $1
  ${IfNot} ${Errors}
    StrCpy $UnFerryIsUpdated 1
  ${EndIf}
  ClearErrors
  ${GetOptions} $0 "/REMOVE_DATA" $1
  ${IfNot} ${Errors}
    StrCpy $ForceDeleteUserData 1
  ${EndIf}
!macroend

!macro customUnWelcomePage
  UninstPage custom un.DeleteUserDataPage
!macroend

Function un.DeleteUserDataPage
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 24u "Your local settings and workspace data are kept unless you choose to delete them."
  Pop $0
  ${NSD_CreateCheckbox} 0 34u 100% 14u "Delete Ferry user data from this PC"
  Pop $DeleteUserDataCheckbox
  ${NSD_SetState} $DeleteUserDataCheckbox ${BST_UNCHECKED}
  nsDialogs::Show
FunctionEnd

!macro customUnInstall
  ${If} $UnFerryIsUpdated != 1
    ReadRegDWORD $1 HKCU "Software\Ferry" "AddToPath"
    ${If} $1 == 1
      ReadRegStr $2 HKCU "Environment" "Path"
      StrCpy $3 "$INSTDIR\resources\cli"
      Call un.RemoveFerryPathEntry
      System::Call 'kernel32::GetLongPathName(t r3, t .r4, i ${NSIS_MAX_STRLEN}) i .r5'
      ${If} $5 > 0
        StrCpy $3 $4
        Call un.RemoveFerryPathEntry
      ${EndIf}
      System::Call 'kernel32::GetShortPathName(t r3, t .r4, i ${NSIS_MAX_STRLEN}) i .r5'
      ${If} $5 > 0
        StrCpy $3 $4
        Call un.RemoveFerryPathEntry
      ${EndIf}
      WriteRegExpandStr HKCU "Environment" "Path" "$2"
      SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=2000
    ${EndIf}
    ReadRegDWORD $1 HKCU "Software\Ferry" "ExplorerMenu"
    ${If} $1 == 1
      DeleteRegKey HKCU "Software\Classes\Directory\shell\Ferry"
    ${EndIf}
    DeleteRegKey HKCU "Software\Ferry"
    SetShellVarContext current
    ${NSD_GetState} $DeleteUserDataCheckbox $0
    ${If} $ForceDeleteUserData == 1
      StrCpy $0 ${BST_CHECKED}
    ${EndIf}
    ${If} $0 == ${BST_CHECKED}
      !insertmacro FerryDeleteUserData
    ${EndIf}
    ${EndIf}
!macroend

Function un.RemoveFerryPathEntry
  StrCpy $7 ""
  StrCpy $4 ""
  StrCpy $5 0
un_ferry_path_remove_loop:
  StrCpy $6 $2 1 $5
  ${If} $6 == ";"
    StrCmp $4 $3 un_ferry_path_remove_skip
    Goto un_ferry_path_remove_append
  ${ElseIf} $6 == ""
    StrCmp $4 $3 un_ferry_path_remove_done
    Goto un_ferry_path_remove_append_final
  ${Else}
    StrCpy $4 "$4$6"
    IntOp $5 $5 + 1
    Goto un_ferry_path_remove_loop
  ${EndIf}
un_ferry_path_remove_skip:
  StrCpy $4 ""
  IntOp $5 $5 + 1
  Goto un_ferry_path_remove_loop
un_ferry_path_remove_append:
  StrCmp $4 "" un_ferry_path_remove_next
  StrCmp $7 "" 0 un_ferry_path_remove_add_separator
  StrCpy $7 $4
  Goto un_ferry_path_remove_next
un_ferry_path_remove_add_separator:
  StrCpy $7 "$7;$4"
un_ferry_path_remove_next:
  StrCpy $4 ""
  IntOp $5 $5 + 1
  Goto un_ferry_path_remove_loop
un_ferry_path_remove_append_final:
  StrCmp $4 "" un_ferry_path_remove_done
  StrCmp $7 "" 0 un_ferry_path_remove_add_final_separator
  StrCpy $7 $4
  Goto un_ferry_path_remove_done
un_ferry_path_remove_add_final_separator:
  StrCpy $7 "$7;$4"
un_ferry_path_remove_done:
  StrCpy $2 $7
FunctionEnd
!endif

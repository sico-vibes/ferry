!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "WinMessages.nsh"
!include "StrFunc.nsh"
!include "FileFunc.nsh"

!ifndef BUILD_UNINSTALLER
Var AddToPathCheckbox
Var ExplorerCheckbox
Var ForceAddToPath

!macro customInit
  StrCpy $ForceAddToPath 0
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/ADD_TO_PATH" $1
  ${IfNot} ${Errors}
    StrCpy $ForceAddToPath 1
  ${EndIf}
!macroend

!macro customWelcomePage
  Page custom FerryInstallOptionsPage
!macroend

Function FerryInstallOptionsPage
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 24u "Choose optional Windows integrations."
  Pop $0
  ${NSD_CreateCheckbox} 0 34u 100% 14u "Add ferry CLI to my user PATH"
  Pop $AddToPathCheckbox
  ${NSD_CreateCheckbox} 0 56u 100% 14u "Add Open in Ferry to folder menus"
  Pop $ExplorerCheckbox
  nsDialogs::Show
FunctionEnd

!macro customInstall
  ${NSD_GetState} $AddToPathCheckbox $0
  ${If} $ForceAddToPath == 1
    StrCpy $0 ${BST_CHECKED}
  ${EndIf}
  ${If} $0 == ${BST_CHECKED}
    WriteRegDWORD HKCU "Software\Ferry" "AddToPath" 1
    ReadRegStr $1 HKCU "Environment" "Path"
    ${If} $1 == ""
      WriteRegExpandStr HKCU "Environment" "Path" "$INSTDIR\resources\cli"
    ${Else}
      WriteRegExpandStr HKCU "Environment" "Path" "$1;$INSTDIR\resources\cli"
    ${EndIf}
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment"
  ${Else}
    DeleteRegValue HKCU "Software\Ferry" "AddToPath"
  ${EndIf}
  ${NSD_GetState} $ExplorerCheckbox $0
  ${If} $0 == ${BST_CHECKED}
    WriteRegStr HKCU "Software\Classes\Directory\shell\Ferry" "" "Open in Ferry"
    WriteRegStr HKCU "Software\Classes\Directory\shell\Ferry\command" "" "$\"$INSTDIR\Ferry.exe$\" --open-folder $\"%1$\""
    WriteRegDWORD HKCU "Software\Ferry" "ExplorerMenu" 1
  ${Else}
    DeleteRegValue HKCU "Software\Ferry" "ExplorerMenu"
  ${EndIf}
!macroend
!endif

!ifdef BUILD_UNINSTALLER
${UnStrRep}
Var DeleteUserDataCheckbox
Var ForceDeleteUserData

!macro customUnInit
  StrCpy $DeleteUserDataCheckbox 0
  StrCpy $ForceDeleteUserData 0
  ${GetParameters} $0
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
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment"
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
    RMDir /r "$APPDATA\@ferry\desktop"
    RMDir /r "$APPDATA\Ferry"
  ${EndIf}
!macroend

Function un.RemoveFerryPathEntry
  ${UnStrRep} $2 "$2" ";$3" ""
  ${UnStrRep} $2 "$2" "$3;" ""
  ${UnStrRep} $2 "$2" "$3" ""
FunctionEnd
!endif

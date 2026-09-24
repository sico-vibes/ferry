!include "LogicLib.nsh"
!include "nsDialogs.nsh"

Var DeleteUserDataCheckbox

!macro customUnWelcomePage
  UninstPage custom un.DeleteUserDataPage
!macroend

Function un.DeleteUserDataPage
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u "Your local settings and saved demo state are kept unless you choose to delete them."
  Pop $0
  ${NSD_CreateCheckbox} 0 34u 100% 14u "Delete Ferry user data from this PC"
  Pop $DeleteUserDataCheckbox
  ${NSD_SetState} $DeleteUserDataCheckbox ${BST_UNCHECKED}
  nsDialogs::Show
FunctionEnd

!macro customUnInstall
  ${NSD_GetState} $DeleteUserDataCheckbox $0
  ${If} $0 == ${BST_CHECKED}
    RMDir /r "$APPDATA\Ferry"
  ${EndIf}
!macroend

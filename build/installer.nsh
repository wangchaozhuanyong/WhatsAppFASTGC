!macro preInit
  ; 默认安装到 D 盘，用户仍可在安装向导中改到其它盘；若机器无 D 盘则使用安装器默认路径。
  IfFileExists "D:\" 0 doneFastgcDefaultInstallDir
  StrCpy $INSTDIR "D:\FastGC WhatsApp"

  doneFastgcDefaultInstallDir:
!macroend

!macro customInstall
  ; 清理历史快捷方式，仅保留一个桌面入口，避免安装后出现多个图标。
  Delete "$DESKTOP\FastGC聊天系统.lnk"
  Delete "$DESKTOP\FastGC WhatsApp 客服端.lnk"
  Delete "$DESKTOP\FastGC WhatsApp.lnk"
  Delete "$SMPROGRAMS\FastGC聊天系统.lnk"
  Delete "$SMPROGRAMS\FastGC WhatsApp 客服端.lnk"
  Delete "$SMPROGRAMS\FastGC WhatsApp.lnk"
  CreateShortcut "$DESKTOP\FastGC WhatsApp.lnk" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0
!macroend

!macro customUnInstall
  ; electron-builder 升级会静默运行旧卸载器并传 --updated。
  ; 升级和所有静默卸载均保留数据，不能让隐藏的询问框默认选“是”。
  ${if} ${isUpdated}
    Goto doneDeleteFastgcData
  ${endif}
  IfSilent doneDeleteFastgcData 0
  MessageBox MB_ICONQUESTION|MB_YESNO|MB_DEFBUTTON2 "是否同时删除 FastGC WhatsApp 的本地数据和缓存？$\r$\n$\r$\n选择“是”会删除默认 AppData 数据、安装器配置，以及应用内设置过的数据目录。" /SD IDNO IDNO doneDeleteFastgcData

  DetailPrint "Deleting FastGC WhatsApp local data..."

  RMDir /r "$APPDATA\FastGC WhatsApp"
  RMDir /r "$APPDATA\fastgc-whatsapp-shell"
  RMDir /r "$LOCALAPPDATA\FastGC WhatsApp"
  RMDir /r "$LOCALAPPDATA\fastgc-whatsapp-shell"

  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -Command "$$cfg = Join-Path $$env:APPDATA ''fastgc_bootstrap_config.json''; if (Test-Path $$cfg) { try { $$j = Get-Content -Raw -LiteralPath $$cfg | ConvertFrom-Json; $$root = [string]$$j.dataRoot; if ($$root) { $$userData = Join-Path $$root ''fastgc-whatsapp-userdata''; if (Test-Path -LiteralPath $$userData) { Remove-Item -LiteralPath $$userData -Recurse -Force -ErrorAction SilentlyContinue } } } catch {} }; Remove-Item -LiteralPath $$cfg -Force -ErrorAction SilentlyContinue"'

  doneDeleteFastgcData:
!macroend

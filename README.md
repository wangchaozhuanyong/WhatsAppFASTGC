# FastGC WhatsApp

基于 Electron 的 Windows 多账号 WhatsApp 客服工作台。当前版本：**1.0.38**。

## 安装

从 [GitHub Releases](https://github.com/wangchaozhuanyong/WhatsAppFASTGC/releases/latest) 下载 `FastGC WhatsApp-Setup-1.0.38.exe`，安装后使用桌面 FastGC WhatsApp 快捷方式。

安装包不包含账号、聊天记录、管理员密码或翻译密钥。升级保留本机数据；首次使用需要关联自己的 WhatsApp 账号。

## 功能

- 多账号独立会话、席位切换和全局会话汇聚。
- 独立的中文、英文话术库，支持编辑、排序、填入和双击发送。原有话术迁入英文库。
- 接收与发送翻译开关、缓存优先，以及 Google Cloud Translation Basic v2 NMT。
- 业务数据 SQLite 持久化、可校验的数据目录迁移、访问控制和诊断。
- 会员资料功能已移除；联系人号码采集仍保留。

Google 官方翻译需在“管理与配置 → 官方翻译”中自行填写项目 ID 与 API Key，并启用对应 Google 项目计费。本机近31天45万字符保护上限不代表 Google 免费额度余额；同一计费账号的其他服务使用量也需自行核对。密钥使用 Windows 系统加密存储，不应提交至仓库。

## 开发和验证

Windows 10/11 x64、Node.js 22/24、npm 10+。

```sh
npm ci
npm run ci
node scripts/verify-shutdown-guard.cjs
npm start
```

正式安装包使用预编译的 JSX、本地 CSS 和 CSP，不在启动时运行 Babel。未配置更新源时不加载更新组件；已配置时延后初始化。

1.0.36 将宿主设置与中英话术迁入已有 SQLite：首次升级读取旧界面存储并在事务内迁移，保留 SQLite 中已有值（包括有效空值），成功后标记完成；后续启动不打开宿主 DOMStorage。WhatsApp 页面自己的会话存储不经过此适配层。写盘失败会提示，内存不会提前更新为未保存的值。

Windows 退出先写回缓存、检查点并关闭 SQLite、刷新会话 Cookie，然后正常退出。存储完成后才启动持有本进程句柄的隐藏辅助进程；若 Chromium 原生退出超过8秒，辅助进程仅回收该进程，并记录 `shutdown-native-timeout`。这是一项退出保护，不代表上游 Chromium 原生问题已被消除。

显式 `app.quit()` 同样进入保存流程，避免跳过 Cookie 刷新。

1.0.37：取消重复同步写盘与重复迁移；配置和翻译缓存使用带 fsync、失败回滚的事务临时文件，失败不返回成功，不保留备份；缓存保存失败保留重试状态。关闭时先取消翻译请求再最终保存，避免关闭后仍有结果回写。损坏的权限/数据目录配置会显示错误并保留限制；迁移拒绝链接目标、清理自身残留，并以固定大小缓冲区校验大文件。

本版同时补齐功能反馈：内容、号码、链接和席位先确认保存再更新界面，保存失败保留编辑内容；号码库打开时不再写入空列表，导入时同时去除已有和同批重复号码；话术导入校验格式并提示错误；自定义链接校验 HTTP/HTTPS 网址；管理员配置等待保存结果，复制操作等待真实结果。

`npm run ci` 包含17组故障回归及独立媒体权限回归。`scripts/verify-functional-ui.mjs` 可对隔离 Electron 测试实例复查实际 React 组件和本地接口，须明确设置 `FASTGC_FUNCTIONAL_PROFILE`（目录名以 `functional-profile-` 开头）及仅监听回环地址的 `FASTGC_FUNCTIONAL_CDP_PORT`。测试会改动该隔离目录的测试话术、号码、权限和设置，请勿指向正式用户目录；发送和复制使用模拟回调，不向联系人发送消息。外部 WhatsApp 附件、音视频和真实多账号长期运行仍需独立验收。

1.0.38 修复麦克风、摄像头始终被拒绝的问题：仅 WhatsApp 主页面在实际使用时可申请，用户允许后仅当前席位和当前页面获得所选设备权限，取消、跨站、其他席位及页面重新加载均不继承授权。没有默认录音、拍照或拨号。增加桌面实际运行环境诊断、存储写入计数和同值写入去重；可恢复原有 Windows 加密翻译配置并保守保留本地用量。验收必须连接真正由桌面启动的实例，明确区分工具执行环境与桌面实例；相同的目录文字不保证两种执行环境看到的文件状态相同。可信安装包签名仍需要发布者提供有效代码签名证书或签名服务。

翻译发送与话术发送在等待完成后重新确认原聊天，切换聊天时停止发送；话术执行失败会显示提示，不再静默结束。回归覆盖翻译等待中切换、写入后发送前切换、无有效聊天身份以及正常发送分支。

## 打包

```sh
npm run build:pack-bundles
npx electron-builder --win nsis --publish never --config.forceCodeSigning=false --config.win.signAndEditExecutable=false
```

以上命令生成未签名安装包。本仓库 Release 使用本地验收后的安装包，并发布 SHA256；自动重建结果不得覆盖已验收资产。签名构建见 [签名说明](docs/SECURITY_SIGNING.md)。

生产依赖扫描、有限时长的多席位观察及真实发送结果，以对应版本 Release 中的验收说明为准。有限测试不能保证任意数量账号的长期稳定性。


1.0.35 补充：仅初始化实际使用的浏览器会话；退出前刷新存储并关闭连接，刷新和连接等待均有上限；合并 WhatsApp 与翻译请求头监听，避免互相覆盖；构建依赖覆盖到 global-agent 4.1.3，移除 sprintf-js 告警链。

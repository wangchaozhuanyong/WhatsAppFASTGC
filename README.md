# FastGC WhatsApp

基于 Electron 的 Windows 多账号 WhatsApp 客服工作台。当前版本：**1.0.36**。

## 安装

从 [GitHub Releases](https://github.com/wangchaozhuanyong/WhatsAppFASTGC/releases/latest) 下载 `FastGC WhatsApp-Setup-1.0.36.exe`，安装后使用桌面 FastGC WhatsApp 快捷方式。

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

## 打包

```sh
npm run build:pack-bundles
npx electron-builder --win nsis --publish never --config.forceCodeSigning=false --config.win.signAndEditExecutable=false
```

以上命令生成未签名安装包。本仓库 Release 使用本地验收后的安装包，并发布 SHA256；自动重建结果不得覆盖已验收资产。签名构建见 [签名说明](docs/SECURITY_SIGNING.md)。

生产依赖扫描、有限时长的多席位观察及真实发送结果，以对应版本 Release 中的验收说明为准。有限测试不能保证任意数量账号的长期稳定性。


1.0.35 补充：仅初始化实际使用的浏览器会话；退出前刷新存储并关闭连接，刷新和连接等待均有上限；合并 WhatsApp 与翻译请求头监听，避免互相覆盖；构建依赖覆盖到 global-agent 4.1.3，移除 sprintf-js 告警链。

# Windows 签名与更新安全

## 当前已启用

- 构建强制签名：`build.forceCodeSigning = true`
- 安装包是否签名，以安装包的实际 Authenticode 验证结果为准；当前本地发布使用显式未签名构建。
- 自动更新仅允许 HTTPS 更新源
- 运行时启用更新签名校验：`autoUpdater.verifyUpdateCodeSignature = true`

## 构建机必需环境变量

- `CSC_LINK`：代码签名证书（base64 或文件 URL）
- `CSC_KEY_PASSWORD`：证书密码

## 建议发布流程

1. 在 CI/构建机注入 `CSC_LINK`、`CSC_KEY_PASSWORD`
2. 执行 `npm run dist:win`
3. 验证生成安装包数字签名有效
4. 将 `latest.yml` 与安装包发布到 HTTPS 源
5. 用已安装旧版本执行一次在线更新验证


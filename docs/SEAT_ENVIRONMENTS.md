# FastGC 内置基础环境

1.0.40 在 FastGC 内实现，不连接用户的比特浏览器或其他第三方环境服务。

## 固定、独立的环境

每次安装的数据目录生成一次本地随机根密钥，通过席位真实登录分区派生独立的环境。根密钥损坏或写入失败不自动重新生成；环境初始化失败时停止加载该席位并提示。删除后重建席位沿用1.0.39的新分区规则，得到新环境。改名、固定、排序和重启保持原环境。

通过 Electron `contextBridge.executeInMainWorld` 在主页面 preload 阶段安装保护：

- Canvas：`getImageData`、`toDataURL`、`toBlob` 使用相同的确定性轻微像素扰动；不修改原画布。
- WebGL：RGBA / UNSIGNED_BYTE 类型的 `readPixels` 使用席位固定的读取扰动；不改变GPU帧缓冲或GPU型号。
- 离线音频：`OfflineAudioContext.startRendering()` 的 Promise 返回路径使用固定的极小样本扰动；不采集麦克风、不播放声音、不修改实时通话的 `AudioContext`。

“席位配置”显示环境编号和初始化状态。编号是给用户核对环境的标记；指纹差异验收必须比较实际绘制/读取/离线渲染结果，不能只比较编号。

## 范围

这是基础隐私保护，不是定制 Chromium 指纹内核。不覆盖 Worker、OffscreenCanvas、WebGPU、子框架和所有原生接口路径，也不保证其他脚本无法识别这些JavaScript接口修改。

浏览器引擎和版本、真实CPU/GPU特性、系统字体、语言时区、网络出口和公网IP仍可能相同。不同席位的所有参数不必全部不同；本版只对已列出的读取路径验证整体结果差异与重启稳定性，不保证账号不会关联、不受风控或任何场景都可用。需要完整内核覆盖时，需另行核对可内嵌浏览器内核及授权。

已有WhatsApp账号和聊天数据库不复制、不清空；仍按各席位原登录分区使用。新建、登录、发送和真实音视频必须分别验收。

## 参考

- https://www.electronjs.org/docs/latest/api/context-bridge#contextbridgeexecuteinmainworldexecutionscript-experimental
- https://www.electronjs.org/docs/latest/api/web-contents

# Userscripts Enhanced 0.1.0 — 开发预览

基于 [quoid/userscripts](https://github.com/quoid/userscripts)，锁定上游 Commit `8b743e37dd7dfc8a510aff4e5e2ab8b1cc9210df`。沿用 Svelte、Vite、CodeMirror、Swift 和 Manifest V2，许可证保持 GPL-3.0。

**当前不是完整兼容、可安全日用的正式版。Build 6 封堵了 Build 5 发现的隔离绕过（JSDOM 与真实 WebKit 审计 30 条攻击路径全部阻断），但 Safari 扩展端到端对抗验收尚未完成。不得将构建成功或模拟消息测试当作 Safari 验收通过。**

## Build 7：脚本快捷键

- 弹窗脚本详情新增“快捷键”区：自动检测脚本源码中的快捷键，并记录实际使用中脚本处理过的快捷键。
- 每个快捷键可停用、录制新组合改键或还原，即时生效。说明见[面板协议](docs/panel-api.md)。

## Build 6：脚本隔离加固

- 修复隔离 realm 可经 iframe 的 `top` 直达扩展 API 的漏洞（共 19 条利用路径，含 `setTimeout("字符串")` 直接在扩展环境执行代码）。做法见[安全模型](docs/security-model.md)。
- 有权限脚本默认以严格模式运行；旧脚本出错时可在弹窗“脚本设置”中对单个脚本开启“兼容模式（不安全）”，需二次确认。
- 不支持动态 `import()`；`eval` 不能访问调用处局部变量。

## Build 5：脚本兼容与弹窗设置

- 修复 Build 4 沙箱中 `window.top !== window.self` 恒为真（Click Fx、Boss Key 等脚本因此直接退出、不注册任何菜单）及 `location` 不随单页应用导航更新。
- 修复脚本向 `postMessage`、`structuredClone`、`history.pushState` 等传普通对象时的 DataCloneError。
- 弹窗脚本详情新增“脚本设置”：允许自动弹出页面面板（经 `GM_info.preferences.autoPopup` 传给脚本）、在管理页中打开此脚本、刷新网页；无操作的脚本会说明原因。
- `@inject-into page` 脚本可注册工具栏菜单命令。
- 新增 `tests/user-scripts-webkit.js`：用生产入口在真实 WebKit 中运行 `tests/local/final-scripts` 下的脚本，报告错误、已注册菜单和 DOM 效果。

## Build 4：脚本隔离

每个有权限脚本使用独立 realm 和 DOM 膜，GM/UE 能力按 grant 传入；禁止直接扩展 API 和外部 Window。详情及限制见 [安全模型](docs/security-model.md)。

## Build 3：弹窗与脚本接口


## 已接通的功能

- Safari 工具栏菜单：同步/Promise 注册、注销、标题更新、同名命令、异步回调、错误反馈、重复点击保护。
- 完整 tab/frame/document/script/command 路由；后台重启从存活 frame 的索引恢复，不传输函数、不轮询 DOM。
- 稳定 UUID（编辑器内改名保留）、namespace 文件冲突处理；网页中不注入管理器控制入口。
- 同步缓存存储、持久化 Promise 存储、跨标签页监听；同步写入为 write-behind，详见 API 限制。
- 有 `@connect`/宿主权限检查的网络请求、终止、超时、进度；拒绝无法逐跳授权的重定向。
- 样式、元素、日志、脚本信息、标签页控制/数据、剪贴板反馈、资源文本/data URL 与完整性检查。
- 安装预览、URL/文件/拖放/批量导入、全体启停、JSON 备份、冲突预览、源码恢复事务。
- 更新候选审批与回滚；使用 Safari alarms 调度检查和失败退避，默认不自动安装。明确启用后，只自动应用声明未变化的更新。
- 独立 Bundle ID、App Group、URL Scheme 和签名设置；Debug 与 Release 也分开。

这些条目表示有真实执行路径，覆盖和验收状态以 [逐项验收](docs/acceptance.md) 为准。

## 本机位置

维护中的工程：`Userscripts-Enhanced`。原工作区的 `Userscripts-Enhanced-local` 链接指向它。桌面原 `Userscripts-Enhanced` 目录保留初期审计副本和完整上游历史，请勿继续在该旧副本编辑。

Xcode 工程：`xcode/Userscripts.xcodeproj`，Scheme `Mac`。独立 Debug 应用安装位置：`~/Applications/Userscripts Enhanced Debug.app`。

```sh
npm ci
npm run build:mac-safari-16.4
./scripts/build-enhanced.sh Debug
```

本机已配置现有开发证书的 Team（忽略的 `xcode/xcconfig/Userscripts-Enhanced.dev.xcconfig`）。其他机器应按 [构建指南](docs/build-guide.md) 配置自己的 Team，不能复制签名私钥。

```sh
npm run lint:js
npm run lint:css
npm test
./scripts/test-native.sh
npm run test:performance
npm run audit:sandbox
```

`audit:sandbox` 与 `audit:sandbox:webkit` 检查真实 DOM 膜、逃逸攻击、负对照与正向功能，均纳入 `npm run verify`。WebKit 测试使用合成扩展 API，不冒充 Safari 扩展端到端验收。

## Safari 回归

先阅读 [安全模型](docs/security-model.md)。系统权限由用户本人确认；本项目没有更改 Safari 安全开关、Gatekeeper 或原版应用。

```sh
npm run test:serve
```

打开 `http://localhost:8173`，优先使用页面中的用户提供 SpeedMaster 4.1 工具栏适配版/API 样例。适配版、未改动原版及早期原创样例分别标注，见 [SpeedMaster 回归](docs/speedmaster-regression.md)；当前尚未完成 Safari 真机验证。停止测试服务器使用 Ctrl+C。

## 文档

- [架构与基线审计](docs/architecture.md)
- [完整兼容性矩阵](docs/compatibility-matrix.md)
- [GM API 支持与语义](docs/gm-api-support.md)
- [安全模型与阻塞项](docs/security-model.md)
- [迁移与恢复](docs/migration.md)
- [测试方法及记录](docs/testing.md)
- [SpeedMaster 4.1 来源、适配与回归](docs/speedmaster-regression.md)
- [构建及安装](docs/build-guide.md)
- [初始化卡住修复与证据](docs/native-startup-fix.md)
- [验收清单](docs/acceptance.md)
- [维护路线](docs/maintenance.md)
- [实际运行时测量](docs/reports/performance.md)
- [原版 README](docs/upstream-README.md)

构建或安装前须完全退出 Safari（Command-Q）。Xcode 会自动登记构建产物，构建脚本在成功验证后撤销该副本的登记；安装脚本只登记 Applications 副本，避免同标识版本并用。不要在 Safari 运行期间直接用 Xcode 替换这份日用安装；需要 Xcode 联调时先退出 Safari，并明确选定唯一运行副本。

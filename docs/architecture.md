# Userscripts Enhanced 架构与审计

基线：quoid/userscripts `8b743e37dd7dfc8a510aff4e5e2ab8b1cc9210df`，获取日期 2026-11-06（Asia/Taipei）。保留 GPL-3.0 与上游历史；未发布远程。

## Phase 0 实测

macOS / Apple Silicon，Git 2.54.0，Node 26.11.1，npm 11.20.0，Xcode 27.0 (27A266a)。`npm ci`、`npm run build:mac-safari-16.4`、`xcodebuild -project xcode/Userscripts.xcodeproj -scheme Mac -configuration Debug -derivedDataPath artifacts/Baseline CODE_SIGNING_ALLOWED=NO build`、两项 lint 均通过。原版仅编译，未安装、未启用、未接触 App Store 数据。完整构建日志在 artifacts/logs/baseline-\*.log。

## 真实架构

- Svelte 5 + Vite 6，多入口；编辑器 CodeMirror 5，已有搜索、撤销、补全、括号、保存快捷键等，不替换编辑器。
- `scripts/build-safari-16.4.js` 输出 app WebView 和 Safari 资源。docs/dev.md 的 `build:mac` 已过时。
- `public/ext/safari-16.4/manifest.json` 为 MV2，非持久 background；不迁移 MV3。
- `src/ext/content-scripts/entry-userscripts.js` 每 frame 在 document_start 启动，向 background 获取代码，按 run-at 注入；有 page/content 两种运行环境及 CSP fallback。
- `src/ext/content-scripts/api.js` 原有异步存储、XHR、标签、样式和剪贴板代理；无菜单命令。
- `src/ext/background/main.js` 路由到 Swift，原菜单仅支持 @run-at context-menu，不能代替 GM_registerMenuCommand。
- `xcode/Ext-Safari/Functions.swift` 负责实际元数据解析、匹配、文件、更新；`SafariWebExtensionHandler.swift` 为原生桥。
- `xcode/Shared/Preferences.swift` 使用 App Group 和 security-scoped bookmark；默认目录在扩展独立容器。
- 上游以文件名作为身份；增强版在 `Enhanced.swift` 分配并持久化 UUID，编辑器改名转移身份，GM 值按 UUID 分区。同名不同 namespace 使用散列文件后缀；外部改名身份转移仍有限制。

## 最小菜单改动

1. 每文档生成随机 documentId，每脚本独立 Map 保存 callback；API 同步返回 ID，GM.\* 返回 Promise。
2. background 只接受扩展 popup/page 的列表、执行、失效请求；content 来源 tab/frame 由浏览器提供。没有 DOM/postMessage 特权桥。
3. popup 打开时向存活 frame 请求内存索引快照（不重扫 DOM、不重新注入）。每次展开只切换 UI。后台重启后同样从存活 frame 重建，因此不持久化已经失效的函数或注册表。
4. 执行携带完整 tab/frame/document/script/command 标识；background 原生复核启用状态，content 再核对 documentId，且同一命令不并发执行。
5. pagehide 清理；BFCache 恢复保留仍属于同一文档的 callback；导航后旧 ID 不可用；禁用时撤销注册，重新启用需刷新。
6. Svelte 原生 button/details，纯文本命令标题、滚动、键盘、状态反馈，绝不添加网页管理器入口。

## 当前模块边界

- `menu-runtime.js` 保存 callback；`menu-router.js` 校验来源与完整路由；`ScriptCommands.svelte` 展示真实命令。后台不长期保存 callback。
- `value-store.js` 提供预热同步缓存、异步写队列和监听；`background/network.js`、`tab-api.js` 通过原生身份/源码版本/grant 校验后执行对应能力。旧的无约束代理入口已拒绝。
- `Enhanced.swift` 负责 UUID、资源校验、HTTPS 读取、安装/更新候选、备份预览及文件恢复事务；浏览器值与设置由备份工具做有范围的补偿，跨存储不具备原子性。
- `updates.js` 使用 alarms，检查与运行页面分离；默认不自动应用，声明变化必须审批。资源和依赖使用 HTTPS、内容摘要及可选 SRI；拒绝重定向。
- `DataTools.svelte` 在扩展管理页面提供导入、更新和备份。宿主应用只负责状态和独立目录；网页没有管理器入口。

## 尚未建立的安全边界

IIFE 只防止内部绑定意外成为全局变量，不构成恶意代码隔离。上游注入引擎在 content realm 动态运行代码，攻击样例可访问同一环境的 browser API，绕过 GM 能力检查。现有路由授权不能修复这个环境级问题。安全审计失败被保留为阻止正式发布的门禁；详见 security-model.md。

## 剩余顺序

强隔离 → Safari 菜单与权限真机验收 → 备份/更新恢复故障注入 → 全面兼容及性能验收。每项以 compatibility-matrix.md / acceptance.md 的实际状态为准。

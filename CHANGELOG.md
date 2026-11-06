# Changelog

## 0.1.0 开发预览 — 2026-11-06

Build 7 新增脚本快捷键管理：源码静态检测加运行时观察，在弹窗中显示，并可逐个停用、改键或还原（隔离脚本，即时生效）。新增 tests/shortcuts.test.js 与 tests/keyboard-webkit.js（真实 WebKit，纳入 verify）。

Build 6 自建 realm 链接：宿主 window 进入脚本时对应脚本自己的 scope，不再暴露 realm 原始全局对象；拒绝宿主端代码编译入口与字符串定时器；realm 内 Function/eval/构造器改为在 scope 内编译；默认严格模式；改写动态 import()。新增每脚本“兼容模式（不安全）”。审计扩充到 30 条路径，JSDOM 与 WebKit 均全部阻断。

Build 5 修复沙箱窗口身份（`top`/`self`/`parent`/`frames`/`globalThis`）与实时 `location`，使带顶层判断的脚本重新运行；修复结构化克隆类 API 的 DataCloneError；新增弹窗脚本设置（自动弹出偏好、管理页直达、刷新）与 page 世界菜单桥；SpeedMaster 适配版 4.2.2 恢复播放时自动显示面板并遵守偏好。新增审计路径发现 realm iframe 的 `top` 可直达扩展 API，隔离门禁失败，记录于安全模型。

Build 4 替换特权 Function 执行为独立 realm + DOM 膜；阻断扩展 API、外部 Window 与跨脚本原型污染，补齐跨 realm 数据复制、回调与撤销回归。JSDOM/真实 WebKit 合成能力门禁通过，Safari 扩展完整对抗待验。

Build 3 重做弹窗列表/详情、独立启停，新增可选 UE.registerPanel v1 和适配 skill；标准菜单保持原语义。Build 4 处理了此前的共享 realm 绕过。

Build 2 修复原生请求完成、初始化超时/错误提示、活动标签查询及安装后的扩展登记；Safari 管理页初始化已实测。

基于 quoid/userscripts `8b743e37dd7dfc8a510aff4e5e2ab8b1cc9210df`。

- 增加文档内菜单注册表、工具栏交互及按 tab/frame/document 路由和撤销。
- 增加同步缓存/异步持久化值、变更监听、有授权检查的网络、标签控制、资源及 DOM API。
- 增加稳定 UUID、namespace 冲突处理、元数据保留与警告、依赖完整性及注入去重。
- 增加安装预览、批量操作、JSON 备份、恢复事务、更新候选审批和 alarms 调度。
- 分离 Debug/Release 的应用标识、App Group、URL Scheme；提供签名构建、验证和独立安装脚本。
- 增加自动化测试、原创视频/API 回归样例及性能测量。
- 接入用户提供的 SpeedMaster Safari 4.1 快照、单独工具栏适配及 6 项真实入口模型回归；原文件未更改，Safari 待验证。
- 修复 URL 编码保留、IDN 处理和构建输出异步顺序。

**发布阻塞：** 已知共享 realm 绕过已修复并通过 JSDOM/WebKit 门禁；有限回归不等同于全面安全证明。Safari 真机回归尚未完成。当前版本不能标记为安全日用或完整 Tampermonkey 兼容；已知限制见 docs/security-model.md 与 docs/acceptance.md。

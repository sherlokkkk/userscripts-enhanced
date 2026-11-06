# 安全模型与阻塞项

## Build 5：发现的新绕过（未修复，安全门禁失败）

**隔离 realm 的 iframe 自身的 `top` 指向有特权的 content-script window。** `top` 是 Window 的不可伪造（unforgeable）属性，膜无法重映射。在脚本 realm 中执行 `Function('return top')().browser`，或通过 `Object.getOwnPropertyDescriptor(<realm global>, 'top').get` 取值，都能直接拿到原始 `browser` 扩展 API 和特权 realm 的 `Function` 构造器。Build 4 的 11 条攻击路径没有覆盖这一点；Build 5 将其加入两个审计（共 16 条），`realm top` 和 `top descriptor` 两条目前**不能阻断**，因此 `audit:sandbox:webkit` 结果为失败（JSDOM 不实现这一 WebKit 行为，审计仍通过，不能以此为准）。

已尝试且行不通的修复（WebKit 实测）：

- `keepAlive: false`（分离 iframe）：`top` 变为 null，但 WebKit 不再执行分离 realm 的 promise 回调，`await` 一个被拒绝的 promise 后脚本永远不会恢复，普通 async 脚本会静默卡住。
- 设置 realm 文档的 `document.domain`：沙箱 iframe 禁止该 setter；即使去掉 sandbox 属性，扩展隔离世界中 `top.document` 仍可访问。

结论：在 Safari 扩展的 content world 中，当前方案**不是安全边界**，只能防止误用，不能防止恶意脚本拿到扩展能力。仅安装你信任的脚本。真正修复需要另行设计（例如捕获后从 content world 移除扩展全局并冻结特权 realm 的内建原型，或改为页面世界 + 受控消息桥），作为后续工作。

## Build 5：兼容性修复

- 脚本以 `window/self/globalThis/top/parent/frames/location` 绑定到一个窗口代理的方式执行：顶层 frame 中 `window.top === window.self`（Click Fx、Boss Key 等脚本开头的 frame 判断此前恒为“不在顶层”，脚本直接退出），`location` 为网页实时地址（此前是 realm 创建时的快照，单页应用导航后过期）。iframe 内脚本的 `top` 为不透明对象，仍判定为“不在顶层”。
- 已知差异：`document.defaultView`、`event.view` 返回 realm 全局而非该代理（`=== window` 为 false）；`document.location` 仍是快照，请用 `location`。
- `structuredClone`、`postMessage`、`history.pushState/replaceState`、`BroadcastChannel/MessagePort/Worker.postMessage` 收到脚本 realm 的普通对象时，原生实现会抛 DataCloneError。content world 中这些 API 在 DataCloneError 时改用宿主副本重试（原始值、数组、普通对象、Date、Map、Set）；函数等本来不可克隆的值仍抛原错误。该包装只在扩展 content world，网页不受影响。
- `@inject-into page` 脚本可声明菜单 grant：`GM_registerMenuCommand` 等通过每次注入随机命名的 CustomEvent 传 JSON（标题、选项、键），点击时回传键，不传任何扩展能力。网页若抢先劫持 `dispatchEvent` 可伪造该脚本的菜单项（只影响显示的标题；点击仍只是向网页派发事件），这一点已知并接受。

## Build 4：已修复共享扩展 realm 的已知绕过

此前保留的失败门禁确认：在扩展 content realm 中直接 `Function(code)` 会让用户脚本调用 ambient `browser.storage.local`，绕过 GM 的 scriptId 命名空间。Build 4 移除了此执行路径。

有权限脚本现在各自使用一个独立 iframe realm，通过固定版本 `@locker/near-membrane-dom@0.19.1` 的 DOM 膜访问网页。GM 与 UE 对象按 grant 显式传入，回调保留在脚本 realm；不创建网页消息特权桥。每个 scriptId/文档只有一个 realm，右键重复执行复用它。

**库本身不提供安全保证，安全策略由本项目实现：** 捕获并阻断 browser/chrome/safari/webkit 能力对象及其方法、getter/setter 引用；拒绝外部 Window，避免 iframe 引入另一组未受控能力；JS 全局及原型使用写时复制；仅原生 DOM 实例、style 和 dataset 允许共享写入，原型不设为 live target。缺少安全 Window 品牌检查、CSP 阻止 realm 创建或初始化出错时，停止该脚本，不回退到原来的特权 Function。依赖说明见 [Near Membrane 文档](https://github.com/salesforce/near-membrane/tree/main/packages/near-membrane-dom)。Safari 尚未提供 userScripts API，见 [MDN 兼容性数据](https://github.com/mdn/browser-compat-data/blob/main/webextensions/api/userScripts.json)。

## 实际验证

- `npm run audit:sandbox`：编译真实入口及实际 DOM 膜，在 JSDOM 的真实独立 realm 中运行合成数据攻击。原始 browser.storage 读取与另外 10 条 globalThis/window/构造器/DOM/descriptor/frame/event 路径全部阻断。必须确认脚本完整执行、自己的嵌套 GM 值可读写、DOM 可用、标准菜单与 UE 控件回调可执行，才能通过。
- 同一攻击在测试构建恢复旧 Function 执行时必须再次泄漏合成数据，作为负对照；不将启动失败或缺少测试 API 当作安全成功。
- `npm run audit:sandbox:webkit`：未改动的生产入口及 DOM 膜运行于真实 WKWebView 独立 WKContentWorld，上述攻击和正向功能检查通过。浏览器扩展 API 为合成替身，**不是 Safari 扩展端到端对抗验收**。
- `tests/isolation.test.js`：两个脚本的全局/JS 原型/DOM 原型修改不串到其他脚本或管理器；DOM 属性和样式仍生效；重复右键执行只创建一个 realm；撤销后捕获的 GM 方法拒绝调用。

结果见 `reports/sandbox-audit.json` 与 `reports/sandbox-webkit.json`。测试不读取用户实际存储。有限攻击回归通过不等于证明不存在所有逃逸，仍保持开发预览，完整 Safari 对抗及长期资源测试待完成。

## 兼容边界

- `@grant none` / page world 保留页面执行语义，除菜单命令（见上方 Build 5）外没有 GM 特权。它们与网页共享 JavaScript，并不承诺与页面隔离。CSP fallback 也必须经过新 realm。
- 网页 DOM、页面存储及页面网络本来就属于网页共享资源；脚本将秘密主动写入它们，或主动泄露自己的 GM 函数，不能获得保密保证。
- 不再支持依赖 ambient browser/chrome 或直接外部 iframe Window 的脚本。跨 frame 脚本应在自己的匹配 frame 独立执行；unsafeWindow 仍不支持。普通 DOM、style、dataset、事件、GM 存储/菜单与 UE 面板有回归覆盖，不能据此承诺所有脚本兼容。
- 每脚本每文档保留一个隐藏空白 iframe，以维持 realm 生命周期；没有可见管理器页面按钮。禁用撤销受控能力并禁止再次 evaluate，已有任意 JS/DOM 副作用仍需刷新清除。文档卸载由浏览器释放 frame；BFCache 保留原 realm。未宣称禁用能强制终止任意 JS 或满足长期性能指标。

## 已落实的保护

- App Store 标识、容器和原数据不修改；本机只安装 Enhanced。已知原版容器路径被拒绝作为 Enhanced 目录，新目录须为空；迁移通过复制与预览导入。
- 菜单没有网页 DOM/postMessage 特权桥。控制请求只接受真实扩展 UI sender；tab/frame 来源不能由页面消息冒充。
- 每次执行验证完整 documentId、scriptId、commandId 及存活 frame；原生复核源文件指纹、grant、启用状态。导航竞态还由目标文档再次核对 ID。
- 未将 callback JSON 化；脚本字符串不作为命令执行参数；Svelte 以文本显示脚本名、标题、错误和元数据。
- 网络新传输关闭了原有无限制 API_XHR/标签/剪贴板旧通道；使用原生授权、@connect、宿主权限三层检查。重定向无法逐跳核查时拒绝。
- URL 安装有大小/超时限制，先显示完整元数据再确认；安装源重定向显示最终来源或拒绝。
- 更新候选落盘、核对当前版本和候选 hash；声明变化暂停自动安装。自动安装默认关闭。失败保留原源码及恢复事务。
- 路径只允许单一安全文件名，拒绝目录穿越和逃出目标目录的 symlink。备份只允许列出的脚本 ID 对应数据和用户可配置设置。
- 资源/依赖采用 HTTPS、缓存、内容指纹与声明完整性校验；禁止下载到任意文件路径。
- 不加入遥测、广告或开发者服务器；日志保留本地，未保存浏览历史以恢复菜单。

## 尚未证明或未完成

- 对尚未覆盖的逃逸路径进行独立审计，以及真实 Safari 扩展中完整安全对抗验收。
- 真实 Safari 页面伪造消息、跨 origin iframe、BFCache、浏览器后台重启及长时间行为。
- 细粒度的逐 API/逐站点授权 UI、权限变更审计历史。
- 脚本禁用会撤销菜单和受控 API、释放管理器监听器；无法强制停止已经执行的任意 JS/DOM 副作用，彻底停用需刷新页面。
- 恢复的浏览器存储与原生文件是补偿事务，不是跨进程 ACID。代码会检测冲突和尝试恢复；极端断电/进程终止需用保留的恢复记录与导出备份处理。
- npm 审计余 3 项低危开发链告警（deepmerge/Svelte Vite 插件链）；未通过升级整个构建架构强行消除。

保持非持久后台遵循 [Apple 优化指南](https://developer.apple.com/documentation/safariservices/optimizing-your-web-extension-for-safari)。高级阻塞请求与 Cookie 限制见 [Apple 兼容性说明](https://developer.apple.com/documentation/safariservices/assessing-your-safari-web-extension-s-browser-compatibility)。

# 测试方法与记录

日期：2026-11-06（Asia/Taipei）。维护路径见 README。日志保存在忽略的 `artifacts/logs/`，机器可读报告在 `docs/reports/`。

## 自动化结果

- `npm test`：80 项通过，0 失败、0 跳过。覆盖菜单注册/路由、缓存与持久化值、真实本地 HTTP 请求、元数据、标签控制、备份补偿、更新调度、能力白名单及编译后的注入入口。
- `./scripts/test-native.sh`：14 项通过，0 失败。包括 9 项 Enhanced 回归、3 项上游确定性测试、2 项 URL 测试。没有运行依赖外部网站的上游网络测试；本命令不是完整上游测试集。
- `npm run audit:sandbox`：通过。真实入口与 DOM 膜的 11 条攻击、嵌套存储/DOM/菜单/面板正向检查与旧 Function 负对照；`audit:sandbox:webkit` 在真实 WebKit 独立 WKContentWorld 通过，扩展 API 为合成替身。两者都纳入 verify；不是 Safari 扩展端到端验收。
- JS/格式与 CSS 静态检查单独执行。审计/性能脚本会生成报告，运行后先格式化报告再执行格式检查。

原生 URL 测试 `testJsLikeURL` 初次在本机失败，修复 IDN 与保留字符编码后重跑同一测试通过，最终 14 项包含该测试。不能把最初失败解释为环境噪声或跳过。

原生测试宿主的日志出现 pasteboard sandbox 连接拒绝；当前测试不验证剪贴板。其行为、用户手势与权限必须在 Safari 实测，不能根据测试进程退出成功认定支持。

最新版 Debug 已安装并通过产物签名验证。旧构建宿主 GUI 曾显示扩展停用；最新版启动后窗口存在，但最终界面复核遇到屏幕锁定，未确认渲染结果。没有尝试解锁或更改系统设置。

## 模型测试的边界

Node 测试使用浏览器消息/DOM 模型和实际模块；引擎测试由 Vite 编译实际入口。网络测试启动真实 loopback HTTP 服务，验证请求/取消/超时/进度。它们没有运行 Safari 的 popup、进程、站点授权或真实多窗口。原生测试直接调用确定性 helper，未覆盖管理页到磁盘再到 browser.storage 的完整恢复过程。

`npm run test:performance` 的 0/1/20/50 脚本、多 frame 注册表测量是实测 Node 数据，详细计时见 reports/performance.md。未测量 Safari IPC、CPU、内存、SPA 高频路由或浏览器长时间运行。

## Safari 准备

用户已自行启用扩展，Build 2 已实测管理页初始化恢复，详见 native-startup-fix.md。仍不代操作站点权限或系统安全设置；localhost 回归须用户授权后执行：

```sh
npm run test:serve
```

访问 `http://localhost:8173`，从页面链接预览导入 SpeedMaster 4.1 工具栏适配测试版和 API 样例，或运行 `npm run prepare:speedmaster` 后从 `tests/local/` 导入。只启用一个倍速脚本。视频是本地生成的样例。用户提供的原版不注册菜单；来源、适配及 6 项新增回归见 speedmaster-regression.md，Safari 仍待验证。

每项记录 macOS/Safari 版本、脚本版本、站点授权、操作、实际结果与截图；未经执行的项目保持待验证。

| 菜单验收场景           | 自动化依据                         | Safari 状态 |
| ---------------------- | ---------------------------------- | ----------- |
| 单条/多条注册          | menu-runtime/engine                | 待验证      |
| 多脚本同名命令         | menu-runtime                       | 待验证      |
| 点击准确执行 callback  | menu-router/engine                 | 待验证      |
| 动态更新名称           | menu-runtime                       | 待验证      |
| 注销立即消失           | menu-runtime                       | 待验证      |
| 页面重新加载注册       | 新文档模型                         | 待验证      |
| 切换标签页             | menu-router 路由校验               | 待验证      |
| 关闭标签页清理         | 生命周期代码审查/部分模型          | 待验证      |
| iframe 注册            | menu-router frame 模型             | 待验证      |
| iframe 导航后旧命令    | documentId/失效路由模型            | 待验证      |
| SPA 同文档导航         | 注入去重模型；无完整浏览器路由测试 | 待验证      |
| callback 抛异常        | menu-runtime                       | 待验证      |
| Promise callback       | menu-runtime                       | 待验证      |
| 快速重复点击           | busy 锁模型                        | 待验证      |
| 单脚本禁用             | 撤销模型                           | 待验证      |
| 全局禁用               | 捕获 API 撤销模型                  | 待验证      |
| Background 重新启动    | 活 frame 快照模型                  | 待验证      |
| popup 反复开关         | 未运行 UI                          | 待验证      |
| 双窗口相同网站         | 路由模型不能替代双窗口             | 待验证      |
| 键盘/VoiceOver、深浅色 | 语义 button 与样式代码             | 待验证      |

其他必测：未知来源安装确认、namespace 冲突、删除确认、外部编辑器变化、离线缓存、存储跨标签页、禁用后刷新、资源完整性失败、网络权限拒绝/重定向拒绝、剪贴板手势、更新扩权拒绝与回滚、备份故障补偿。安全攻击还须覆盖 ambient browser、Function/constructor、globalThis、原型、跨 frame 与消息重放。

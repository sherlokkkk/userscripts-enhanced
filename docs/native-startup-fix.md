# Safari 原生通信与初始化卡住修复

2026-11-06，Build 2。用户截图显示管理页停留在 Initializing app、弹窗持续加载，并报 runtime.sendNativeMessage 无法与辅助程序通信。

## 定位证据

- 两个 Enhanced 标识分别为 Debug 与 Release。系统登记的 Debug 原生扩展指向 DerivedData 构建副本，而非 Applications 安装副本。
- 原生进程曾处理 NATIVE_CHECKS，但后续 Safari 控制台的只读 REQ_PLATFORM 探测保持 pending。没有据此认定证书或登录一定有问题。
- LLDB 只读检查确认 PrincipalClass 能解析；没有修改系统安全设置。该检查已 detach。
- 原生处理器使用 inputItems[0]，且缺少消息 name 时直接 return、不完成请求。这个路径没有保证每个请求得到答复。
- 管理页未捕获初始化 Promise 的拒绝；弹窗部分 await 不在完整的错误处理范围内，原生请求本身也没有超时。标签页查询依赖 popup 中不可靠的 getCurrent。

## 修改

- 原生使用 inputItems.first，缺少 name 的输入也 completeRequest 返回结构化错误。
- 原生客户端限制初始化等待时间为 10 秒，其他请求为 90 秒；同步异常、拒绝、空回复都报告错误。不会自动重试写操作，超时明确说明原生操作可能仍在运行。
- 管理页显示具体失败原因和 Retry connection；弹窗捕获初始化异常、结束加载并允许重试。端口连接失败不会阻止页面挂载，组件销毁时断开端口。
- popup 使用 active/currentWindow 标签查询；平台未知时不再误显示 iOS 公告。
- 构建号更新到 2；安装完成后显式登记安装目录下的原生扩展，避免继续使用旧的构建副本。

重新构建、安装并登记后，Safari 日志可见 REQ_PLATFORM、POPUP_MATCHES、PAGE_INIT_DATA、PAGE_ALL_FILES 正常进入处理器，管理页实际载入设置界面，初始化覆盖层消失。没有独立实验将每个修复的贡献完全拆开，因此不将单一因素说成已证明的唯一根因。

## 验证

- JS：68 项通过；含 4 项原生客户端回归，覆盖正常回复、异常/空回复、超时与晚到回复、写操作不重复。
- 原生：14 项通过；新增请求完成测试覆盖空输入、缺失 name、REQ_PLATFORM，检查每次恰好完成一次。
- Debug、Release Build 2 均构建并通过签名与 App Group 验证；Debug 已安装。
- Safari 管理页初始化成功；Debug 工具栏弹窗已实际显示当前站点、已安装脚本列表及管理/设置入口，加载指示消失。重复开关自动化遇到 AX 控件边界拒绝，没有据此声称生命周期专项全通过。完整工具栏脚本命令、恢复故障注入、恶意脚本隔离仍按原验收清单继续，不因初始化恢复而标记全通过。

Safari 会忽略 sendNativeMessage 的 application 参数，并将消息送到所属应用的原生扩展；因此没有将替换这个字符串当作修复。参见 [Apple 原生消息文档](https://developer.apple.com/documentation/safariservices/messaging-between-the-app-and-javascript-in-a-safari-web-extension)。

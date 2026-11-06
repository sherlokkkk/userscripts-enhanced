# Other version in use 修复

2026-11-06。用户粘贴的 runtime.sendNativeMessage 报错包含 `Other version in use`。系统日志明确同时引用同一 Enhanced 扩展标识在 Applications 和 DerivedData 中的两份原生扩展，PlugInKit 返回 Code 16。

用户完全退出 Safari 后，重新安装并撤销已核验的构建副本登记，只登记 Applications 下的 Enhanced Debug。`pluginkit -m -A -D -v -i local.userscripts-enhanced.mac.extension` 返回唯一安装路径。没有清除脚本、GM 值、站点许可或 App Store 原版数据。

修正流程：构建/安装脚本在 Safari 运行时于写入前停止；构建脚本使用 EXIT 清理，成功或后续验证失败时都撤销确切 Enhanced 构建路径的登记；安装脚本核对身份后撤销 source_app 登记，再登记 destination。没有使用按 bundle ID 的全局删除，也不强制结束 Safari。

尝试 REGISTER_APP_WITH_LAUNCH_SERVICES=NO 后，本机 Xcode 日志仍有 RegisterWithLaunchServices，因此撤销该无效设置，不能声称 Xcode 已不自动登记。当前采用退出 Safari、构建后明确撤销登记的可观察流程。直接绕过脚本在 Xcode 中运行仍需先退出 Safari并选定唯一运行副本。

修复后 Safari 新进程 5829，原生处理进程 5901；日志观察到 REQ_REQUESTS、REQ_CONTEXT_MENU_SCRIPTS、POPUP_BADGE_COUNT、REQ_PLATFORM 请求正常处理，弹窗显示 0 个匹配脚本与管理入口。该次检查的新日志窗口未再出现 Other version in use。Safari 运行时的构建/安装保护均按预期退出，shell 语法检查通过。仅涉及打包/登记流程，未重复脚本专项测试。

这不改变现有强隔离及其他兼容性限制。

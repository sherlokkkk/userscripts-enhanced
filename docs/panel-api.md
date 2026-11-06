# UE.registerPanel v1

Enhanced 独有的可选接口，独立于标准 GM API；须声明 `@grant UE.registerPanel`。仅在 content world 提供；不支持强制 page world。先检测 `typeof UE !== "undefined" && UE.version === 1 && typeof UE.registerPanel === "function"`，再调用。其他管理器应走标准 GM 菜单或原有快捷键/页面入口。

`UE.registerPanel({version:1,title,controls})` 同步返回 `{update,dispose}`。每脚本每文档一份面板，重新注册替换旧面板。title/控件 id/label 是 1–256 字符文本；最多 24 个控件。不接受 HTML、CSS、脚本源码或外部页面 URL。参数错误同步抛出，所有控件验证后再替换。

| type   | 配置                                                                       | 回调                      |
| ------ | -------------------------------------------------------------------------- | ------------------------- |
| button | id、label、可选 disabled、closePopup（默认 false）                         | onClick()，可返回 Promise |
| toggle | id、label、boolean value、可选 disabled                                    | onChange(value)           |
| select | id、label、字符串 value、options: [{value,label}]，最多 32 个且 value 唯一 | onChange(value)           |
| range  | id、label、有限数值 min/max、正 step（默认 1）、符合步长的 value           | onChange(value)           |
| text   | id、label、字符串 value（最多 2048 字符）                                  | 无                        |

`handle.update({values:{controlId:newValue}})` 更新值，包括 text；不修改结构，结构变化重新注册。更新先完整校验，失败不部分应用。`dispose()` 幂等注销；旧 handle 不能更新新面板，也不能销毁新面板。禁用/导航后 handle 不能继续更新，返回 BFCache 需要脚本重新注册。

操作经原有 tab/frame/document/script/command 路由，原生再次检查已安装源码版本、grant、启用状态，目标文档校验控件值；disabled 控件与不合法值拒绝执行。callback 保留在原页面，消息只传数据。异步失败保留旧值并在界面显示原因；回调主动 update 的状态优先。关闭弹窗不会销毁页面中的状态；刷新网页会重建，需持久化时使用可用的 GM 存储。

现有 GM 菜单保持原语义，不猜测标题来自动关闭弹窗。打开页面面板可注册标准菜单时用 `{autoClose:true}`，或用增强 button 的 `closePopup:true`；普通设置控件保持弹窗打开。

完整可运行示例：[panel-controls.user.js](../tests/fixtures/panel-controls.user.js)。不需要为原脚本复制一套网页面板进扩展；把必要状态、动作声明到此接口，软件统一绘制。

安全边界：这是控制面板协议，不解决继承执行引擎的恶意脚本隔离缺口。安全门禁仍失败，见 security-model.md。不能因为该协议不接收 HTML 就宣称整套执行引擎安全。

## 脚本偏好：GM_info.preferences（Build 5）

弹窗中每个脚本的“脚本设置”提供用户选择，注入时以只读对象放入 `GM_info.preferences`（content 与 page 世界都有）：

| 键          | 默认 | 含义                                                                    |
| ----------- | ---- | ----------------------------------------------------------------------- |
| `autoPopup` | true | 用户是否允许脚本根据场景自动弹出页面面板；为 false 时只应从菜单命令打开 |

设置保存在扩展存储 `UE_SCRIPT_PREFS`，按 scriptId 区分，刷新网页后生效。软件无法强制关闭任意脚本自建的网页窗口，需要脚本自己读取：

```js
const autoPopup = !(
	typeof GM_info === "object" && GM_info?.preferences?.autoPopup === false
);
```

`@inject-into page` 的脚本现在也可以声明 `@grant GM_registerMenuCommand` 并注册工具栏命令（见 security-model.md 的 Build 5 说明），从而在弹窗中提供“打开设置”之类的入口。

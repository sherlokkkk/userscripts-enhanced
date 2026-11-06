# 构建与安装

## 工具及锁定版本

本次环境：macOS 27.0.1 / Apple Silicon，Git 2.54.0，Node 26.11.1，npm 11.20.0，Xcode 27.0 (27A266a)。依赖以 package-lock.json 为准；安全修补后 Svelte 5.57.3、Vite 6.4.5。目标编译 Safari 16.4，不代表已在旧 Safari 验证。

上游入口确认为 `npm run build:mac-safari-16.4`。`docs/dev.md` 中 `build:mac` 已过时。保留 MV2 非持久后台，没有整体迁移 MV3。

## 本机工程

```sh
cd Userscripts-Enhanced
npm ci
npm run build:mac-safari-16.4
```

桌面工作区的 `Userscripts-Enhanced-local` 为链接。初期桌面副本保留基线日志和上游完整历史，维护应使用 Developer 目录；构建目录放在标准 DerivedData，避免桌面文件提供程序的属性和读写停滞。

打开 `xcode/Userscripts.xcodeproj`，选择 Scheme `Mac`。Targets 为 Mac-App、Mac-Safari-Extension、Mac-Tests 及保留的 iOS targets。

## 签名

在 Xcode Accounts 登录及授权须由用户本人完成。当前机器已有开发证书，已配置忽略的文件：

```xcconfig
// xcode/xcconfig/Userscripts-Enhanced.dev.xcconfig
DEVELOPMENT_TEAM = YOUR_TEAM_ID
```

公开默认配置不含私人证书或 Apple Account。未更改 Keychain ACL 或导出私钥。

| 配置    | App ID                                 | Extension ID                                     | Mac App Group                           |
| ------- | -------------------------------------- | ------------------------------------------------ | --------------------------------------- |
| Debug   | local.userscripts-enhanced.mac         | local.userscripts-enhanced.mac.extension         | TEAM.local.userscripts-enhanced         |
| Release | local.userscripts-enhanced.mac.release | local.userscripts-enhanced.mac.release.extension | TEAM.local.userscripts-enhanced.release |

Debug URL scheme 为 userscripts-enhanced；Release 为 userscripts-enhanced-release。不要改回 com.userscripts.\*。Release 在此仅用于编译/签名验证，**不是发布许可或产品验收通过**。

## 一键构建及校验

```sh
./scripts/build-enhanced.sh Debug
./scripts/build-enhanced.sh Release
```

`UE_DERIVED_DATA` 可覆盖生成目录，默认 `~/Library/Developer/Xcode/DerivedData/UserscriptsEnhanced`。脚本先等待前端资源构建，再运行 Xcode，最后验证 Bundle ID、Group、MV2/alarms 和 codesign。

产品分别在 DerivedData 的 `Build/Products/Debug/Userscripts Enhanced Debug.app` 与 `Build/Products/Release/Userscripts Enhanced.app`，含 Contents/PlugIns 中的 Safari 扩展。

调试安装前退出旧的 Enhanced Debug，然后执行：

```sh
./scripts/install-enhanced.sh
```

只替换同一独立 Enhanced Debug 标识，先保留旧构建副本，不读写用户数据容器。App Store Userscripts 不在安装路径中。

## Safari 启用

用户已自行启用 Enhanced；本次已验证 Debug 管理页初始化。没有代替用户更改站点授权或浏览器安全设置。其他机器启用测试时：

1. 打开独立 Enhanced Debug 应用，选择“打开 Safari 设置”。
2. 在 Safari 扩展设置选择 Enhanced（不要改变 App Store 原版），确认扩展和 localhost 测试站点许可。
3. 先阅读安全门禁说明，只做隔离的开发测试；当前没有日用安全验收。
4. 按 testing.md 验证。

如果扩展不出现，应先核对签名、Team、容器标识和实际注册路径，再按 [Apple 运行指南](https://developer.apple.com/documentation/safariservices/running-your-safari-web-extension) 诊断。没有通过修改“允许未签名扩展”、Gatekeeper 或其他系统安全设置来掩盖签名问题。

构建或安装前须完全退出 Safari（Command-Q）。Xcode 会自动登记构建产物，构建脚本在成功验证后撤销该副本的登记；安装脚本只登记 Applications 副本，避免同标识版本并用。不要在 Safari 运行期间直接用 Xcode 替换这份日用安装；需要 Xcode 联调时先退出 Safari，并明确选定唯一运行副本。

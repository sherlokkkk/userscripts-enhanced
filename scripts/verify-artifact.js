import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
const app = process.argv[2];
if (!app) throw new Error("Pass the absolute path to a built Enhanced .app");
const plist = (file, key) =>
	execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, file], {
		encoding: "utf8",
	}).trim();
const info = path.join(app, "Contents/Info.plist");
const appId = plist(info, "CFBundleIdentifier");
if (
	!appId.startsWith("local.userscripts-enhanced.") ||
	appId.startsWith("com.userscripts.")
)
	throw new Error("Refusing an unrecognized or upstream app identifier");
const plugins = path.join(app, "Contents/PlugIns");
const extensions = readdirSync(plugins).filter((name) =>
	name.endsWith(".appex"),
);
if (extensions.length !== 1)
	throw new Error("Expected exactly one embedded Safari extension");
const extension = path.join(plugins, extensions[0]);
const extInfo = path.join(extension, "Contents/Info.plist");
const extensionId = plist(extInfo, "CFBundleIdentifier");
if (extensionId !== `${appId}.extension`)
	throw new Error("Extension identifier does not belong to Enhanced");
const group = plist(info, "US_SHARED_GID");
if (
	group !== plist(extInfo, "US_SHARED_GID-macos") ||
	!group.includes(".local.userscripts-enhanced")
)
	throw new Error("Unexpected or mismatched App Group");
for (const bundle of [app, extension]) {
	const xml = execFileSync(
		"/usr/bin/codesign",
		["-d", "--entitlements", "-", "--xml", bundle],
		{ encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
	);
	const entitlements = JSON.parse(
		execFileSync(
			"/usr/bin/plutil",
			["-convert", "json", "-o", "-", "--", "-"],
			{ input: xml, encoding: "utf8" },
		),
	);
	const groups = entitlements["com.apple.security.application-groups"];
	if (!Array.isArray(groups) || groups.length !== 1 || groups[0] !== group)
		throw new Error(
			"Signed App Group does not match the configured Enhanced container",
		);
	if (entitlements["com.apple.security.app-sandbox"] !== true)
		throw new Error("App Sandbox entitlement is missing");
}
const manifest = JSON.parse(
	readFileSync(
		path.join(extension, "Contents/Resources/manifest.json"),
		"utf8",
	),
);
if (manifest.manifest_version !== 2 || manifest.background.persistent !== false)
	throw new Error("Unexpected Safari architecture");
if (!manifest.permissions.includes("alarms"))
	throw new Error("Missing update scheduler permission");
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], {
	stdio: "pipe",
});
console.log(
	JSON.stringify(
		{
			app: path.resolve(app),
			appId,
			extensionId,
			group,
			version: plist(info, "CFBundleShortVersionString"),
			build: plist(info, "CFBundleVersion"),
			signature: "verified",
			manifest: 2,
		},
		null,
		2,
	),
);

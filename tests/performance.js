import { performance } from "node:perf_hooks";
import { writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import { MenuRuntime } from "../src/ext/content-scripts/menu-runtime.js";
const results = [];
for (const [scripts, frames] of [
	[0, 1],
	[1, 1],
	[20, 1],
	[50, 1],
	[20, 5],
]) {
	const start = performance.now();
	const runtimes = Array.from(
		{ length: frames },
		(_, frame) =>
			new MenuRuntime({ documentId: `document-${frame}`, notify() {} }),
	);
	for (const runtime of runtimes)
		for (let i = 0; i < scripts; i++) {
			const api = runtime.forScript({
				scriptId: `script-${i}`,
				filename: `script-${i}.user.js`,
				name: `Script ${i}`,
				revision: "test",
			});
			for (let command = 0; command < 7; command++)
				api.GM_registerMenuCommand(`Command ${command}`, () => {});
		}
	const registrationMs = performance.now() - start;
	await Promise.resolve();
	const samples = [];
	let bytes = 0;
	for (let i = 0; i < 1000; i++) {
		const sample = performance.now();
		const serialized = JSON.stringify(
			runtimes.map((runtime) => runtime.snapshot()),
		);
		bytes = Buffer.byteLength(serialized);
		samples.push(performance.now() - sample);
	}
	samples.sort((a, b) => a - b);
	results.push({
		scripts,
		frames,
		commands: scripts * frames * 7,
		registrationMs,
		snapshotP50Ms: samples[500],
		snapshotP95Ms: samples[950],
		bytes,
	});
}
global.gc?.();
const before = process.memoryUsage().heapUsed;
const runtime = new MenuRuntime({ documentId: "soak", notify() {} });
const api = runtime.forScript({
	scriptId: "soak",
	filename: "soak.user.js",
	name: "Soak",
	revision: "test",
});
const start = performance.now();
for (let i = 0; i < 100000; i++) {
	const id = api.GM_registerMenuCommand("Temporary", () => {});
	api.GM_unregisterMenuCommand(id);
}
await Promise.resolve();
global.gc?.();
const soak = {
	iterations: 100000,
	durationMs: performance.now() - start,
	remainingScriptsWithCommands: runtime.snapshot().scripts.length,
	heapDeltaBytes: process.memoryUsage().heapUsed - before,
};
const report = {
	measuredAt: new Intl.DateTimeFormat("zh-CN", {
		timeZone: "Asia/Taipei",
		dateStyle: "full",
		timeStyle: "long",
	}).format(new Date()),
	environment: {
		node: process.version,
		platform: process.platform,
		arch: process.arch,
		cpu: os.cpus()[0].model,
	},
	results,
	soak,
	scope:
		"Node menu registry and JSON serialization only. Safari browser/native IPC, CPU, UI latency and long browsing sessions remain unmeasured.",
};
await mkdir("docs/reports", { recursive: true });
await writeFile(
	"docs/reports/performance.json",
	JSON.stringify(report, null, 2) + "\n",
);
const rows = results
	.map(
		(r) =>
			`| ${r.scripts} | ${r.frames} | ${r.commands} | ${r.registrationMs.toFixed(3)} | ${r.snapshotP50Ms.toFixed(3)} | ${r.snapshotP95Ms.toFixed(3)} | ${r.bytes} |`,
	)
	.join("\n");
await writeFile(
	"docs/reports/performance.md",
	`# 菜单运行时测量\n\n${report.measuredAt} · ${report.environment.node} · ${report.environment.cpu}\n\n实际运行 Node 菜单注册表及 JSON 序列化，每组 1,000 次快照。不是 Safari IPC 或浏览器性能报告。\n\n| 每 frame 脚本 | Frames | 命令总数 | 注册 ms | 快照 p50 ms | 快照 p95 ms | JSON bytes |\n|---|---|---|---|---|---|---|\n${rows}\n\n100,000 次注册/注销：${soak.durationMs.toFixed(2)} ms；最终带命令脚本 ${soak.remainingScriptsWithCommands}；GC 后 heap 变化 ${soak.heapDeltaBytes} bytes。短时测试不能证明浏览器长时间无泄漏。\n\nSafari 空页面/单脚本/20/50 脚本、iframe、SPA、多窗口与长时间 CPU/内存数据尚未测量，需先启用扩展。\n`,
);
console.log(JSON.stringify(report, null, 2));

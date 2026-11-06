import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, readdir } from "node:fs/promises";
import { createScriptMenus } from "../scripts/script-menu-bridge.js";
import { speedMasterDOM } from "./helpers/speedmaster-dom.js";
import { parseHeader } from "../src/ext/shared/metadata.js";

const directory = new URL("./local/final-scripts/", import.meta.url);

test("menu bridge supports absent APIs, synchronous IDs, current closures and cleanup", () => {
	const absent = createScriptMenus({});
	assert.equal(absent.available, false);
	assert.doesNotThrow(() => {
		absent.set("panel", "Open", () => {});
		absent.clear();
	});
	const calls = [],
		removed = [];
	let value = 0;
	const api = createScriptMenus({
		register: (name, fn) => {
			calls.push({ name, fn });
			return calls.length;
		},
		unregister: (id) => removed.push(id),
	});
	api.set("panel", "Open", () => value++);
	api.set("panel", "Open", () => (value += 2));
	assert.equal(calls.length, 1);
	calls[0].fn();
	assert.equal(value, 2);
	api.set("panel", "Close", () => {});
	assert.deepEqual(removed, [1]);
	api.clear();
	assert.deepEqual(removed, [1, 2]);
});
test("Promise menu registration is removed even if its ID arrives after page cleanup", async () => {
	let reply;
	const removed = [];
	const api = createScriptMenus({
		register: () => new Promise((resolve) => (reply = resolve)),
		unregister: async (id) => removed.push(id),
	});
	api.set("panel", "Open", () => {});
	api.clear();
	reply(42);
	await new Promise(setImmediate);
	assert.deepEqual(removed, [42]);
});
test("menu API failures are reported and cannot stop the script's fallback UI", async () => {
	const errors = [];
	const api = createScriptMenus({
		register: () => {
			throw Error("not supported");
		},
		report: (error) => errors.push(error.message),
	});
	assert.doesNotThrow(() => api.set("panel", "Open", () => {}));
	assert.deepEqual(errors, ["not supported"]);
});
test("all final scripts are standalone, retain original identities and guard optional menus", async () => {
	const files = await readdir(directory);
	assert.equal(files.length, 3);
	for (const file of files) {
		const source = await readFile(
			path.join(fileURLToPath(directory), file),
			"utf8",
		);
		new vm.Script(source);
		const metadata = parseHeader(source).metadata;
		assert.ok(metadata.grant.includes("GM.registerMenuCommand"));
		assert.ok(metadata.grant.includes("GM_registerMenuCommand"));
		assert.ok(!metadata.grant.includes("none"));
		assert.match(source, /typeof GM_registerMenuCommand === 'function'/);
		assert.match(source, /typeof GM\.registerMenuCommand === 'function'/);
		assert.ok(
			!metadata["inject-into"],
			"do not force a manager-specific world",
		);
	}
});
test("final SpeedMaster retains automatic original panel and controls with no GM menu APIs", async () => {
	const source = await readFile(
		new URL("SpeedMaster Safari — 视频倍速面板.user.js", directory),
		"utf8",
	);
	const dom = speedMasterDOM(),
		video = dom.video({ paused: false });
	const environment = { ...dom.environment, console };
	environment.window = environment;
	vm.runInNewContext(source, environment);
	assert.equal(dom.findHost().style.display, "block");
	const buttons = [];
	const collect = (node) => {
		if (node.dataset?.rate) buttons.push(node);
		Array.from(node.children).forEach(collect);
	};
	collect(dom.shadowRootFor(dom.findHost()));
	buttons.find((button) => button.dataset.rate === "1.5").onclick();
	assert.equal(video.playbackRate, 1.5);
});
async function runFinalSpeedMaster(preferences) {
	const source = await readFile(
		new URL("SpeedMaster Safari — 视频倍速面板.user.js", directory),
		"utf8",
	);
	const dom = speedMasterDOM();
	dom.video({ paused: false });
	const commands = new Map();
	let id = 0;
	const environment = {
		...dom.environment,
		console,
		GM: {
			registerMenuCommand: async (name, fn) => {
				commands.set(++id, { name, fn });
				return id;
			},
			unregisterMenuCommand: async (id) => commands.delete(id),
		},
	};
	if (preferences) environment.GM_info = { preferences };
	environment.window = environment;
	vm.runInNewContext(source, environment);
	return { dom, commands };
}
test("final SpeedMaster with menus still opens its panel automatically by default", async () => {
	const { dom, commands } = await runFinalSpeedMaster({ autoPopup: true });
	assert.equal(dom.findHost().style.display, "block");
	assert.equal(commands.size, 7);
	[...commands.values()].find((entry) => entry.name === "隐藏面板").fn();
	assert.equal(dom.findHost().style.display, "none");
});
test("final SpeedMaster honours autoPopup=false and opens its panel only from the menu", async () => {
	const { dom, commands } = await runFinalSpeedMaster({ autoPopup: false });
	assert.equal(dom.findHost(), undefined);
	assert.equal(commands.size, 7);
	[...commands.values()].find((entry) => entry.name === "显示面板").fn();
	assert.equal(dom.findHost().style.display, "block");
	[...commands.values()].find((entry) => entry.name === "隐藏面板").fn();
	assert.equal(dom.findHost().style.display, "none");
	await new Promise(setImmediate);
	dom.windowEvents.dispatchEvent({ type: "pagehide", persisted: true });
	await new Promise(setImmediate);
	assert.equal(commands.size, 0);
});

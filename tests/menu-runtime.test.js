import test from "node:test";
import assert from "node:assert/strict";
import { MenuRuntime } from "../src/ext/content-scripts/menu-runtime.js";

const descriptor = (scriptId = "speed") => ({
	scriptId,
	filename: `${scriptId}.user.js`,
	name: "Video",
	revision: "rev1",
});
function setup() {
	let updates = 0;
	const runtime = new MenuRuntime({
		documentId: "doc1",
		notify: () => updates++,
	});
	const api = runtime.forScript(descriptor());
	const execute = (commandId, extra = {}) =>
		runtime.execute({
			documentId: "doc1",
			scriptId: "speed",
			commandId,
			...extra,
		});
	return { runtime, api, execute, updates: () => updates };
}

test("legacy registration is synchronous and routes to the original closure", async () => {
	const { api, runtime, execute } = setup();
	let value = 0;
	const id = api.GM_registerMenuCommand("1.5×", () => (value = 1.5));
	assert.equal(typeof id, "string");
	assert.equal(id instanceof Promise, false);
	assert.equal(runtime.snapshot().scripts[0].commands[0].title, "1.5×");
	assert.equal((await execute(id)).ok, true);
	assert.equal(value, 1.5);
	assert.doesNotThrow(() => structuredClone(runtime.snapshot()));
	assert.doesNotMatch(JSON.stringify(runtime.snapshot()), /callback/);
});

test("modern APIs have Promise semantics, unregister returns undefined", async () => {
	const { api, runtime } = setup();
	const result = api.registerMenuCommand("Async", async () => {});
	assert.ok(result instanceof Promise);
	const id = await result;
	assert.equal(await api.unregisterMenuCommand(id), undefined);
	assert.deepEqual(runtime.snapshot().scripts, []);
});

test("different commands and scripts retain duplicate names", async () => {
	const { runtime, api, execute } = setup();
	const calls = [];
	const a = api.GM_registerMenuCommand("Settings", () => calls.push("a"));
	const b = api.GM_registerMenuCommand("Settings", () => calls.push("b"));
	const other = runtime.forScript(descriptor("other"));
	const c = other.GM_registerMenuCommand("Settings", () => calls.push("c"));
	assert.notEqual(a, b);
	assert.equal(runtime.snapshot().scripts.length, 2);
	await execute(b);
	await execute(c, { scriptId: "other" });
	assert.deepEqual(calls, ["b", "c"]);
});

test("updates preserve ID, replace callback, and retain registration time", async () => {
	const { api, execute, runtime } = setup();
	let value = "old";
	const id = api.GM_registerMenuCommand("Old", () => (value = "wrong"), "o");
	const time = runtime.snapshot().scripts[0].commands[0].registeredAt;
	assert.equal(
		api.GM_registerMenuCommand("New", () => (value = "new"), {
			id,
			autoClose: false,
			title: "tip",
			accessKey: "n",
		}),
		id,
	);
	const command = runtime.snapshot().scripts[0].commands[0];
	assert.equal(command.registeredAt, time);
	assert.equal(command.title, "New");
	assert.equal(command.options.autoClose, false);
	await execute(id);
	assert.equal(value, "new");
	api.GM_unregisterMenuCommand(id);
	assert.equal((await execute(id)).ok, false);
});

test("unknown options ID creates a fresh command", () => {
	const { api } = setup();
	assert.notEqual(
		api.GM_registerMenuCommand("A", () => {}, { id: "nonexistent" }),
		"nonexistent",
	);
});

test("callback exceptions and rejected Promises reach the popup", async () => {
	const { api, execute } = setup();
	for (const callback of [
		() => {
			throw new Error("sync failure");
		},
		async () => {
			throw new Error("async failure");
		},
	]) {
		const id = api.GM_registerMenuCommand("Fail", callback);
		const result = await execute(id);
		assert.equal(result.ok, false);
		assert.match(result.error, /failure/);
	}
});

test("rapid double clicks and a busy title update cannot duplicate callback execution", async () => {
	const { api, execute, runtime } = setup();
	let release;
	let count = 0;
	const gate = new Promise((resolve) => (release = resolve));
	const id = api.GM_registerMenuCommand("Wait", async () => {
		count++;
		await gate;
	});
	const first = execute(id);
	assert.equal(runtime.snapshot().scripts[0].commands[0].busy, true);
	api.GM_registerMenuCommand("Still waiting", () => count++, { id });
	assert.equal((await execute(id)).ok, false);
	assert.equal(count, 1);
	release();
	assert.equal((await first).ok, true);
	assert.equal(runtime.snapshot().scripts[0].commands[0].busy, false);
});

test("document generations, pagehide, BFCache and disposal", async () => {
	const { runtime, api, execute } = setup();
	let count = 0;
	const id = api.GM_registerMenuCommand("Run", () => count++);
	assert.equal((await execute(id, { documentId: "old" })).ok, false);
	runtime.suspend(true);
	assert.deepEqual(runtime.snapshot().scripts, []);
	assert.equal((await execute(id)).ok, false);
	runtime.suspend(false);
	assert.equal((await execute(id)).ok, true);
	runtime.dispose();
	assert.deepEqual(runtime.snapshot().scripts, []);
	assert.equal((await execute(id)).ok, false);
	assert.equal(count, 1);
});

test("disable is irreversible in this document, other scripts survive", async () => {
	const { runtime, api, execute } = setup();
	const id = api.GM_registerMenuCommand("Run", () => {});
	runtime
		.forScript(descriptor("other"))
		.GM_registerMenuCommand("Other", () => {});
	runtime.revoke("speed.user.js");
	assert.equal((await execute(id)).ok, false);
	assert.throws(() => api.GM_registerMenuCommand("Again", () => {}), /revoked/);
	assert.equal(runtime.snapshot().scripts.length, 1);
	runtime.revoke();
	assert.equal(runtime.snapshot().scripts.length, 0);
});

test("invalid arguments, unsupported option and size limits fail explicitly", () => {
	const { api } = setup();
	for (const args of [
		["", () => {}],
		["x", null],
		["x", () => {}, null],
		["x", () => {}, { id: {} }],
		["x", () => {}, { clickedFrame: true }],
	]) {
		assert.throws(() => api.GM_registerMenuCommand(...args));
	}
	for (let i = 0; i < 200; i++) api.GM_registerMenuCommand(String(i), () => {});
	assert.throws(
		() => api.GM_registerMenuCommand("overflow", () => {}),
		/limit/,
	);
});

test("registration bursts coalesce notifications; snapshots need no DOM scan", async () => {
	const { api, runtime, updates } = setup();
	for (let i = 0; i < 20; i++) api.GM_registerMenuCommand(String(i), () => {});
	await Promise.resolve();
	assert.equal(updates(), 1);
	for (let i = 0; i < 50; i++) runtime.snapshot();
	await Promise.resolve();
	assert.equal(updates(), 1);
});

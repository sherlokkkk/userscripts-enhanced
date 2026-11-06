import test from "node:test";
import assert from "node:assert/strict";
import { createScriptMenus } from "../scripts/script-menu-bridge.js";

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

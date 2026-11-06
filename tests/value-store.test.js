import test from "node:test";
import assert from "node:assert/strict";
import { createValueStore } from "../src/ext/content-scripts/value-store.js";

function backend(initial = {}) {
	const data = structuredClone(initial);
	const handlers = new Set();
	const state = { fail: false };
	const changes = {
		addListener: (fn) => handlers.add(fn),
		removeListener: (fn) => handlers.delete(fn),
	};
	const storage = {
		get: async () => structuredClone(data),
		set: async (items) => {
			if (state.fail) throw new Error("disk quota");
			const events = {};
			for (const [key, value] of Object.entries(items)) {
				events[key] = { oldValue: data[key], newValue: structuredClone(value) };
				data[key] = structuredClone(value);
			}
			for (const fn of handlers) fn(events, "local");
		},
	};
	return { data, handlers, changes, storage, state };
}
const make = (b, scriptId, instanceId) =>
	createValueStore({ ...b, scriptId, instanceId, reportError: () => {} });

test("prehydration, synchronous getters, defaults and durable Promise writes", async () => {
	const b = backend({
		"UE_VALUE:A:existing": { v: 1, data: 7, writer: "older" },
	});
	const { api } = await make(b, "A", "one");
	assert.equal(api.GM_getValue("existing"), 7);
	assert.equal(api.GM_getValue("absent", "default"), "default");
	assert.equal(api.GM_setValue("count", 1), undefined);
	assert.equal(api.GM_getValue("count"), 1);
	assert.equal(api.GM_getValue("count") instanceof Promise, false);
	assert.ok(api.getValue("count") instanceof Promise);
	assert.equal(await api.setValue("count", 2), undefined);
	assert.equal(b.data["UE_VALUE:A:count"].data, 2);
});

test("same script syncs across tabs; other scripts cannot see its values", async () => {
	const b = backend();
	const a = await make(b, "A", "tab1");
	const a2 = await make(b, "A", "tab2");
	const other = await make(b, "B", "tab3");
	const events = [];
	a.api.GM_addValueChangeListener("settings", (...args) => events.push(args));
	a2.api.GM_addValueChangeListener("settings", (...args) => events.push(args));
	await a.api.setValue("settings", { speed: 1.5 });
	assert.deepEqual(a2.api.GM_getValue("settings"), { speed: 1.5 });
	assert.equal(other.api.GM_getValue("settings"), undefined);
	assert.deepEqual(
		events.map((event) => event[3]),
		[false, true],
	);
	const result = a2.api.GM_getValue("settings");
	result.speed = 99;
	assert.equal(a2.api.GM_getValue("settings").speed, 1.5);
});

test("concurrent writes preserve independent keys; same-key writes serialize", async () => {
	const b = backend();
	const a = await make(b, "A", "1");
	const a2 = await make(b, "A", "2");
	await Promise.all([a.api.setValue("left", 1), a2.api.setValue("right", 2)]);
	assert.deepEqual(a.api.GM_listValues().sort(), ["left", "right"]);
	await Promise.all([
		a.api.setValue("counter", 1),
		a.api.setValue("counter", 2),
		a.api.setValue("counter", 3),
	]);
	assert.equal(a.api.GM_getValue("counter"), 3);
	assert.equal(a2.api.GM_getValue("counter"), 3);
});

test("delete synchronizes remote flag, removes data and notifies with undefined", async () => {
	const b = backend();
	const a = await make(b, "A", "1");
	const a2 = await make(b, "A", "2");
	await a.api.setValue("x", [1, true, null]);
	const events = [];
	a2.api.GM_addValueChangeListener("x", (...args) => events.push(args));
	await a.api.deleteValue("x");
	assert.equal(a2.api.GM_getValue("x", "deleted"), "deleted");
	assert.deepEqual(a.api.GM_listValues(), []);
	assert.deepEqual(events, [["x", [1, true, null], undefined, true]]);
	assert.equal(b.data["UE_VALUE:A:x"].data, null);
});

test("listener unregister, exceptions and disposal release subscriptions", async () => {
	const b = backend();
	const a = await make(b, "A", "1");
	let called = 0;
	const id = a.api.GM_addValueChangeListener("x", () => called++);
	a.api.GM_removeValueChangeListener(id);
	await a.api.setValue("x", 1);
	assert.equal(called, 0);
	a.api.GM_addValueChangeListener("x", () => {
		throw new Error("listener failure");
	});
	await assert.doesNotReject(a.api.setValue("x", 2));
	a.dispose();
	assert.equal(b.handlers.size, 0);
	await assert.rejects(a.api.setValue("x", 3), /disposed/);
});

test("failed persistence rejects, restores cache and allows retry", async () => {
	const b = backend();
	const a = await make(b, "A", "1");
	await a.api.setValue("x", "before");
	b.state.fail = true;
	await assert.rejects(a.api.setValue("x", "after"), /quota/);
	assert.equal(a.api.GM_getValue("x"), "before");
	b.state.fail = false;
	await a.api.setValue("x", "retry");
	assert.equal(a.api.GM_getValue("x"), "retry");
});

test("unsupported types fail instead of silently losing data; __proto__ keys remain data", async () => {
	const b = backend();
	const a = await make(b, "A", "1");
	const cyclic = {};
	cyclic.self = cyclic;
	for (const value of [undefined, 1n, () => {}, new Date(), cyclic, NaN]) {
		assert.throws(() => a.api.GM_setValue("x", value), /JSON|plain/);
	}
	await a.api.setValue("__proto__", { ok: true });
	assert.deepEqual(a.api.GM_getValue("__proto__"), { ok: true });
	assert.equal({}.ok, undefined);
});

test("data survives new runtime and offline operation", async () => {
	const b = backend();
	const first = await make(b, "A", "1");
	await first.api.setValue("persisted", { a: [1, false, "中文"] });
	first.dispose();
	const second = await make(b, "A", "2");
	assert.deepEqual(await second.api.getValue("persisted"), {
		a: [1, false, "中文"],
	});
});

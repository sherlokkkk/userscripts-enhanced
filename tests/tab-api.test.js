import test from "node:test";
import assert from "node:assert/strict";
import { createTabRouter } from "../src/ext/background/tab-api.js";
import { createTabAPI } from "../src/ext/content-scripts/tab-runtime.js";

const event = () => {
	const list = new Set();
	return {
		addListener: (fn) => list.add(fn),
		removeListener: (fn) => list.delete(fn),
		emit: async (...args) => Promise.all([...list].map((fn) => fn(...args))),
	};
};
function setup() {
	const data = {},
		live = new Map([
			[1, { id: 1 }],
			[2, { id: 2 }],
		]);
	const removed = event(),
		messages = event();
	let count = 2;
	const browser = {
		runtime: { id: "extension", onMessage: messages },
		storage: {
			session: {
				get: async (key) =>
					key === null
						? structuredClone(data)
						: { [key]: structuredClone(data[key]) },
				set: async (items) => Object.assign(data, structuredClone(items)),
				remove: async (keys) => {
					for (const key of keys) delete data[key];
				},
			},
		},
		tabs: {
			onRemoved: removed,
			query: async () => [...live.values()],
			create: async (options) => {
				const tab = { ...options, id: ++count };
				live.set(tab.id, tab);
				return tab;
			},
			remove: async (id) => {
				live.delete(id);
				await removed.emit(id);
			},
			sendMessage: async (_tabId, message) =>
				messages.emit(message, { id: "extension" }),
		},
	};
	const allowed = { value: true };
	const router = createTabRouter({
		browser,
		authorize: async () => {
			if (!allowed.value) throw new Error("not granted");
		},
	});
	const sender = (tabId = 1, frameId = 0) => ({
		id: "extension",
		tab: { id: tabId, windowId: 1 },
		frameId,
		url: "https://example.test/",
	});
	const send = (scriptId, action, extra = {}, origin = sender()) =>
		router(
			{ name: `UE_TAB_${action}`, identity: { scriptId }, ...extra },
			origin,
		);
	return { browser, allowed, data, live, send, sender, router };
}

test("tab data persists across background state and is isolated by script and tab", async () => {
	const t = setup();
	assert.equal((await t.send("A", "SAVE", { data: { speed: 2 } })).ok, true);
	assert.deepEqual((await t.send("A", "GET")).data, { speed: 2 });
	assert.deepEqual((await t.send("B", "GET")).data, {});
	assert.deepEqual((await t.send("A", "GET", {}, t.sender(2))).data, {});
	assert.deepEqual({ ...(await t.send("A", "ALL")).data }, { 1: { speed: 2 } });
	await t.browser.tabs.remove(1);
	assert.deepEqual({ ...(await t.send("A", "ALL", {}, t.sender(2))).data }, {});
});

test("open returns an opaque handle, honors background option, and only its owner may close", async () => {
	const t = setup();
	const result = await t.send("A", "OPEN", {
		url: "https://new.test",
		active: false,
	});
	assert.equal(typeof result.handle, "string");
	assert.equal(t.live.get(3).active, false);
	assert.equal(
		(await t.send("B", "CLOSE", { handle: result.handle })).ok,
		false,
	);
	assert.equal(
		(await t.send("A", "CLOSE", { handle: result.handle }, t.sender(1, 5))).ok,
		false,
	);
	assert.equal(
		(await t.send("A", "CLOSE", { handle: result.handle })).ok,
		true,
	);
	assert.equal(t.live.has(3), false);
});

test("dangerous schemes and missing grants fail before opening a tab", async () => {
	const t = setup();
	for (const url of [
		"javascript:alert(1)",
		"file:///etc/passwd",
		"data:text/html,x",
	])
		assert.equal((await t.send("A", "OPEN", { url })).ok, false);
	t.allowed.value = false;
	assert.equal(
		(await t.send("A", "OPEN", { url: "https://example.test" })).ok,
		false,
	);
	assert.equal(t.live.size, 2);
});

test("legacy close control, onclose and Promise API execute through the background", async () => {
	const t = setup();
	t.browser.runtime.sendMessage = (message) => t.router(message, t.sender());
	const errors = [];
	const context = createTabAPI({
		browser: t.browser,
		identity: { scriptId: "A" },
		baseURL: "https://example.test",
		reportError: (error) => errors.push(error),
	});
	const control = context.api.GM_openInTab("/video", true);
	assert.equal(control instanceof Promise, false);
	let closed = false;
	control.onclose = () => (closed = true);
	await new Promise(setImmediate);
	control.close();
	await new Promise(setImmediate);
	assert.equal(control.closed, true);
	assert.equal(closed, true);
	assert.equal(errors.length, 0);
	await context.api.saveTab({ a: 1 });
	assert.deepEqual(await context.api.getTab(), { a: 1 });
	const modern = await context.api.openInTab("https://other.test", {
		active: false,
	});
	assert.equal(typeof modern.close, "function");
	context.dispose();
});

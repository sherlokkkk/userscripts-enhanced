import test from "node:test";
import assert from "node:assert/strict";
import { createMenuRouter } from "../src/ext/background/menu-router.js";
import { MenuRuntime } from "../src/ext/content-scripts/menu-runtime.js";

function setup() {
	const state = {
		enabled: true,
		allowed: new Set(["speed"]),
		calls: [],
		sent: [],
		tabs: new Map(),
		frames: new Map(),
	};
	const ui = {
		id: "extension",
		url: "safari-web-extension://extension/dist/entry-ext-action-popup.html",
	};
	const browser = {
		runtime: {
			id: "extension",
			getURL: (path) => `safari-web-extension://extension${path}`,
			sendMessage: async (m) => state.sent.push(m),
		},
		webNavigation: {
			getAllFrames: async ({ tabId }) =>
				[...(state.frames.get(tabId)?.keys() ?? [])].map((frameId) => ({
					frameId,
				})),
		},
		tabs: {
			get: async (id) => {
				if (!state.tabs.has(id)) throw new Error("Tab closed");
				return state.tabs.get(id);
			},
			query: async () => [...state.tabs.values()],
			sendMessage: async (tabId, m, { frameId }) => {
				const runtime = state.frames.get(tabId)?.get(frameId);
				if (!runtime) throw new Error("No receiver");
				if (m.name === "UE_MENU_SNAPSHOT")
					return structuredClone(runtime.snapshot());
				if (m.name === "UE_MENU_EXECUTE") return runtime.execute(m);
				if (m.name === "UE_MENU_REVOKE") return runtime.revoke(m.filename);
			},
		},
	};
	const makeRouter = () =>
		createMenuRouter({
			browser,
			isEnabled: async () => state.enabled,
			validateScripts: async () => state.allowed,
		});
	const add = (tabId, frameId, doc = `document-${tabId}-${frameId}`) => {
		state.tabs.set(tabId, { id: tabId, active: true, windowId: tabId });
		if (!state.frames.has(tabId)) state.frames.set(tabId, new Map());
		const runtime = new MenuRuntime({ documentId: doc, notify: () => {} });
		state.frames.get(tabId).set(frameId, runtime);
		runtime
			.forScript({
				scriptId: "speed",
				filename: "speed.user.js",
				name: "Speed",
				revision: "r1",
			})
			.GM_registerMenuCommand("1.5x", () =>
				state.calls.push(`${tabId}:${frameId}:${doc}`),
			);
		return runtime;
	};
	const router = makeRouter();
	const list = async (tabId, target = router) =>
		target.handle({ name: "UE_MENU_LIST", tabId }, ui);
	const run = (script, target = router, sender = ui, event) =>
		target.handle(
			{
				...script,
				name: "UE_MENU_RUN",
				commandId: script.commands[0].commandId,
				event,
			},
			sender,
		);
	return { state, browser, ui, router, add, list, run, makeRouter };
}

test("tab, frame and window isolation: identical IDs route only to exact callback", async () => {
	const t = setup();
	t.add(1, 0);
	t.add(1, 5);
	t.add(2, 0);
	const a = await t.list(1);
	assert.equal(a.scripts.length, 2);
	assert.deepEqual(
		a.scripts.map((s) => s.tabId),
		[1, 1],
	);
	await t.run(a.scripts[1]);
	assert.deepEqual(t.state.calls, ["1:5:document-1-5"]);
	const b = await t.list(2);
	await t.run(b.scripts[0]);
	assert.deepEqual(t.state.calls, ["1:5:document-1-5", "2:0:document-2-0"]);
});

test("old popup routes cannot execute after top-level or iframe navigation", async () => {
	const t = setup();
	t.add(1, 0);
	t.add(1, 5);
	const before = await t.list(1);
	t.add(1, 0, "new-main");
	t.add(1, 5, "new-frame");
	for (const script of before.scripts)
		assert.equal((await t.run(script)).ok, false);
	assert.deepEqual(t.state.calls, []);
	const after = await t.list(1);
	assert.equal((await t.run(after.scripts[1])).ok, true);
});

test("background restart and repeated popup open do not lose or reexecute scripts", async () => {
	const t = setup();
	t.add(1, 0);
	for (let i = 0; i < 10; i++) {
		const restarted = t.makeRouter();
		const result = await t.list(1, restarted);
		assert.equal(result.scripts.length, 1);
		assert.equal((await t.run(result.scripts[0], restarted)).ok, true);
	}
	assert.equal(t.state.calls.length, 10);
});

test("closing a frame or tab invalidates routes", async () => {
	const t = setup();
	t.add(1, 0);
	const { scripts } = await t.list(1);
	t.state.frames.get(1).delete(0);
	assert.equal((await t.run(scripts[0])).ok, false);
	t.state.tabs.delete(1);
	assert.equal((await t.run(scripts[0])).ok, false);
});

test("native state rejects disabled, edited or deleted scripts and global disable", async () => {
	const t = setup();
	t.add(1, 0);
	const { scripts } = await t.list(1);
	t.state.allowed.clear();
	assert.equal((await t.run(scripts[0])).ok, false);
	assert.deepEqual((await t.list(1)).scripts, []);
	t.state.allowed.add("speed");
	t.state.enabled = false;
	assert.equal((await t.run(scripts[0])).ok, false);
	assert.deepEqual((await t.list(1)).scripts, []);
	assert.deepEqual(t.state.calls, []);
});

test("content, web pages, spoofed extension origins and wrong tab addresses cannot control commands", async () => {
	const t = setup();
	t.add(1, 0);
	const { scripts } = await t.list(1);
	for (const sender of [
		{ id: "extension", url: "https://evil.example", tab: { id: 1 } },
		{ id: "other", url: t.ui.url },
		{ id: "extension", url: `${t.ui.url}.evil` },
		{ id: "extension" },
	]) {
		assert.equal((await t.run(scripts[0], t.router, sender)).ok, false);
	}
	assert.deepEqual(t.state.calls, []);
	t.state.tabs.get(1).active = false;
	assert.equal((await t.run(scripts[0])).ok, false);
	assert.equal(
		(await t.router.handle({ name: "UE_MENU_LIST", tabId: "1" }, t.ui)).ok,
		false,
	);
});

test("disable broadcast revokes only the selected script across frames and tabs", async () => {
	const t = setup();
	t.add(1, 0);
	t.add(2, 5);
	assert.equal(
		(
			await t.router.handle(
				{ name: "UE_MENU_INVALIDATE", filename: "speed.user.js" },
				t.ui,
			)
		).ok,
		true,
	);
	assert.deepEqual((await t.list(1)).scripts, []);
	assert.deepEqual((await t.list(2)).scripts, []);
});

test("notification derives tab ID from browser sender, never from content payload", async () => {
	const t = setup();
	await t.router.handle(
		{ name: "UE_MENU_CHANGED", tabId: 999 },
		{ id: "extension", tab: { id: 7 }, frameId: 3 },
	);
	assert.deepEqual(t.state.sent, [{ name: "UE_MENU_REFRESH", tabId: 7 }]);
	assert.equal(
		(
			await t.router.handle(
				{ name: "UE_MENU_CHANGED" },
				{ id: "wrong", tab: { id: 7 }, frameId: 0 },
			)
		).ok,
		false,
	);
});

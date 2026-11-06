import test from "node:test";
import assert from "node:assert/strict";
import { script, start } from "./helpers/engine-harness.js";

test("the actual injection entry grants synchronous legacy and Promise APIs and executes menu closures", async () => {
	const t = await start([
		script(
			[
				"GM_registerMenuCommand",
				"GM_unregisterMenuCommand",
				"GM.registerMenuCommand",
				"GM_setValue",
				"GM_getValue",
				"GM.setValue",
				"GM.getValue",
			],
			`
		GM_setValue('speed', 1.5);
		globalThis.initial = GM_getValue('speed');
		globalThis.modern = GM.getValue('speed') instanceof Promise;
		let counter = 0;
		GM_registerMenuCommand('Increment', () => { globalThis.count = ++counter; }, { autoClose: false });
		await GM.registerMenuCommand('Async', async () => { await GM.setValue('speed', 2); globalThis.after = await GM.getValue('speed'); });
	`,
		),
	]);
	assert.deepEqual(t.errors, []);
	assert.equal(t.context.initial, 1.5);
	assert.equal(t.context.modern, true);
	const snapshot = await t.message({ name: "UE_MENU_SNAPSHOT" });
	assert.equal(snapshot.scripts.length, 1);
	assert.equal(snapshot.scripts[0].commands.length, 2);
	for (const command of snapshot.scripts[0].commands) {
		assert.equal(
			(
				await t.message({
					name: "UE_MENU_EXECUTE",
					documentId: snapshot.documentId,
					scriptId: "script",
					commandId: command.commandId,
				})
			).ok,
			true,
		);
	}
	assert.equal(t.context.count, 1);
	assert.equal(t.context.after, 2);
});

test("undeclared APIs are absent and revocation blocks captured API closures", async () => {
	const t = await start([
		script(
			["GM_registerMenuCommand"],
			`globalThis.ungranted = typeof GM_setValue; globalThis.captured = GM_registerMenuCommand; GM_registerMenuCommand('Test', () => {});`,
		),
	]);
	assert.equal(t.context.ungranted, "undefined");
	const captured = t.context.captured;
	await t.message({ name: "UE_MENU_REVOKE", filename: "script.user.js" });
	assert.throws(() => captured("Again", () => {}), /disabled|revoked/);
	assert.equal(
		(await t.message({ name: "UE_MENU_SNAPSHOT" })).scripts.length,
		0,
	);
});

test("pagehide removes command listener and releases hydrated storage listeners", async () => {
	const t = await start([
		script(
			["GM_registerMenuCommand", "GM_getValue"],
			`GM_registerMenuCommand('Test', () => {});`,
		),
	]);
	assert.ok(t.storageHandlers.size > 1);
	for (const callback of t.pageEvents.get("pagehide"))
		callback({ persisted: false });
	assert.equal(await t.message({ name: "UE_MENU_SNAPSHOT" }), undefined);
	assert.equal(t.storageHandlers.size, 1); // The single global enable-state listener belongs to this dying document.
});

test("sandboxed scripts see a consistent top-frame window and a live page location", async () => {
	const t = await start(
		[
			script(
				["GM_registerMenuCommand"],
				`
		document.body.dataset.identity = [window.top === window.self, top === self, window.parent === window, window.frames === window, globalThis === window, this === window].join();
		document.body.dataset.before = location.pathname;
		window.history.pushState({ step: 1 }, "", "/moved");
		document.body.dataset.after = window.location.pathname;
		window.__flag = 1;
		document.body.dataset.flag = String(__flag);
		if (window.top !== window.self) throw new Error("top-frame guard rejected");
		GM_registerMenuCommand("Ready", () => {});
	`,
			),
		],
		{ UE_SCRIPT_PREFS: {} },
	);
	assert.deepEqual(t.errors, []);
	const data = t.host.document.body.dataset;
	assert.equal(data.identity, "true,true,true,true,true,true");
	assert.equal(data.before, "/video");
	assert.equal(data.after, "/moved");
	assert.equal(data.flag, "1");
	const snapshot = await t.message({ name: "UE_MENU_SNAPSHOT" });
	assert.equal(snapshot.scripts[0].commands[0].title, "Ready");
});

test("per-script popup preferences reach GM_info.preferences", async () => {
	const t = await start(
		[
			script(
				["GM_registerMenuCommand"],
				`document.body.dataset.first = String(GM_info.preferences.autoPopup);`,
				"first",
			),
			script(
				["GM_registerMenuCommand"],
				`document.body.dataset.second = String(GM_info.preferences.autoPopup);`,
				"second",
			),
		],
		{ UE_SCRIPT_PREFS: { second: { autoPopup: false } } },
	);
	assert.deepEqual(t.errors, []);
	assert.equal(t.host.document.body.dataset.first, "true");
	assert.equal(t.host.document.body.dataset.second, "false");
});

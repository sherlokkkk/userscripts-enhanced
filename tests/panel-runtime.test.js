import test from "node:test";
import assert from "node:assert/strict";
import { MenuRuntime } from "../src/ext/content-scripts/menu-runtime.js";
import { script, start } from "./helpers/engine-harness.js";
const setup = () => {
	const runtime = new MenuRuntime({ documentId: "doc", notify() {} });
	const api = runtime.forScript({
		scriptId: "script",
		filename: "test.user.js",
		name: "Test",
		revision: "r",
	});
	const execute = (control, value) =>
		runtime.execute({
			documentId: "doc",
			scriptId: "script",
			commandId: runtime
				.snapshot()
				.scripts[0].panel.controls.find((item) => item.id === control)
				.commandId,
			value,
		});
	return { runtime, api, execute };
};
test("panel descriptors contain data only; typed actions call the original callback and survive popup reopens", async () => {
	const { runtime, api, execute } = setup();
	let enabled = false;
	const handle = api.registerPanel({
		version: 1,
		title: "Preferences",
		controls: [
			{
				id: "enabled",
				type: "toggle",
				label: "Enabled",
				value: false,
				onChange: (value) => (enabled = value),
			},
			{
				id: "rate",
				type: "range",
				label: "Speed",
				min: 1,
				max: 2,
				step: 0.25,
				value: 1,
				onChange() {},
			},
			{
				id: "mode",
				type: "select",
				label: "Mode",
				value: "a",
				options: [{ value: "a", label: "A" }],
				onChange() {},
			},
			{ id: "status", type: "text", label: "Status", value: "Idle" },
		],
	});
	assert.equal((await execute("enabled", true)).ok, true);
	assert.equal(enabled, true);
	assert.equal(runtime.snapshot().scripts[0].panel.controls[0].value, true);
	const snapshot = JSON.stringify(runtime.snapshot());
	assert.ok(!snapshot.includes("onChange"));
	assert.equal((await execute("rate", 1.1)).ok, false);
	assert.equal((await execute("mode", "unknown")).ok, false);
	handle.update({ values: { rate: 1.5, status: "Playing" } });
	assert.equal(runtime.snapshot().scripts[0].panel.controls[1].value, 1.5);
	assert.throws(
		() => handle.update({ values: { status: "Changed", rate: 9 } }),
		/Invalid value/,
	);
	assert.equal(
		runtime.snapshot().scripts[0].panel.controls[3].value,
		"Playing",
	);
	const authoritative = api.registerPanel({
		version: 1,
		title: "State",
		controls: [
			{
				id: "enabled",
				type: "toggle",
				label: "Enabled",
				value: false,
				onChange() {
					authoritative.update({ values: { enabled: false } });
				},
			},
		],
	});
	assert.equal((await execute("enabled", true)).ok, true);
	assert.equal(runtime.snapshot().scripts[0].panel.controls[0].value, false);
});
test("invalid panels, disabled controls, stale handles and revoked callbacks fail closed", async () => {
	const { runtime, api, execute } = setup();
	assert.throws(
		() =>
			api.registerPanel({
				version: 1,
				title: "X",
				controls: [{ id: "html", type: "html", label: "X" }],
			}),
		/Unsupported/,
	);
	const definition = {
		version: 1,
		title: "X",
		controls: [
			{
				id: "save",
				type: "button",
				label: "Save",
				disabled: true,
				onClick() {
					throw Error("must not execute");
				},
			},
		],
	};
	const old = api.registerPanel(definition);
	assert.equal((await execute("save")).ok, false);
	const current = api.registerPanel({
		...definition,
		controls: [
			{
				...definition.controls[0],
				disabled: false,
				onClick() {
					throw Error("Rejected by script");
				},
			},
		],
	});
	old.dispose();
	assert.ok(runtime.snapshot().scripts[0].panel);
	assert.match((await execute("save")).error, /Rejected by script/);
	assert.throws(() => old.update({ values: {} }), /replaced/);
	runtime.revoke();
	assert.equal(runtime.snapshot().scripts.length, 0);
	assert.throws(() => current.update({ values: {} }), /revoked/);
});
test("the compiled injection entry exposes UE only for its explicit grant", async () => {
	const granted = await start([
		script(
			["UE.registerPanel"],
			`globalThis.panelVersion = UE.version; globalThis.panelHandle = UE.registerPanel({version:1,title:'Panel',controls:[{id:'open',type:'button',label:'Open',onClick(){globalThis.wasOpened=true;}}]});`,
			"panel",
		),
	]);
	assert.deepEqual(granted.errors, []);
	assert.equal(granted.context.panelVersion, 1);
	const state = await granted.message({ name: "UE_MENU_SNAPSHOT" });
	const result = await granted.message({
		name: "UE_MENU_EXECUTE",
		documentId: state.documentId,
		scriptId: "panel",
		commandId: state.scripts[0].panel.controls[0].commandId,
	});
	assert.equal(result.ok, true);
	assert.equal(granted.context.wasOpened, true);
	const input = script([], "globalThis.panelAPI = typeof UE;");
	input.scriptObject["inject-into"] = "content";
	const ungranted = await start([input]);
	assert.equal(ungranted.context.panelAPI, "undefined");
});

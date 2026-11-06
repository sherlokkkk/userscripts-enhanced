import test from "node:test";
import assert from "node:assert/strict";
import { script, start } from "./helpers/engine-harness.js";

test("script globals, JS and DOM prototypes stay private while native DOM writes remain shared", async () => {
	const t = await start([
		script(
			["GM_getValue"],
			`
		 globalThis.privateName='first';
		 Object.prototype.isolationPollution='first';
		 Object.getPrototypeOf(document.body).isolationPollution='first';
		 document.body.dataset.shared='yes';
		 document.body.style.color='red';
		`,
			"first",
		),
		script(
			["GM_getValue"],
			`
		 globalThis.observed=[typeof privateName,typeof ({}).isolationPollution,typeof document.body.isolationPollution,document.body.dataset.shared,document.body.style.color];
		`,
			"second",
		),
	]);
	assert.deepEqual(t.errors, []);
	assert.equal(t.host.privateName, undefined);
	assert.equal(t.host.Object.prototype.isolationPollution, undefined);
	assert.equal(t.host.HTMLBodyElement.prototype.isolationPollution, undefined);
	assert.equal(
		JSON.stringify(t.realms[1].evaluate("observed")),
		JSON.stringify(["undefined", "undefined", "undefined", "yes", "red"]),
	);
});

test("repeated context-menu execution reuses one realm; revocation rejects captured capabilities", async () => {
	const input = script(
		["GM_getValue", "GM_registerMenuCommand"],
		`globalThis.saved=GM_getValue;GM_registerMenuCommand('test',()=>{});`,
	);
	input.scriptObject["run-at"] = "context-menu";
	const t = await start([input]);
	await t.message({ name: "CONTEXT_RUN", menuItemId: "script.user.js" });
	await t.message({ name: "CONTEXT_RUN", menuItemId: "script.user.js" });
	assert.equal(t.realms.length, 1);
	const saved = t.context.saved;
	await t.message({ name: "UE_MENU_REVOKE", filename: "script.user.js" });
	assert.throws(() => saved("key"), /disabled|revoked/);
	assert.equal(
		(await t.message({ name: "UE_MENU_SNAPSHOT" })).scripts.length,
		0,
	);
});

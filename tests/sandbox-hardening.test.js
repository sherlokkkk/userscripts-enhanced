import test from "node:test";
import assert from "node:assert/strict";
import { script, start } from "./helpers/engine-harness.js";

import { neutralizeImports } from "../src/ext/content-scripts/import-guard.js";

test("every syntactic form of dynamic import() is neutralized", () => {
	for (const source of [
		"import('x')",
		"import ('x')",
		"import\n('x')",
		"import/* c */('x')",
		"import// c\n('x')",
		"import<!-- c\n('x')",
		"x = 1;import('x')",
		"[...import('x')]",
		"`${import('x')}`",
		" import('x')",
		"(0,import('x'))",
	]) {
		assert.match(neutralizeImports(source), /__ueImport__/, source);
		assert.doesNotMatch(neutralizeImports(source), /\bimport\s*\(/, source);
	}
});

test("property names and identifiers containing import are left alone", () => {
	for (const source of [
		"api.import('x')",
		"api?.import('x')",
		"reimport('x')",
		"import_('x')",
		"$import('x')",
		"const important = 1",
	])
		assert.equal(neutralizeImports(source), source);
});

test("scripts run in strict mode by default; compatibility mode runs them sloppy", async () => {
	const strict = await start([
		script(
			["GM_getValue"],
			`try { undeclared = 1; document.body.dataset.strict = "sloppy"; } catch (e) { document.body.dataset.strict = e.name; }`,
			"strict",
		),
	]);
	assert.equal(strict.host.document.body.dataset.strict, "ReferenceError");
	const legacy = await start(
		[
			script(
				["GM_getValue"],
				`undeclared = 2; document.body.dataset.legacy = String(undeclared);`,
				"legacy",
			),
		],
		{ UE_SCRIPT_PREFS: { legacy: { legacyMode: true } } },
	);
	assert.deepEqual(legacy.errors, []);
	assert.equal(legacy.host.document.body.dataset.legacy, "2");
});

test("Function, eval and string timers compile inside the script scope", async () => {
	const t = await start([
		script(
			["GM_getValue"],
			`
		const D = document.body.dataset;
		D.fn = String(Function("return top === window && this === undefined")());
		D.evalValue = String(eval("1 + 2"));
		D.ctor = String((function () {}).constructor === Function);
		setTimeout("document.body.dataset.timer = String(top === window)", 0);
	`,
		),
	]);
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.deepEqual(t.errors, []);
	const data = t.host.document.body.dataset;
	assert.equal(data.fn, "true");
	assert.equal(data.evalValue, "3");
	assert.equal(data.ctor, "true");
	assert.equal(data.timer, "true");
});

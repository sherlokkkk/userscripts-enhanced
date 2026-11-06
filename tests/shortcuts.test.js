import test from "node:test";
import assert from "node:assert/strict";
import {
	detectShortcuts,
	makeShortcut,
	matchesShortcut,
	sameShortcut,
	shortcutId,
	shortcutLabel,
	syntheticEventFields,
} from "../src/ext/shared/shortcuts.js";
import { buildRules } from "../src/ext/content-scripts/keyboard-runtime.js";

const ids = (source) => detectShortcuts(source).map(shortcutId);
const mods = (names = []) =>
	Object.fromEntries(
		["ctrl", "alt", "shift", "meta"].map((n) => [n, names.includes(n)]),
	);

test("detects key/code comparisons with modifiers required on the same line", () => {
	const source = `
		document.addEventListener('keydown', (e) => {
			if (e.altKey && e.shiftKey && e.code === 'KeyM') open();
			else if (e.key === 'Escape') close();
			if (!e.ctrlKey && e.key === ']') faster();
		});`;
	assert.deepEqual(ids(source), ["Alt+Shift+KeyM", "key:Escape", "key:]"]);
});

test("detects keyCode, reversed comparisons, switch cases and combo strings", () => {
	const source = `
		window.addEventListener('keyup', (event) => {
			if (event.keyCode === 27) cancel();
			if ('KeyP' === event.code) print();
			switch (event.key) { case 'n': next(); break; case 'q': prev(); }
		});
		const CONFIG = { toggle: ['Alt+Backquote', 'Ctrl+Shift+KeyH'] };`;
	assert.deepEqual(ids(source), [
		"KeyP",
		"Escape",
		"key:n",
		"key:q",
		"Alt+Backquote",
		"Ctrl+Shift+KeyH",
	]);
});

test("ignores comments, unrelated objects and scripts without keyboard listeners", () => {
	assert.deepEqual(
		ids(`
		document.addEventListener('keydown', handle);
		// Examples: 'Alt+KeyQ', 'F2'
		/* 'Ctrl+KeyZ' */
		if (item.key === 'name') rename();`),
		[],
	);
	assert.deepEqual(ids(`if (e.key === 'a') go();`), []);
});

test("labels and matching treat key- and code-based shortcuts consistently", () => {
	const bracket = makeShortcut({ key: "]" });
	const code = makeShortcut({ code: "BracketRight" });
	assert.equal(sameShortcut(bracket, code), true);
	assert.equal(
		shortcutLabel(
			makeShortcut({ mods: { alt: true, shift: true }, code: "KeyM" }),
		),
		"⌥⇧M",
	);
	assert.equal(
		matchesShortcut(bracket, { key: "]", code: "BracketRight" }),
		true,
	);
	assert.equal(matchesShortcut(bracket, { key: "]", ctrlKey: true }), false);
	assert.deepEqual(
		syntheticEventFields(
			makeShortcut({ mods: { alt: true, shift: true }, code: "KeyM" }),
		),
		{
			key: "M",
			code: "KeyM",
			keyCode: 77,
			which: 77,
			ctrlKey: false,
			altKey: true,
			shiftKey: true,
			metaKey: false,
		},
	);
});

test("rules: a remap delivers the original and frees its key; switching off wins", () => {
	const original = { mods: mods(["alt", "shift"]), code: "KeyM", key: null };
	const to = { mods: mods(["alt"]), code: "KeyB", key: null };
	const rules = buildRules({ "Alt+Shift+KeyM": { original, to } });
	assert.equal(rules.length, 2);
	assert.equal(rules[0].when.code, "KeyB");
	assert.equal(rules[0].deliver.fields.code, "KeyM");
	assert.equal(rules[1].when.code, "KeyM");
	assert.equal(rules[1].deliver, null);
	const off = buildRules({
		"Alt+Shift+KeyM": { original, to, disabled: true },
	});
	assert.deepEqual(
		off.map((rule) => [rule.when.code, rule.deliver]),
		[["KeyM", null]],
	);
	assert.deepEqual(
		buildRules({ bad: { original: { nope: 1 }, disabled: true } }),
		[],
	);
});

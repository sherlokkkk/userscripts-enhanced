import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validGrants } from "../src/ext/shared/utils.js";
import { createPageAPI } from "../src/ext/content-scripts/page-api.js";

test("Swift filtering and editor grant declarations advertise the same APIs", async () => {
	const native = await readFile(
		new URL("../xcode/Ext-Safari/Functions.swift", import.meta.url),
		"utf8",
	);
	const block = native.match(
		/let validGrants: Set<String> = \[([\s\S]*?)\]/,
	)[1];
	const filtered = new Set(
		[...block.matchAll(/"([^"]+)"/g)].map((match) => match[1]),
	);
	assert.deepEqual(
		[...filtered].sort(),
		[...validGrants].filter((grant) => grant !== "none").sort(),
	);
	for (const unsupported of [
		"GM_cookie",
		"GM_webRequest",
		"GM_download",
		"GM_notification",
		"unsafeWindow",
	])
		assert.equal(validGrants.has(unsupported), false);
});

test("DOM APIs return created elements, modern forms return Promises, and logs carry script identity", async () => {
	const children = [],
		logs = [];
	const parent = { append: (element) => children.push(element) };
	const document = {
		head: parent,
		createElement: (tag) => ({
			tagName: tag.toUpperCase(),
			setAttribute(key, value) {
				this[key] = value;
			},
		}),
	};
	const api = createPageAPI({
		document,
		name: "Fixture",
		console: { log: (...args) => logs.push(args) },
	});
	const style = api.GM_addStyle("body { color: red; }");
	assert.equal(style.tagName, "STYLE");
	assert.equal(style.textContent, "body { color: red; }");
	const promise = api.addElement(parent, "p", {
		textContent: "safe text",
		class: "test",
	});
	assert.ok(promise instanceof Promise);
	assert.equal((await promise).textContent, "safe text");
	assert.equal(
		api.GM_addElement("span", { textContent: "another" }).tagName,
		"SPAN",
	);
	assert.throws(() => api.GM_addElement(parent, "<script>"), /Invalid/);
	api.GM_log("message");
	assert.deepEqual(logs, [["[Fixture]", "message"]]);
	assert.equal(children.length, 3);
});

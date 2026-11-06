import test from "node:test";
import assert from "node:assert/strict";
import { parseHeader, metadataWarnings } from "../src/ext/shared/metadata.js";
const header = (lines, newline = "\n") =>
	[
		"// ==UserScript==",
		...lines.map((s) => `// @${s}`),
		"// ==/UserScript==",
		"const value = '中文';",
	].join(newline);

test("BOM, UTF-8, CRLF, repeated matches, empty values and noframes", () => {
	const parsed = parseHeader(
		`\ufeff前缀🙂\n${header(["name 测试", "namespace example", "match https://example.com/*", "match https://example.org/*", "noframes", "empty", "name:zh-TW 測試"], "\r\n")}`,
	);
	assert.equal(parsed.metadata.name[0], "测试");
	assert.deepEqual(parsed.metadata.match, [
		"https://example.com/*",
		"https://example.org/*",
	]);
	assert.deepEqual(parsed.metadata.noframes, [""]);
	assert.deepEqual(parsed.metadata.empty, [""]);
	assert.equal(parsed.metadata["name:zh-TW"][0], "測試");
	assert.equal(parsed.code, "const value = '中文';");
});

test("all task metadata is preserved without pretending to implement directives", () => {
	const keys = [
		"exclude",
		"exclude-match",
		"run-at",
		"grant",
		"connect",
		"require",
		"resource",
		"updateURL",
		"downloadURL",
		"icon",
		"homepage",
		"homepageURL",
		"license",
		"copyright",
		"supportURL",
		"source",
		"inject-into",
		"sandbox",
		"tag",
		"antifeature",
		"run-in",
	];
	const parsed = parseHeader(
		header(["name A", ...keys.map((k) => `${k} value`)]),
	);
	for (const key of keys) assert.equal(parsed.metadata[key][0], "value");
	const warnings = metadataWarnings(parsed.metadata, new Set(["GM_getValue"]));
	assert.ok(warnings.some((warning) => warning.includes("@run-in")));
	assert.equal(
		warnings.some((warning) => warning.includes("@resource")),
		false,
	);
	assert.ok(warnings.some((warning) => warning.includes("Unsupported API")));
});

test("invalid header/name fails and untrusted keys cannot alter prototypes", () => {
	for (const source of [
		undefined,
		"",
		"// no block",
		header(["name "]),
		header(["version 1"]),
	])
		assert.equal(parseHeader(source), null);
	const parsed = parseHeader(
		header(["name A", "__proto__ unsafe", "constructor data"]),
	);
	assert.equal(Object.getPrototypeOf(parsed.metadata), null);
	assert.deepEqual(parsed.metadata.__proto__, ["unsafe"]);
	assert.equal({}.unsafe, undefined);
});

test("userstyle parsing remains supported", () => {
	const parsed = parseHeader(
		"/* ==UserStyle==\n@name Style\n@match https://example.com/*\n==/UserStyle== */\nbody { color: red; }",
	);
	assert.equal(parsed.metadata.name[0], "Style");
	assert.equal(parsed.code, "body { color: red; }");
});

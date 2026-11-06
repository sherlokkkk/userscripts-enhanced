// Keyboard shortcuts of userscripts: representation, matching, labels and a
// static detector. Shared by the content script (detection, rules) and the
// toolbar popup (display, editing). No extension APIs here.
//
// A shortcut is { mods: { ctrl, alt, shift, meta }, code, key }:
// - `code` (KeyboardEvent.code, physical key) when the script compares codes,
// - otherwise `key` (KeyboardEvent.key; letters lower-cased).
// Modifiers must match exactly.

export const MODIFIERS = ["ctrl", "alt", "shift", "meta"];
const MOD_NAMES = { ctrl: "Ctrl", alt: "Alt", shift: "Shift", meta: "Meta" };
const MOD_SYMBOLS = { ctrl: "⌃", alt: "⌥", shift: "⇧", meta: "⌘" };

// US layout: code -> [key, shifted key, keyCode]
const CODES = {
	Backquote: ["`", "~", 192],
	Minus: ["-", "_", 189],
	Equal: ["=", "+", 187],
	BracketLeft: ["[", "{", 219],
	BracketRight: ["]", "}", 221],
	Backslash: ["\\", "|", 220],
	Semicolon: [";", ":", 186],
	Quote: ["'", '"', 222],
	Comma: [",", "<", 188],
	Period: [".", ">", 190],
	Slash: ["/", "?", 191],
	Space: [" ", " ", 32],
	Enter: ["Enter", "Enter", 13],
	Tab: ["Tab", "Tab", 9],
	Escape: ["Escape", "Escape", 27],
	Backspace: ["Backspace", "Backspace", 8],
	Delete: ["Delete", "Delete", 46],
	Insert: ["Insert", "Insert", 45],
	Home: ["Home", "Home", 36],
	End: ["End", "End", 35],
	PageUp: ["PageUp", "PageUp", 33],
	PageDown: ["PageDown", "PageDown", 34],
	ArrowLeft: ["ArrowLeft", "ArrowLeft", 37],
	ArrowUp: ["ArrowUp", "ArrowUp", 38],
	ArrowRight: ["ArrowRight", "ArrowRight", 39],
	ArrowDown: ["ArrowDown", "ArrowDown", 40],
};
const DIGIT_SHIFTED = ")!@#$%^&*(";
for (let i = 0; i < 26; i++) {
	const letter = String.fromCharCode(97 + i);
	CODES[`Key${letter.toUpperCase()}`] = [letter, letter.toUpperCase(), 65 + i];
}
for (let i = 0; i < 10; i++)
	CODES[`Digit${i}`] = [String(i), DIGIT_SHIFTED[i], 48 + i];
for (let i = 1; i <= 24; i++) CODES[`F${i}`] = [`F${i}`, `F${i}`, 111 + i];
const KEY_TO_CODE = new Map();
const KEYCODE_TO_CODE = new Map();
for (const [code, [key, shifted, keyCode]] of Object.entries(CODES)) {
	if (!KEY_TO_CODE.has(key)) KEY_TO_CODE.set(key, code);
	if (!KEY_TO_CODE.has(shifted)) KEY_TO_CODE.set(shifted, code);
	KEYCODE_TO_CODE.set(keyCode, code);
}
const KEY_LABELS = {
	" ": "Space",
	Escape: "Esc",
	ArrowLeft: "←",
	ArrowUp: "↑",
	ArrowRight: "→",
	ArrowDown: "↓",
	Enter: "↩",
	Backspace: "⌫",
	Delete: "⌦",
	Tab: "⇥",
};

const noMods = () => ({ ctrl: false, alt: false, shift: false, meta: false });
const normalizeKey = (key) =>
	typeof key === "string" && key.length === 1 ? key.toLowerCase() : key;

export function makeShortcut({ mods = {}, code = null, key = null } = {}) {
	const result = { mods: noMods(), code: null, key: null };
	for (const name of MODIFIERS) result.mods[name] = mods[name] === true;
	if (typeof code === "string" && code) result.code = code;
	else if (typeof key === "string" && key) result.key = normalizeKey(key);
	return result.code || result.key ? result : null;
}

export function shortcutFromEvent(event) {
	return makeShortcut({
		mods: {
			ctrl: event.ctrlKey,
			alt: event.altKey,
			shift: event.shiftKey,
			meta: event.metaKey,
		},
		code: event.code || null,
		key: event.code ? null : event.key,
	});
}

export function shortcutId(shortcut) {
	const mods = MODIFIERS.filter((name) => shortcut.mods[name]).map(
		(name) => MOD_NAMES[name],
	);
	return [...mods, shortcut.code ? shortcut.code : `key:${shortcut.key}`].join(
		"+",
	);
}

export function codeOf(shortcut) {
	return shortcut.code ?? KEY_TO_CODE.get(shortcut.key) ?? null;
}

export function keyOf(shortcut) {
	if (shortcut.key) return shortcut.key;
	const entry = CODES[shortcut.code];
	if (!entry) return shortcut.code;
	return shortcut.mods.shift ? entry[1] : entry[0];
}

export function shortcutLabel(shortcut) {
	const mods = MODIFIERS.filter((name) => shortcut.mods[name])
		.map((name) => MOD_SYMBOLS[name])
		.join("");
	let key = shortcut.key ?? keyOf(shortcut);
	key = KEY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key);
	return mods + key;
}

// The event a script expects for `shortcut` (used when a user remaps it).
export function syntheticEventFields(shortcut) {
	const code = codeOf(shortcut) ?? "";
	const key = keyOf(shortcut);
	const keyCode = CODES[code]?.[2] ?? 0;
	return {
		key: shortcut.key && shortcut.mods.shift ? key.toUpperCase() : key,
		code,
		keyCode,
		which: keyCode,
		ctrlKey: shortcut.mods.ctrl,
		altKey: shortcut.mods.alt,
		shiftKey: shortcut.mods.shift,
		metaKey: shortcut.mods.meta,
	};
}

// Does a keyboard-like object ({key, code, ctrlKey, ...}) trigger `shortcut`?
export function matchesShortcut(shortcut, event) {
	if (
		!!event.ctrlKey !== shortcut.mods.ctrl ||
		!!event.altKey !== shortcut.mods.alt ||
		!!event.shiftKey !== shortcut.mods.shift ||
		!!event.metaKey !== shortcut.mods.meta
	)
		return false;
	if (shortcut.code) return event.code === shortcut.code;
	return normalizeKey(event.key) === shortcut.key;
}

// Same physical shortcut, whichever field each side recorded.
export function sameShortcut(a, b) {
	if (MODIFIERS.some((name) => a.mods[name] !== b.mods[name])) return false;
	if (a.code && b.code) return a.code === b.code;
	if (a.key && b.key) return a.key === b.key;
	return codeOf(a) !== null && codeOf(a) === codeOf(b);
}

// ---- static detection ------------------------------------------------------

const EVENT_NAMES = "(?:e|ev|evt|event|ke|kev|keyEvent|keyboardEvent|k)";
const LITERAL = String.raw`(['"\`])((?:\\.|(?!\1)[^\n\\]){1,24})\1`;
const COMPARE_FORWARD = new RegExp(
	String.raw`\b${EVENT_NAMES}\.(key|code)\s*={2,3}\s*${LITERAL.replaceAll("\\1", "\\2")}`,
	"g",
);
const COMPARE_REVERSE = new RegExp(
	String.raw`${LITERAL}\s*={2,3}\s*\b${EVENT_NAMES}\.(key|code)\b`,
	"g",
);
const COMPARE_KEYCODE = new RegExp(
	String.raw`\b${EVENT_NAMES}\.(?:keyCode|which)\s*={2,3}\s*(\d{1,3})\b`,
	"g",
);
const SWITCH = new RegExp(
	String.raw`switch\s*\(\s*${EVENT_NAMES}\.(key|code)\s*\)\s*\{`,
	"g",
);
const CODE_NAME = String.raw`(?:Key[A-Z]|Digit\d|F(?:[1-9]|1\d|2[0-4])|Backquote|Escape|Space|Enter|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Arrow(?:Up|Down|Left|Right)|Bracket(?:Left|Right)|Backslash|Slash|Comma|Period|Semicolon|Quote|Minus|Equal)`;
const COMBO_STRING = new RegExp(
	String.raw`(['"\`])((?:(?:Ctrl|Control|Alt|Option|Opt|Shift|Meta|Cmd|Command)\s*\+\s*)*${CODE_NAME})\1`,
	"g",
);
// Plain (modifier-less) combo strings only count for code-style names.
const SPECIFIC_CODE =
	/^(?:Key[A-Z]|Digit\d|F\d+|Backquote|Bracket(?:Left|Right)|Backslash|Slash|Semicolon|Quote|Comma|Period|Minus|Equal)$/;
const COMBO_MODS = {
	ctrl: "ctrl",
	control: "ctrl",
	alt: "alt",
	option: "alt",
	opt: "alt",
	shift: "shift",
	meta: "meta",
	cmd: "meta",
	command: "meta",
};
const KEYBOARD_HINT = /keydown|keyup|keypress|onkey|KeyboardEvent/;

function unescapeLiteral(text) {
	return text.replace(/\\(.)/g, "$1");
}

function lineAround(source, index) {
	const start = source.lastIndexOf("\n", index) + 1;
	const end = source.indexOf("\n", index);
	return source.slice(start, end < 0 ? source.length : end);
}

// A match on a `//` comment line, or a line inside a block comment, is
// documentation (e.g. "Examples: 'Alt+KeyQ'"), not a handled shortcut.
function inComment(source, index) {
	const lineStart = source.lastIndexOf("\n", index) + 1;
	const before = source.slice(lineStart, index);
	if (/^\s*(?:\*|\/\*)/.test(before)) return true;
	const slash = before.indexOf("//");
	if (slash >= 0 && !/['"`]/.test(before.slice(0, slash))) return true;
	const open = source.lastIndexOf("/*", index);
	return open >= 0 && source.lastIndexOf("*/", index) < open;
}

// Modifiers required (not negated) on the same line as a key comparison.
function lineModifiers(line) {
	const mods = noMods();
	for (const name of MODIFIERS) {
		const required = new RegExp(
			String.raw`(?<![!\w.])${EVENT_NAMES}\.${name}Key\b(?!\s*={2,3}\s*false)`,
		);
		mods[name] = required.test(line);
	}
	return mods;
}

/**
 * Best-effort list of shortcuts a script source handles. Heuristic: catches
 * `e.key === 'x'`, `e.code === 'KeyX'` (with modifiers required on the same
 * line), `e.keyCode === 88`, `switch (e.key) { case 'x': }` and combo strings
 * such as 'Ctrl+Shift+KeyH'. Shortcuts a script actually handles at run time
 * are recorded separately and fill the gaps.
 */
export function detectShortcuts(source, limit = 24) {
	if (typeof source !== "string" || !KEYBOARD_HINT.test(source)) return [];
	const found = [];
	const add = (shortcut) => {
		if (!shortcut || found.length >= limit) return;
		if (found.some((item) => sameShortcut(item, shortcut))) return;
		found.push(shortcut);
	};
	const fromValue = (field, value, mods) => {
		if (field === "code")
			return CODES[value] ? makeShortcut({ mods, code: value }) : null;
		if (value.length === 1 || CODES[value] || value in KEY_LABELS)
			return makeShortcut({ mods, key: value });
		return null;
	};
	for (const match of source.matchAll(COMPARE_FORWARD))
		if (!inComment(source, match.index))
			add(
				fromValue(
					match[1],
					unescapeLiteral(match[3]),
					lineModifiers(lineAround(source, match.index)),
				),
			);
	for (const match of source.matchAll(COMPARE_REVERSE))
		if (!inComment(source, match.index))
			add(
				fromValue(
					match[3],
					unescapeLiteral(match[2]),
					lineModifiers(lineAround(source, match.index)),
				),
			);
	for (const match of source.matchAll(COMPARE_KEYCODE)) {
		const code = KEYCODE_TO_CODE.get(Number(match[1]));
		if (code && !inComment(source, match.index))
			add(
				makeShortcut({
					mods: lineModifiers(lineAround(source, match.index)),
					code,
				}),
			);
	}
	for (const match of source.matchAll(SWITCH)) {
		const body = source.slice(match.index, match.index + 3000);
		const end = body.indexOf("switch", 6);
		const block = end > 0 ? body.slice(0, end) : body;
		for (const item of block.matchAll(
			/\bcase\s*(['"`])((?:\\.|(?!\1)[^\n\\]){1,24})\1\s*:/g,
		))
			add(fromValue(match[1], unescapeLiteral(item[2]), noMods()));
	}
	for (const match of source.matchAll(COMBO_STRING)) {
		if (inComment(source, match.index)) continue;
		// Literals inside comparisons were handled above with their modifiers.
		const before = source.slice(Math.max(0, match.index - 12), match.index);
		const after = source.slice(
			match.index + match[0].length,
			match.index + match[0].length + 6,
		);
		if (/(?:={2,3}|\bcase)\s*$/.test(before) || /^\s*={2,3}/.test(after))
			continue;
		const parts = match[2].split("+").map((part) => part.trim());
		const code = parts.pop();
		if (!parts.length && !SPECIFIC_CODE.test(code)) continue;
		const mods = noMods();
		for (const part of parts) mods[COMBO_MODS[part.toLowerCase()]] = true;
		add(makeShortcut({ mods, code }));
	}
	return found;
}

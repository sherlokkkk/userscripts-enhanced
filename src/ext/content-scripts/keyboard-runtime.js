import {
	detectShortcuts,
	makeShortcut,
	sameShortcut,
	shortcutId,
	syntheticEventFields,
} from "../shared/shortcuts.js";

// Per-document bookkeeping of userscript keyboard shortcuts.
//
// - detected: found in the script source (static heuristic)
// - observed: the script's own key listener handled it at run time
//   (persisted in UE_SHORTCUTS_SEEN so the popup lists it on later visits)
// - settings: the user's choices from the popup, stored per script in
//   UE_SCRIPT_PREFS[scriptId].shortcuts = { [id]: { original, disabled?, to? } }
export const SHORTCUTS_SEEN_KEY = "UE_SHORTCUTS_SEEN";
const MAX_OBSERVED = 30;

const validShortcut = (value) =>
	value && typeof value === "object" ? makeShortcut(value) : null;

export function buildRules(settings) {
	const remaps = [];
	const blocks = [];
	for (const setting of Object.values(settings ?? {})) {
		const original = validShortcut(setting?.original);
		if (!original) continue;
		// Switched off: neither the original nor a replacement key reaches it.
		if (setting.disabled === true) {
			blocks.push({ when: original, deliver: null });
			continue;
		}
		const to = validShortcut(setting.to);
		if (to && !sameShortcut(to, original)) {
			remaps.push({
				when: to,
				deliver: { shortcut: original, fields: syntheticEventFields(original) },
			});
			blocks.push({ when: original, deliver: null });
		}
	}
	// A remapped key wins over a block of the same key.
	return [...remaps, ...blocks];
}

export function createKeyboardRuntime({ storage, getSettings, onChange }) {
	const scripts = new Map();
	let seen = {};
	let persistTimer;

	const persist = (scriptId) => {
		clearTimeout(persistTimer);
		persistTimer = setTimeout(async () => {
			try {
				const stored = (await storage.get(SHORTCUTS_SEEN_KEY))?.[
					SHORTCUTS_SEEN_KEY
				];
				const next = stored && typeof stored === "object" ? stored : {};
				next[scriptId] = scripts.get(scriptId).observed;
				await storage.set({ [SHORTCUTS_SEEN_KEY]: next });
			} catch (error) {
				console.warn(
					"Userscripts Enhanced: shortcut history unavailable",
					error,
				);
			}
		}, 500);
	};

	return {
		async load() {
			try {
				const stored = (await storage.get(SHORTCUTS_SEEN_KEY))?.[
					SHORTCUTS_SEEN_KEY
				];
				if (stored && typeof stored === "object") seen = stored;
			} catch {
				seen = {};
			}
		},
		register(scriptId, { source, editable }) {
			if (scripts.has(scriptId)) return;
			const remembered = Object.hasOwn(seen, scriptId) ? seen[scriptId] : [];
			scripts.set(scriptId, {
				editable,
				detected: detectShortcuts(source),
				observed: (Array.isArray(remembered) ? remembered : [])
					.map(validShortcut)
					.filter(Boolean)
					.slice(0, MAX_OBSERVED),
			});
		},
		rules(scriptId) {
			let cachedSettings;
			let cachedText = "[]";
			return () => {
				const settings = getSettings(scriptId);
				if (settings !== cachedSettings) {
					cachedSettings = settings;
					cachedText = JSON.stringify(buildRules(settings));
				}
				return cachedText;
			};
		},
		reporter(scriptId) {
			return (text) => {
				const state = scripts.get(scriptId);
				if (!state || typeof text !== "string" || text.length > 512) return;
				let shortcut;
				try {
					shortcut = validShortcut(JSON.parse(text));
				} catch {
					return;
				}
				if (!shortcut) return;
				const known = [...state.detected, ...state.observed].some((item) =>
					sameShortcut(item, shortcut),
				);
				if (known || state.observed.length >= MAX_OBSERVED) return;
				state.observed.push(shortcut);
				persist(scriptId);
				onChange();
			};
		},
		// Plain data for the popup (crosses the extension boundary).
		snapshot(scriptId) {
			const state = scripts.get(scriptId);
			if (!state) return [];
			const settings = getSettings(scriptId) ?? {};
			const list = [];
			const push = (shortcut, source) => {
				const id = shortcutId(shortcut);
				if (list.some((item) => sameShortcut(item.shortcut, shortcut))) return;
				const setting = settings[id];
				list.push({
					id,
					shortcut,
					source,
					disabled: setting?.disabled === true,
					to: validShortcut(setting?.to),
				});
			};
			for (const shortcut of state.detected) push(shortcut, "detected");
			for (const shortcut of state.observed) push(shortcut, "observed");
			return { editable: state.editable, list };
		},
	};
}

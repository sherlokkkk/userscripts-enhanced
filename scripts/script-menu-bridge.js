// Embedded into standalone userscripts. It depends only on the supplied API functions.
export function createScriptMenus({
	register,
	unregister,
	report = console.warn,
}) {
	const entries = new Map();
	const remove = (id) => {
		if (id === undefined || typeof unregister !== "function") return;
		try {
			Promise.resolve(unregister(id)).catch(report);
		} catch (error) {
			report(error);
		}
	};
	return {
		available: typeof register === "function",
		set(key, title, callback) {
			if (typeof register !== "function") return;
			const previous = entries.get(key);
			if (previous?.title === title) {
				previous.callback = callback;
				return;
			}
			if (previous) {
				previous.cancelled = true;
				remove(previous.id);
			}
			const entry = { title, callback, cancelled: false, id: undefined };
			entries.set(key, entry);
			try {
				const id = register(title, (event) => entry.callback(event), {
					autoClose: false,
				});
				if (id && typeof id.then === "function") {
					Promise.resolve(id).then((value) => {
						if (entry.cancelled) remove(value);
						else entry.id = value;
					}, report);
				} else entry.id = id;
			} catch (error) {
				entries.delete(key);
				report(error);
			}
		},
		clear() {
			for (const entry of entries.values()) {
				entry.cancelled = true;
				remove(entry.id);
			}
			entries.clear();
		},
	};
}

export function menuBootstrap() {
	return `\n  // Optional menus: retain the original UI/hotkeys when the manager has no menu API.\n  const scriptMenus = (${createScriptMenus.toString()})({
    register: typeof GM_registerMenuCommand === 'function' ? GM_registerMenuCommand :
      (typeof GM !== 'undefined' && typeof GM.registerMenuCommand === 'function' ? GM.registerMenuCommand.bind(GM) : undefined),
    unregister: typeof GM_unregisterMenuCommand === 'function' ? GM_unregisterMenuCommand :
      (typeof GM !== 'undefined' && typeof GM.unregisterMenuCommand === 'function' ? GM.unregisterMenuCommand.bind(GM) : undefined),
    report: (error) => console.warn('Script menu:', error)
  });\n`;
}

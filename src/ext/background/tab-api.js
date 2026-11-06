export function createTabRouter({ browser, authorize }) {
	const storage = browser.storage.session;
	const prefix = "UE_TAB:";
	const handlePrefix = "UE_OPEN_TAB:";
	browser.tabs.onRemoved.addListener(async (tabId) => {
		const data = await storage.get(null);
		const remove = [];
		for (const [key, entry] of Object.entries(data)) {
			if (key.startsWith(prefix) && key.endsWith(`:${tabId}`)) remove.push(key);
			if (!key.startsWith(handlePrefix)) continue;
			if (entry.tabId === tabId) {
				remove.push(key);
				browser.tabs
					.sendMessage(
						entry.openerTabId,
						{ name: "UE_TAB_CLOSED", handle: key.slice(handlePrefix.length) },
						{ frameId: entry.frameId },
					)
					.catch(() => {});
			} else if (entry.openerTabId === tabId) remove.push(key);
		}
		await storage.remove(remove);
	});
	return async (message, sender) => {
		if (
			sender.id !== browser.runtime.id ||
			!Number.isInteger(sender.tab?.id) ||
			!Number.isInteger(sender.frameId)
		)
			return { ok: false, error: "Invalid script sender" };
		try {
			const actions = {
				OPEN: "openInTab",
				CLOSE: "openInTab",
				GET: "getTab",
				SAVE: "saveTab",
				ALL: "getTabs",
			};
			const action = message.name.slice("UE_TAB_".length);
			if (!Object.hasOwn(actions, action))
				throw new Error("Unknown tab operation");
			await authorize(message.identity, actions[action]);
			const scriptId = message.identity.scriptId;
			const key = `${prefix}${scriptId}:${sender.tab.id}`;
			if (action === "GET")
				return { ok: true, data: (await storage.get(key))[key] ?? {} };
			if (action === "SAVE") {
				if (
					!message.data ||
					typeof message.data !== "object" ||
					Array.isArray(message.data) ||
					JSON.stringify(message.data).length > 1_000_000
				)
					throw new Error("Tab data must be a JSON object smaller than 1 MB");
				await storage.set({ [key]: message.data });
				return { ok: true };
			}
			if (action === "ALL") {
				const live = new Set(
					(await browser.tabs.query({})).map((tab) => String(tab.id)),
				);
				const all = await storage.get(null),
					data = Object.create(null);
				for (const [key, value] of Object.entries(all)) {
					if (!key.startsWith(`${prefix}${scriptId}:`)) continue;
					const id = key.slice(`${prefix}${scriptId}:`.length);
					if (live.has(id)) data[id] = value;
				}
				return { ok: true, data };
			}
			if (action === "OPEN") {
				const url = new URL(message.url, sender.url);
				if (
					!["http:", "https:"].includes(url.protocol) ||
					url.username ||
					url.password
				)
					throw new Error("Only HTTP(S) tabs may be opened");
				const tab = await browser.tabs.create({
					url: url.href,
					active: message.active !== false,
					windowId: sender.tab.windowId,
				});
				const handle = crypto.randomUUID();
				await storage.set({
					[handlePrefix + handle]: {
						tabId: tab.id,
						openerTabId: sender.tab.id,
						frameId: sender.frameId,
						scriptId,
					},
				});
				return { ok: true, handle };
			}
			if (action === "CLOSE") {
				if (typeof message.handle !== "string")
					throw new Error("Invalid tab handle");
				const entry = (await storage.get(handlePrefix + message.handle))[
					handlePrefix + message.handle
				];
				if (
					!entry ||
					entry.scriptId !== scriptId ||
					entry.openerTabId !== sender.tab.id ||
					entry.frameId !== sender.frameId
				)
					throw new Error("This script does not own the tab handle");
				await browser.tabs.remove(entry.tabId);
				return { ok: true };
			}
		} catch (error) {
			return { ok: false, error: String(error.message ?? error) };
		}
	};
}

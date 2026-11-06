// The authoritative registry is the live frame, so a suspended background can
// recover without persisting stale function handles or page history to disk.
export function createMenuRouter({ browser, validateScripts, isEnabled }) {
	const isUI = (sender) => {
		if (sender.id !== browser.runtime.id || !sender.url) return false;
		const url = sender.url.split(/[?#]/)[0];
		return [
			"/dist/entry-ext-action-popup.html",
			"/dist/entry-ext-extension-page.html",
		].some((path) => url === browser.runtime.getURL(path));
	};
	const signal = (tabId) => {
		browser.runtime
			.sendMessage({ name: "UE_MENU_REFRESH", tabId })
			.catch(() => {});
	};
	const liveFrames = async (tabId) =>
		(await browser.webNavigation.getAllFrames({ tabId })) ?? [];
	const probe = async (tabId, frameId) => {
		try {
			return await browser.tabs.sendMessage(
				tabId,
				{ name: "UE_MENU_SNAPSHOT" },
				{ frameId },
			);
		} catch {
			return null; // No accessible/injected content script is a normal empty frame.
		}
	};
	async function list(tabId) {
		if (!(await isEnabled())) return { ok: true, scripts: [] };
		const frames = await liveFrames(tabId);
		const groups = await Promise.all(
			frames.map(async (frame) => {
				const snapshot = await probe(tabId, frame.frameId);
				if (
					!snapshot ||
					typeof snapshot.documentId !== "string" ||
					!Array.isArray(snapshot.scripts)
				)
					return [];
				return snapshot.scripts.slice(0, 500).map((script) => ({
					...script,
					tabId,
					frameId: frame.frameId,
					documentId: snapshot.documentId,
				}));
			}),
		);
		const scripts = groups.flat();
		const allowed = await validateScripts(scripts);
		return {
			ok: true,
			scripts: scripts.filter((script) => allowed.has(script.scriptId)),
		};
	}
	async function execute(message) {
		if (!(await isEnabled()))
			throw new Error("Userscripts Enhanced is disabled");
		const { tabId, frameId, documentId, scriptId, commandId } = message;
		if (
			message.value !== undefined &&
			!(
				typeof message.value === "boolean" ||
				(typeof message.value === "number" && Number.isFinite(message.value)) ||
				(typeof message.value === "string" && message.value.length <= 2048)
			)
		)
			throw new Error("Invalid control value");
		if (
			!Number.isInteger(frameId) ||
			frameId < 0 ||
			![documentId, scriptId, commandId].every(
				(x) => typeof x === "string" && x.length > 0 && x.length < 256,
			)
		)
			throw new Error("Invalid command address");
		const frame = (await liveFrames(tabId)).find(
			(item) => item.frameId === frameId,
		);
		if (!frame) throw new Error("Frame has closed");
		const snapshot = await probe(tabId, frameId);
		if (snapshot?.documentId !== documentId)
			throw new Error("Page changed; reopen the menu");
		const script = snapshot.scripts.find((item) => item.scriptId === scriptId);
		if (!script?.commands.some((item) => item.commandId === commandId))
			throw new Error("Command is no longer registered");
		if (!(await validateScripts([script])).has(scriptId))
			throw new Error(
				"Script was disabled, edited, or deleted; reload the page",
			);
		// Only controlled identifiers and event modifiers; never source code/functions.
		const input = message.event ?? {};
		const event = {
			type: input.type === "keydown" ? "keydown" : "click",
			key: typeof input.key === "string" ? input.key.slice(0, 32) : "",
			button: 0,
			altKey: input.altKey === true,
			ctrlKey: input.ctrlKey === true,
			metaKey: input.metaKey === true,
			shiftKey: input.shiftKey === true,
		};
		const result = await browser.tabs.sendMessage(
			tabId,
			{
				name: "UE_MENU_EXECUTE",
				documentId,
				scriptId,
				commandId,
				event,
				value: message.value,
			},
			{ frameId },
		);
		if (!result || typeof result.ok !== "boolean")
			throw new Error("Frame did not acknowledge the command");
		return result;
	}
	return {
		async handle(message, sender) {
			if (
				!message ||
				typeof message.name !== "string" ||
				!message.name.startsWith("UE_MENU_")
			)
				return undefined;
			if (message.name === "UE_MENU_REFRESH") return undefined;
			try {
				if (message.name === "UE_MENU_CHANGED") {
					if (
						sender.id !== browser.runtime.id ||
						!Number.isInteger(sender.tab?.id) ||
						!Number.isInteger(sender.frameId)
					)
						throw new Error("Invalid content-script sender");
					signal(sender.tab.id);
					return { ok: true };
				}
				if (!isUI(sender))
					throw new Error("Only extension UI may control script commands");
				if (message.name === "UE_MENU_INVALIDATE") {
					if (
						message.filename !== undefined &&
						(typeof message.filename !== "string" ||
							message.filename.length > 2048)
					)
						throw new Error("Invalid script filename");
					const tabs = await browser.tabs.query({});
					await Promise.all(
						tabs.map(async (tab) => {
							try {
								const frames = await liveFrames(tab.id);
								await Promise.all(
									frames.map((frame) =>
										browser.tabs
											.sendMessage(
												tab.id,
												{
													name: "UE_MENU_REVOKE",
													filename: message.filename,
												},
												{ frameId: frame.frameId },
											)
											.catch(() => {}),
									),
								);
							} catch {
								/* Restricted pages have no running commands. */
							}
						}),
					);
					return { ok: true };
				}
				if (!Number.isInteger(message.tabId) || message.tabId < 0)
					throw new Error("Invalid tab ID");
				// A popup must never accidentally act on a tab in a different window.
				const tab = await browser.tabs.get(message.tabId);
				if (!tab.active) throw new Error("Tab is no longer active");
				if (message.name === "UE_MENU_LIST") return await list(message.tabId);
				if (message.name === "UE_MENU_RUN") return await execute(message);
				throw new Error("Unknown menu message");
			} catch (error) {
				return {
					ok: false,
					error: String(error?.message ?? error).slice(0, 2048),
				};
			}
		},
	};
}

import { createUpdateService } from "./updates.js";
import { createTabRouter } from "./tab-api.js";
import { installNetworkHandler } from "./network.js";
import { createMenuRouter } from "./menu-router.js";
import { contentScriptRegistration, openExtensionPage } from "@ext/utils.js";
import * as settingsStorage from "@ext/settings.js";
import { connectNative, sendNativeMessage } from "@ext/native.js";

async function authorizeAPI(identity, method) {
	if (
		(await browser.storage.local.get("US_GLOBAL_ACTIVE")).US_GLOBAL_ACTIVE ===
		false
	)
		throw new Error("Userscripts Enhanced is disabled");
	const response = await sendNativeMessage({
		name: "UE_AUTHORIZE_API",
		identity,
		method,
	});
	if (!response?.allowed)
		throw new Error(`Script does not have ${method} permission`);
}
const tabRouter = createTabRouter({ browser, authorize: authorizeAPI });

installNetworkHandler({
	browser,
	authorize: async (identity, sender) => {
		if (
			(await browser.storage.local.get("US_GLOBAL_ACTIVE")).US_GLOBAL_ACTIVE ===
			false
		)
			throw new Error("Userscripts Enhanced is disabled");
		const response = await sendNativeMessage({
			name: "UE_AUTHORIZE_XHR",
			identity,
			url: sender.url,
		});
		if (!response?.allowed)
			throw new Error(
				response?.error ?? "Script does not have network permission",
			);
		return response;
	},
});

const updates = createUpdateService({
	browser,
	native: sendNativeMessage,
	intervalDays: () => settingsStorage.get("scripts_update_check_interval"),
	enabled: async () =>
		(await browser.storage.local.get("US_GLOBAL_ACTIVE")).US_GLOBAL_ACTIVE !==
		false,
});

const menuRouter = createMenuRouter({
	browser,
	isEnabled: async () =>
		(await browser.storage.local.get("US_GLOBAL_ACTIVE"))[
			"US_GLOBAL_ACTIVE"
		] !== false,
	validateScripts: async (scripts) => {
		if (!scripts.length) return new Set();
		const response = await sendNativeMessage({
			name: "UE_VALIDATE_MENU_SCRIPTS",
			scripts: scripts.map(({ scriptId, filename, revision }) => ({
				scriptId,
				filename,
				revision,
			})),
		});
		if (!Array.isArray(response?.allowed))
			throw new Error("Could not verify script permissions");
		return new Set(response.allowed);
	},
});

// first sorts files by run-at value, then by weight value
function userscriptSort(a, b) {
	// map the run-at values to numeric values
	const runAtValues = {
		"document-start": 1,
		"document-body": 2,
		"document-end": 3,
		"document-idle": 4,
	};
	const runAtA = a.scriptObject["run-at"];
	const runAtB = b.scriptObject["run-at"];
	if (runAtA !== runAtB && runAtValues[runAtA] && runAtValues[runAtB]) {
		return runAtValues[runAtA] - runAtValues[runAtB];
	}
	return Number(b.weight) - Number(a.weight);
}

async function getPlatform() {
	let platform = localStorage.getItem("platform");
	if (!platform) {
		const message = { name: "REQ_PLATFORM" };
		const response = await sendNativeMessage(message);
		if (!response.platform) {
			console.error("Failed to get platform");
			return "";
		}
		platform = response.platform;
		localStorage.setItem("platform", platform);
	}
	return platform;
}

function setClipboard(data, type = "text/plain") {
	// future enhancement?
	// https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/write
	// https://developer.mozilla.org/en-US/docs/Web/API/Clipboard/writeText
	const onCopy = (e) => {
		e.stopImmediatePropagation();
		e.preventDefault();
		e.clipboardData.setData(type, data);
		document.removeEventListener("copy", onCopy, true);
	};

	const textarea = document.createElement("textarea");
	textarea.textContent = "<empty clipboard>";
	document.body.appendChild(textarea);
	textarea.select();
	document.addEventListener("copy", onCopy, true);
	try {
		return document.execCommand("copy");
	} catch (error) {
		console.warn("setClipboard failed", error);
		document.removeEventListener("copy", onCopy, true);
		return false;
	} finally {
		document.removeEventListener("copy", onCopy, true);
		document.body.removeChild(textarea);
	}
}

async function setBadgeCount() {
	const clearBadge = () => browser.browserAction.setBadgeText({ text: null });
	// @todo until better introduce in ios, only set badge on macOS
	// set a text badge or an empty string in visionOS will cause the extension's icon to no longer be displayed
	const platform = await getPlatform();
	if (platform !== "macos") return clearBadge();
	// @todo settingsStorage.get("global_exclude_match")
	const settings = await settingsStorage.get([
		"global_active",
		"toolbar_badge_count",
	]);
	if (settings["global_active"] === false) return clearBadge();
	if (settings["toolbar_badge_count"] === false) return clearBadge();

	const currentTab = await browser.tabs.getCurrent();
	// no active tabs exist (user closed all windows)
	if (!currentTab) return clearBadge();
	const url = currentTab.url;
	// if url doesn't exist, stop
	if (!url) return clearBadge();
	// only check for http/s pages
	if (!url.startsWith("http://") && !url.startsWith("https://"))
		return clearBadge();
	// @todo if url match in global exclude list, clear badge
	const frameUrls = new Set();
	const frames = await browser.webNavigation.getAllFrames({
		tabId: currentTab.id,
	});
	for (let i = 0; i < frames.length; i++) {
		const frameUrl = frames[i].url;
		if (frameUrl !== url && frameUrl.startsWith("http")) {
			frameUrls.add(frameUrl);
		}
	}
	const message = {
		name: "POPUP_BADGE_COUNT",
		url,
		frameUrls: Array.from(frameUrls),
	};
	const response = await sendNativeMessage(message);
	if (response?.error) return console.error(response.error);
	if (response?.count > 0) {
		browser.browserAction.setBadgeText({ text: response.count.toString() });
	} else {
		const _url = new URL(url);
		if (_url.pathname.endsWith(".user.js")) {
			browser.browserAction.setBadgeText({ text: "JS" });
		} else {
			clearBadge();
		}
	}
}

// on startup set declarativeNetRequest rulesets
// should also check and refresh when:
// 1. dnr item save event in the page occurs
// 2. dnr item toggle event in the page occurs
// 3. external editor changes script file content
async function setDNRRulesets() {
	// not supported below safari 15.4
	if (!browser.declarativeNetRequest.updateDynamicRules) return;
	const message = { name: "REQ_REQUESTS" };
	const response = await sendNativeMessage(message);
	if (response.error) {
		console.error(response.error);
		return;
	}
	// loop through response, parse the rules, push to array and log
	/** @type {import("webextension-polyfill").DeclarativeNetRequest.Rule[]} */
	const addRules = [];
	let ruleId = 1;
	for (let i = 0; i < response.length; i++) {
		if (
			ruleId >
			browser.declarativeNetRequest.MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES
		) {
			console.warn(
				"Rules exceed the maximum number, some rules will be ignored",
			);
			break;
		}
		const ruleset = response[i];
		/** @type {Array} */
		let rules;
		try {
			const res = JSON.parse(ruleset.code);
			// check if an array or single rule
			if (Array.isArray(res)) {
				rules = res;
			} else if (typeof res === "object") {
				rules = [res];
			} else {
				console.warn(`Not a valid DNR ruleset: ${ruleset.name}`);
				continue;
			}
			console.info(`Setting DNR ruleset: ${ruleset.name} (${rules.length})`);
		} catch (error) {
			console.warn(
				`Failed parsed into a valid DNR ruleset: ${ruleset.name}`,
				error,
			);
			continue;
		}
		for (const rule of rules) {
			// simple check if it is a rule object
			if (!rule.action || !rule.condition || !rule.id) {
				console.warn("Not a valid DNR rule:", rule);
				continue;
			}
			// set unique ids for all rules to ensure no repeats
			rule.id = ruleId++;
			addRules.push(rule);
		}
	}
	// remove all then add declarativeNetRequest rules
	try {
		const oldRules = await browser.declarativeNetRequest.getDynamicRules();
		const removeRuleIds = oldRules.map((rule) => rule.id);
		await browser.declarativeNetRequest.updateDynamicRules({
			addRules,
			removeRuleIds,
		});
	} catch (error) {
		return console.error(error);
	}
	console.info(`Finished setting ${addRules.length} DNR rules`);
}

// the current update logic is similar to setDNRRulesets()
// this feature needs a more detailed redesign in the future
// https://github.com/quoid/userscripts/issues/453
async function getContextMenuItems() {
	// macos exclusive feature
	const platform = await getPlatform();
	if (platform !== "macos") return;
	// since it's not possible to get a list of currently active menu items
	// on update, all context-menu items are cleared, then re-added
	// this is done to ensure fresh code changes appear
	await browser.menus.removeAll();
	// get the context-menu scripts
	const message = { name: "REQ_CONTEXT_MENU_SCRIPTS" };
	const response = await sendNativeMessage(message);
	if (response.error) {
		console.error(response.error);
		return;
	}
	// add menus items
	const items = response.files?.menu || [];
	if (items.length) {
		console.info(`Setting ${items.length} context-menu userscripts`);
	}
	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		// context-menu scripts require @match value
		// @include values are ignored
		if (!item.scriptObject.matches.length) continue;
		addContextMenuItem(item);
	}
}

async function addContextMenuItem(userscript) {
	const patterns = userscript.scriptObject.matches;
	browser.menus.create(
		{
			contexts: ["all"],
			documentUrlPatterns: patterns,
			id: userscript.scriptObject.filename,
			title: userscript.scriptObject.name,
		},
		() => {
			// add event listener if needed
			if (!browser.menus.onClicked.hasListener(contextClick)) {
				browser.menus.onClicked.addListener(contextClick);
			}
		},
	);
}

async function contextClick(info, tab) {
	// when any created context-menu item is clicked, send message to tab
	// the content script for that tag will have the context-menu code
	// which will get send back in the response if/when found
	const message = { name: "CONTEXT_RUN", menuItemId: info.menuItemId };
	const response = await browser.tabs.sendMessage(tab.id, message);
	// if code is returned, execute on that tab
	if (!response.code) return;
	browser.tabs.executeScript(tab.id, { code: response.code });
}

async function nativeChecks() {
	const response = await sendNativeMessage({
		name: "NATIVE_CHECKS",
	});
	if (response.error) {
		settingsStorage.set({ error_native: response });
		return false;
	}
	settingsStorage.reset("error_native");
	return true;
}

/**
 * Handles messages sent with `browser.runtime.sendMessage`
 * Make sure not to return `undefined` or `rejection`, otherwise the reply may never be delivered
 * @see {@link https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/onMessage#listener}
 * @type {Parameters<typeof browser.runtime.onMessage.addListener>[0]}
 * @returns {Promise<{status: "pending"|"fulfilled"|"rejected", result?: any}>}
 */
async function handleMessage(message, sender) {
	if (
		!message ||
		typeof message !== "object" ||
		typeof message.name !== "string"
	)
		return { ok: false, error: "Invalid extension message" };
	if (message?.name === "UE_UPDATE_CHECK") {
		const url = sender.url?.split(/[?#]/)[0];
		if (
			sender.id !== browser.runtime.id ||
			![
				browser.runtime.getURL("/dist/entry-ext-action-popup.html"),
				browser.runtime.getURL("/dist/entry-ext-extension-page.html"),
			].includes(url)
		)
			return {
				ok: false,
				error: "Only extension UI can request an update check",
			};
		try {
			return { ok: true, states: await updates.check() };
		} catch (error) {
			return { ok: false, error: String(error.message ?? error) };
		}
	}
	if (message?.name === "UE_RESOURCE_BUNDLE") {
		if (sender.id !== browser.runtime.id || !Number.isInteger(sender.tab?.id))
			return { error: "Invalid script sender" };
		return sendNativeMessage({
			name: "UE_RESOURCE_BUNDLE",
			identity: message.identity,
		});
	}
	if (message?.name?.startsWith("UE_TAB_")) return tabRouter(message, sender);
	if (message?.name === "UE_CLIPBOARD") {
		try {
			if (sender.id !== browser.runtime.id || !Number.isInteger(sender.tab?.id))
				throw new Error("Invalid script sender");
			await authorizeAPI(message.identity, "setClipboard");
			if (
				typeof message.data !== "string" ||
				message.data.length > 5_000_000 ||
				!["text/plain", "text/html"].includes(message.type)
			)
				throw new Error("Clipboard supports plain text and HTML up to 5 MB");
			if (!setClipboard(message.data, message.type))
				throw new Error(
					"Safari denied clipboard access; a user gesture may be required",
				);
			return { ok: true };
		} catch (error) {
			return { ok: false, error: String(error.message ?? error) };
		}
	}
	if (message?.name?.startsWith("UE_MENU_"))
		return menuRouter.handle(message, sender);
	switch (message.name) {
		case "REQ_USERSCRIPTS": {
			// get the page url from the content script that sent request
			const url = sender.url;
			// use frameId to determine if request came from top level window
			// if @noframes true, and isTop false, swift layer won't return code
			const isTop = sender.frameId === 0;
			// send request to swift layer to provide code for page url
			const message = { name: "REQ_USERSCRIPTS", url, isTop };
			try {
				const response = await sendNativeMessage(message);
				if (import.meta.env.MODE === "development") {
					console.debug("REQ_USERSCRIPTS", message, response);
				}
				// if request failed, send error to content script for logging
				if (response.error) return response;
				// sort files
				response.files.js.sort(userscriptSort);
				response.files.css.sort((a, b) => Number(b.weight) - Number(a.weight));
				// return sorted files for injection
				return response;
			} catch (error) {
				console.error(error);
				// @ts-ignore -- ignore for now and will reconstruct this in the future.
				return { error: String(error) };
			}
		}
		case "API_CLOSE_TAB":
		case "API_OPEN_TAB":
		case "API_GET_TAB":
		case "API_SAVE_TAB":
		case "API_ADD_STYLE":
		case "API_SET_CLIPBOARD":
			return {
				status: "rejected",
				result: "Unscoped legacy transport disabled; reload this page",
			};

		case "API_XHR":
			return {
				status: "rejected",
				result:
					"Legacy unrestricted XHR transport is disabled; reload the page",
			};

		case "REFRESH_DNR_RULES": {
			setDNRRulesets();
			break;
		}
		case "REFRESH_CONTEXT_MENU_SCRIPTS": {
			getContextMenuItems();
			break;
		}
		case "WEB_USERJS_POPUP": {
			const currentTab = await browser.tabs.getCurrent();
			if (currentTab.id === sender.tab.id) {
				browser.browserAction.openPopup();
			}
			break;
		}
	}
}
browser.runtime.onInstalled.addListener(async () => {
	await nativeChecks();
	const enable = await settingsStorage.get("augmented_userjs_install");
	await contentScriptRegistration(enable);
});
browser.runtime.onStartup.addListener(async () => {
	setDNRRulesets();
	getContextMenuItems();
});
// listens for messages from content script, popup and page
browser.runtime.onMessage.addListener(handleMessage);
// set the badge count
browser.tabs.onActivated.addListener(setBadgeCount);
browser.windows.onFocusChanged.addListener(async (windowId) => {
	if (windowId < 1) {
		// lose focus
		return;
	}
	nativeChecks();
	setBadgeCount();
	setDNRRulesets();
	getContextMenuItems();
});
browser.webNavigation.onCompleted.addListener(setBadgeCount);

// handle native app messages
const port = connectNative();
port.onMessage.addListener(async (message) => {
	// console.info(message); // DEBUG
	if (message.name === "SAVE_LOCATION_CHANGED") {
		await openExtensionPage();
		if (message?.userInfo?.returnApp === true) {
			sendNativeMessage({ name: "OPEN_APP" });
		}
	}
	// if (message.name === "OPEN_EXTENSION_PAGE") {
	// 	openExtensionPage();
	// }
});

<script>
	import { onMount, onDestroy } from "svelte";
	import IconButton from "@shared/Components/IconButton.svelte";
	import Toggle from "@shared/Components/Toggle.svelte";
	import Loader from "@shared/Components/Loader.svelte";
	import ScriptCommands from "./Components/ScriptCommands.svelte";
	import View from "./Components/View.svelte";
	import UpdateView from "./Components/Views/UpdateView.svelte";
	import InstallView from "./Components/Views/InstallView.svelte";
	import AllItemsView from "./Components/Views/AllItemsView.svelte";
	import iconClear from "@shared/img/icon-clear.svg?raw";
	import iconRefresh from "@shared/img/icon-refresh.svg?raw";
	import { extensionPaths, openExtensionPage, parse } from "@ext/utils.js";
	import { connectNative, sendNativeMessage } from "@ext/native.js";
	import * as settingsStorage from "@ext/settings.js";

	function accessKey(event) {
		if (
			!event.isTrusted ||
			event.repeat ||
			event.defaultPrevented ||
			event.metaKey ||
			event.altKey ||
			event.ctrlKey ||
			event.key.length !== 1
		)
			return;
		if (["INPUT", "TEXTAREA", "SELECT"].includes(event.target?.tagName)) return;
		const buttons = [
			...document.querySelectorAll("button[data-ue-access-key]"),
		].filter(
			(button) =>
				!button.disabled &&
				button.dataset.ueAccessKey === event.key.toLowerCase(),
		);
		if (buttons.length === 1) {
			event.preventDefault();
			buttons[0].click();
		}
	}

	let errorNotification;
	let menuGroups = [];
	let currentTabId;
	let currentHost = "";
	let scriptSearch = "";
	let selectedFilename = "";
	$: selectedItem = items.find((item) => item.filename === selectedFilename);
	const SCRIPT_PREFS_KEY = "UE_SCRIPT_PREFS";
	let scriptPrefs = {};
	async function loadScriptPrefs() {
		try {
			const stored = await browser.storage.local.get(SCRIPT_PREFS_KEY);
			const value = stored?.[SCRIPT_PREFS_KEY];
			scriptPrefs = value && typeof value === "object" ? value : {};
		} catch (error) {
			errorNotification = String(error.message ?? error);
		}
	}
	async function setScriptPreference(item, key, value) {
		if (!item?.scriptId) return;
		const stored = (await browser.storage.local.get(SCRIPT_PREFS_KEY))?.[
			SCRIPT_PREFS_KEY
		];
		const next = stored && typeof stored === "object" ? { ...stored } : {};
		next[item.scriptId] = { ...(next[item.scriptId] ?? {}), [key]: value };
		await browser.storage.local.set({ [SCRIPT_PREFS_KEY]: next });
		scriptPrefs = next;
	}
	async function reloadCurrentTab() {
		if (currentTabId === undefined) return;
		await browser.tabs.reload(currentTabId);
		window.close();
	}
	async function openScriptInManager(item) {
		await openExtensionPage();
		const base = browser.runtime.getURL(extensionPaths.page);
		const tabs = await browser.tabs.query({});
		const page = tabs.find((tab) => tab.url?.startsWith(base));
		const params = new URLSearchParams({ script: item.filename });
		if (page)
			await browser.tabs.update(page.id, {
				url: `${base}#${params}`,
				active: true,
			});
		window.close();
	}
	let menuRequest = 0;
	async function refreshCommands() {
		if (currentTabId === undefined) return;
		const request = ++menuRequest;
		try {
			const response = await browser.runtime.sendMessage({
				name: "UE_MENU_LIST",
				tabId: currentTabId,
			});
			if (request !== menuRequest) return;
			if (!response?.ok)
				throw new Error(response?.error ?? "Command list unavailable");
			menuGroups = response.scripts;
		} catch (error) {
			if (request !== menuRequest) return;
			menuGroups = [];
			errorNotification = String(error.message ?? error);
		}
	}
	const menuMessage = (message, sender) => {
		if (
			sender.id === browser.runtime.id &&
			message?.name === "UE_MENU_REFRESH" &&
			message.tabId === currentTabId
		)
			refreshCommands();
	};
	browser.runtime.onMessage.addListener(menuMessage);
	onDestroy(() => browser.runtime.onMessage.removeListener(menuMessage));

	let active = true;
	let loading = true;
	let disabled = true;
	let items = [];
	let showUpdates = false;
	let updates = [];
	let main;
	let inactive = false;
	let platform;
	let initError;
	let firstGuide;
	let header;
	let warn;
	let err;
	let scriptChecking;
	let scriptInstalled;
	let showInstallPrompt;
	let showInstall;
	/**
	 * @typedef CheckedUserscript
	 * @prop {import("webextension-polyfill").Tabs.Tab} tab - checked tab
	 * @prop {URL} url - userjs/usercss url
	 * @prop {"js"|"css"} type - userscript or userstyle
	 * @prop {string} content - userjs/usercss content
	 */
	/** @type {CheckedUserscript} */
	let checkedUserscript;
	let installViewUserscript; // metadata
	let installViewUserscriptError;
	let showAll;
	let allItems = [];
	let abort = false;

	$: list = items
		.filter((item) =>
			item.name.toLowerCase().includes(scriptSearch.toLowerCase()),
		)
		.sort((a, b) => a.name.localeCompare(b.name));

	async function toggleExtension() {
		const keys = {};
		keys["global_active"] = !active;
		await settingsStorage.set(keys);
		active = await settingsStorage.get("global_active");
		if (!active)
			await browser.runtime.sendMessage({ name: "UE_MENU_INVALIDATE" });
		menuGroups = [];
		// TODO: delete after migrating all related logic on the native
		sendNativeMessage({ name: "TOGGLE_EXTENSION", active: String(active) });
	}

	async function updateAll() {
		await openExtensionPage();
		const url = browser.runtime.getURL(`${extensionPaths.page}#enhanced`);
		const tabs = await browser.tabs.query({});
		const tab = tabs.find((item) =>
			item.url?.startsWith(browser.runtime.getURL(extensionPaths.page)),
		);
		if (tab) await browser.tabs.update(tab.id, { url, active: true });
		window.close();
	}
	async function updateItem() {
		return updateAll();
	}

	async function toggleItem(item) {
		if (disabled) return;
		disabled = true;
		const response = await sendNativeMessage({ name: "TOGGLE_ITEM", item });
		if (response.error) {
			errorNotification = response.error;
		} else {
			const i = items.findIndex((el) => el === item);
			const j = allItems.findIndex((el) => el === item);
			item.disabled = !item.disabled;
			if (item.disabled)
				await browser.runtime.sendMessage({
					name: "UE_MENU_INVALIDATE",
					filename: item.filename,
				});
			await refreshCommands();
			items[i] = item;
			if (j >= 0) allItems[j] = item;
		}
		disabled = false;
	}

	function updateItems(states) {
		return Object.values(states ?? {})
			.filter((state) => state.available)
			.map((state) => ({
				filename: state.filename,
				name:
					items.find((item) => item.filename === state.filename)?.name ??
					state.filename,
				url: state.url,
			}));
	}
	async function checkForUpdates() {
		disabled = true;
		try {
			const result = await browser.runtime.sendMessage({
				name: "UE_UPDATE_CHECK",
			});
			if (!result?.ok)
				throw new Error(result?.error ?? "Update check unavailable");
			updates = updateItems(result.states);
		} catch (error) {
			errorNotification = String(error.message ?? error);
		} finally {
			disabled = false;
		}
	}

	function refreshView() {
		errorNotification = undefined;
		scriptChecking = undefined;
		scriptInstalled = undefined;
		showInstallPrompt = undefined;
		loading = true;
		disabled = true;
		items = [];
		showUpdates = false;
		updates = [];
		inactive = false;
		abort = false;
		initialize();
	}

	async function openSaveLocation() {
		disabled = true;
		loading = true;
		const response = await sendNativeMessage({ name: "OPEN_SAVE_LOCATION" });
		if (response.success) {
			window.close();
		} else if (response.items) {
			showAll = true;
			allItems = response.items;
		} else if (response.error) {
			console.error(`Error opening save location: ${response.error}`);
			errorNotification = response.error;
		}
		disabled = false;
		loading = false;
	}

	async function openContainingApp() {
		browser.tabs.executeScript({
			code: `location="${firstGuide}"`,
		});
		window.close();
	}

	async function initialize() {
		initError = false;
		try {
			await initializeData();
		} catch (error) {
			initError = true;
			errorNotification = String(error.message ?? error);
		} finally {
			loading = false;
			disabled = Boolean(inactive || initError);
		}
	}
	async function initializeData() {
		// get platform first since it applies important styling
		let pltfm;
		try {
			pltfm = await sendNativeMessage({ name: "REQ_PLATFORM" });
		} catch (error) {
			console.error(`Error for pltfm promise: ${error}`);
			initError = true;
			errorNotification = String(error.message ?? error);
			loading = false;
			return;
		}
		if (pltfm.error) {
			errorNotification = pltfm.error;
			loading = false;
			disabled = false;
			return;
		}
		platform = pltfm.platform;

		/* Override theme mode  */
		const theme = await settingsStorage.get("theme_mode");
		if (theme && theme !== "auto") {
			document.body.style.setProperty("color-scheme", theme);
		}

		// display native error if there is
		const errorNative = await settingsStorage.get("error_native");
		if (errorNative.error) {
			if (errorNative.saveLocation === "unset") {
				firstGuide = `${errorNative.scheme}://`;
				loading = false;
				return;
			}
			errorNotification = errorNative.error;
			loading = false;
			disabled = false;
			return;
		}

		// set toggle state
		active = await settingsStorage.get("global_active");

		// get matches
		const [currentTab] = await browser.tabs.query({
			active: true,
			currentWindow: true,
		});
		if (!currentTab) throw new Error("No active Safari tab available");
		currentTabId = currentTab.id;
		if (currentTab?.url?.startsWith("http"))
			currentHost = new URL(currentTab.url).host;
		refreshCommands();
		const url = currentTab.url;
		if (!url) {
			loading = false;
			disabled = false;
			return;
		}
		// strip fragments and query params
		const strippedUrl = url.split(/[?#]/)[0];
		if (strippedUrl === browser.runtime.getURL(extensionPaths.page)) {
			// disable popup on extension page
			inactive = true;
			loading = false;
			return;
		}
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
		let matches;
		try {
			matches = await sendNativeMessage({
				name: "POPUP_MATCHES",
				url,
				frameUrls: Array.from(frameUrls),
			});
		} catch (error) {
			console.error(`Error for matches promise: ${error}`);
			initError = true;
			errorNotification = String(error.message ?? error);
			loading = false;
			return;
		}
		if (matches.error) {
			errorNotification = matches.error;
			loading = false;
			disabled = false;
			return;
		}
		items = matches.matches;
		await loadScriptPrefs();
		updates = updateItems(
			(await browser.storage.local.get("UE_UPDATES")).UE_UPDATES,
		);

		// Update checks are explicit; opening the toolbar must never wait for network.

		// start async check
		installCheck(currentTab);

		loading = false;
		disabled = false;
	}

	async function abortUpdates() {
		// sends message to swift side canceling all URLSession tasks
		sendNativeMessage({ name: "CANCEL_REQUESTS" });
		// timestamp for checking updates happens right before update fetching
		// that means when this function runs the timestamp has already been saved
		// reloading the window will essentially skip the update check
		// since the subsequent popup load will not check for updates
		window.location.reload();
	}

	/** @type {import("svelte/elements").UIEventHandler<Window>} */
	// async function resizeHandler(event) {
	// 	if (platform !== "macos") {
	// 		const viewport = event.currentTarget.visualViewport;
	// 		console.debug(platform, viewport);
	// 		// add max limits after the window size has been rendered
	// 		// avoid display overflow when window shrinks dynamically
	// 	}
	// }

	/**
	 * Check if the current page contains a user script
	 * @param {import("webextension-polyfill").Tabs.Tab} currentTab
	 */
	async function installCheck(currentTab) {
		const tabUrl = new URL(currentTab.url);
		/** @type {URL} */
		let url;
		// check if current page url is a userscript
		if (tabUrl.pathname.endsWith(".user.js")) {
			url = tabUrl;
		} else {
			const res = await browser.tabs.sendMessage(
				currentTab.id,
				"TAB_CLICK_USERJS",
			);
			if (!res) return;
			url = new URL(res);
		}
		// set checking state
		scriptChecking = true;
		// show checking banner
		showInstallPrompt = "checking...";
		// refetch script from URL to avoid tampered DOM content
		let res; // fetch response
		try {
			res = await fetch(url);
			if (!res.ok) throw new Error(`httpcode-${res.status}`);
		} catch (error) {
			console.error("Error fetching .user.js url", error);
			errorNotification = `Userscript fetching failed (${res?.status ?? "network error"})`;
			showInstallPrompt = undefined;
			return;
		}
		let content = await res.text();
		const header = parse(content);
		if (header && !header.metadata.updateURL && !header.metadata.downloadURL)
			content = content.replace(
				"// ==/UserScript==",
				`// @downloadURL ${res.url || url.href}\n// ==/UserScript==`,
			);
		if (res.url) url = new URL(res.url);
		// caching script data
		checkedUserscript = { tab: currentTab, url, type: "js", content };
		// send native swift a message, parse metadata and check if installed
		const response = await sendNativeMessage({
			name: "POPUP_INSTALL_CHECK",
			content,
		});
		console.info("POPUP_INSTALL_CHECK:", response);
		if (response.error) {
			console.error(`Error checking .user.js url: ${response.error}`);
			// errorNotification = response.error;
			installViewUserscriptError = response.error;
		} else {
			scriptInstalled = response.installed;
			// caching script metadata
			installViewUserscript = response.metadata;
			// the response will contain the string to display
			// ex: {success: "Click to install"}
			showInstallPrompt = response.success;
		}
		scriptChecking = false;
		scriptInstalled || showInstallView();
	}

	async function showInstallView() {
		// show the install view
		showInstall = true;
	}

	async function installConfirm() {
		// clear all banner during installation
		errorNotification = undefined;
		showInstallPrompt = undefined;
		// disabled all buttons
		disabled = true;
		// show loading element
		loading = true;
		// go back to main view
		showInstall = false;
		// double check before send install message
		if (!checkedUserscript || !checkedUserscript.content) {
			errorNotification = "Install failed: userscript missing";
		}
		const currentTab = await browser.tabs.getCurrent();
		if (currentTab.id !== checkedUserscript.tab.id) {
			errorNotification = "Install failed: tab changed unexpectedly";
		}
		if (errorNotification) {
			disabled = false;
			loading = false;
			return;
		}
		// send native swift a message, which will start the install process
		const response = await sendNativeMessage({
			name: "POPUP_INSTALL_SCRIPT",
			url: checkedUserscript.url.href,
			type: checkedUserscript.type,
			content: checkedUserscript.content,
		});
		if (response.error) {
			errorNotification = response.error;
			disabled = false;
			loading = false;
			return;
		}
		// if response did not have an error, userscript installed successfully
		// refresh popup
		refreshView();
	}

	onMount(async () => {
		await initialize();
	});

	// handle native app messages
	let port;
	try {
		port = connectNative();
		port.onMessage.addListener((message) => {
			// console.info(message); // DEBUG
			if (message.name === "SAVE_LOCATION_CHANGED") {
				window.location.reload();
			}
		});
	} catch (error) {
		errorNotification = String(error.message ?? error);
	}
	onDestroy(() => port?.disconnect());

	async function gotoSettings() {
		await openExtensionPage();
		const url = browser.runtime.getURL(extensionPaths.page);
		const tabs = await browser.tabs.query({});
		const page = tabs.find((tab) => tab.url?.startsWith(url));
		if (page)
			await browser.tabs.update(page.id, {
				url: `${url}#state=settings`,
				active: true,
			});
		window.close();
	}

	async function gotoExtensionPage() {
		await openExtensionPage();
		window.close();
	}

	/**
	 * Temporary settings page entrance for beta test (iOS)
	 * @todo new permanent button will be added via popup refactoring
	 */
	let showBetaNews = true;
</script>

<svelte:window on:keydown={accessKey} />

{#if showUpdates}
	<View
		headerTitle="Updates"
		loading={disabled}
		closeClick={() => (showUpdates = false)}
		showLoaderOnDisabled={true}
		abortClick={abortUpdates}
		abort={showUpdates}
	>
		<UpdateView
			checkClick={checkForUpdates}
			updateClick={updateAll}
			updateSingleClick={updateItem}
			{updates}
		/>
	</View>
{:else if showInstall}
	<View
		headerTitle="Install Userscript"
		loading={disabled}
		closeClick={() => (showInstall = false)}
		showLoaderOnDisabled={true}
	>
		<InstallView
			userscript={installViewUserscript}
			sourceURL={checkedUserscript?.url?.href ?? ""}
			installError={installViewUserscriptError}
			installCancelClick={() => (showInstall = false)}
			installConfirmClick={installConfirm}
		/>
	</View>
{:else if showAll}
	<View
		headerTitle="All Userscripts"
		loading={disabled}
		closeClick={() => {
			showAll = false;
			refreshView();
		}}
		showLoaderOnDisabled={false}
	>
		<AllItemsView {allItems} allItemsToggleItem={toggleItem} />
	</View>
{:else}
	<div class="header" bind:this={header}>
		<div class="site-heading">
			<strong>{currentHost || "当前网页"}</strong><span
				>Userscripts Enhanced</span
			>
		</div>
		{#if items.length > 5}<input
				class="script-search"
				type="search"
				aria-label="Search scripts"
				placeholder="Search scripts"
				bind:value={scriptSearch}
			/>{/if}
		<div class="buttons">
			<span class="section-label">{items.length} 个匹配脚本</span>
			{#if updates.length}<button
					class="link"
					on:click={() => (showUpdates = true)}>更新 {updates.length}</button
				>{/if}
			<IconButton
				icon={iconRefresh}
				on:click={refreshView}
				title="刷新"
				disabled={loading}
			/>
			<Toggle
				checked={active}
				title="启用脚本运行"
				on:click={toggleExtension}
				{disabled}
			/>
		</div>
		{#if !active}
			<!-- <div class="warn" bind:this={warn}>Injection disabled</div> -->
		{/if}
		{#if showBetaNews && platform && platform !== "macos"}
			<div class="warn">
				NEW: <button on:click={gotoExtensionPage}><b>Settings page</b></button>
				is now available!
				<IconButton
					icon={iconClear}
					on:click={() => (showBetaNews = false)}
					title="Close"
				/>
			</div>
		{/if}
		{#if showInstallPrompt}
			<div class="warn" class:done={scriptInstalled} bind:this={warn}>
				Userscript
				{#if scriptChecking}
					{showInstallPrompt}
				{:else}
					{scriptInstalled ? "Installed" : "Detected"}:
					<button on:click={showInstallView}>{showInstallPrompt}</button>
				{/if}
			</div>
		{/if}
		{#if errorNotification}
			<div class="error" bind:this={err}>
				{errorNotification}
				<IconButton
					icon={iconClear}
					on:click={() => (errorNotification = undefined)}
					title="Clear error"
				/>
			</div>
		{/if}
	</div>
	<div class="main" bind:this={main}>
		{#if loading}
			<Loader abortClick={abortUpdates} {abort} />
		{:else if inactive}
			<div class="none">Popup inactive on extension page</div>
		{:else if firstGuide}
			<div class="none">
				<p>Welcome, first use please:&nbsp;</p>
				<button class="link" on:click={openContainingApp}>
					Open Userscripts App
				</button>
				<p>to complete the initialization</p>
			</div>
		{:else if initError}
			<div class="none">
				Something went wrong:&nbsp;
				<button class="link" on:click={() => window.location.reload()}>
					click to retry
				</button>
			</div>
		{:else if items.length < 1}
			<div class="none">No matched userscripts</div>
		{:else}
			<div class="items" class:disabled>
				{#if selectedItem}
					<ScriptCommands
						item={selectedItem}
						detail={true}
						groups={active
							? menuGroups.filter(
									(group) => group.filename === selectedItem.filename,
								)
							: []}
						toggle={() => toggleItem(selectedItem)}
						back={() => (selectedFilename = "")}
						preferences={(selectedItem?.scriptId &&
							scriptPrefs[selectedItem.scriptId]) ||
							{}}
						setPreference={(key, value) =>
							setScriptPreference(selectedItem, key, value)}
						openInManager={() => openScriptInManager(selectedItem)}
						reloadPage={reloadCurrentTab}
						refresh={refreshCommands}
						{disabled}
					/>
				{:else}
					{#each list as item (item.filename)}
						<ScriptCommands
							{item}
							groups={active
								? menuGroups.filter((group) => group.filename === item.filename)
								: []}
							toggle={() => toggleItem(item)}
							open={() => (selectedFilename = item.filename)}
							refresh={refreshCommands}
							{disabled}
						/>
					{/each}
				{/if}
			</div>
		{/if}
	</div>
	{#if !inactive && platform === "macos"}
		<div class="footer">
			<button class="link" on:click={openSaveLocation}>目录</button>
			<button class="link" on:click={gotoExtensionPage}> 管理脚本 </button>
			<button class="link" on:click={gotoSettings}>设置</button>
		</div>
	{/if}
{/if}

<style>
	.site-heading {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding: 0.75rem 1rem 0.25rem;
	}

	.site-heading span {
		color: var(--text-color-disabled);
		font: var(--text-small);
		overflow-wrap: anywhere;
	}

	.script-search {
		box-sizing: border-box;
		margin: 0.5rem 1rem;
		width: calc(100% - 2rem);
	}

	.header {
		background-color: var(--color-bg-secondary);
		position: sticky;
		top: 0;
		z-index: 1;
	}

	.header .buttons {
		gap: 16px;
		align-items: center;
		border-bottom: 1px solid var(--border-color);
		display: flex;
		padding: 0.5rem 1rem calc(0.5rem - 1px);
	}

	.section-label {
		flex: 1;
		color: var(--text-color-secondary);
		font-size: 12px;
	}

	.error,
	.warn {
		background-color: var(--color-red);
		color: var(--color-bg-secondary);
		font: var(--text-small);
		font-weight: 600;
		letter-spacing: var(--letter-spacing-small);
		line-height: 1.5rem;
		position: relative;
		text-align: center;
	}

	.error :global(button),
	.warn :global(button:has(svg)) {
		position: absolute;
		right: 0.5rem;
		top: 0;
	}

	.error :global(button svg),
	.warn :global(button svg) {
		transform: scale(0.5);
	}

	.warn {
		background-color: var(--color-yellow);
	}

	.warn.done {
		background-color: var(--color-green);
	}

	.warn button {
		background: none;
		color: inherit;
		border-bottom: 1px dotted var(--color-bg-secondary);
	}

	button {
		line-height: initial;
		font-weight: inherit;
	}

	.main {
		flex-grow: 1;
		min-height: 12.5rem;
		overflow-y: auto;
		position: relative;
	}

	.none {
		font-weight: 600;
		color: var(--text-color-disabled);
		text-align: center;
		padding: 3rem 0;
		line-height: 2.5;
	}

	.items.disabled {
		opacity: var(--opacity-disabled);
		pointer-events: none;
	}

	.footer {
		display: flex;
		justify-content: space-around;
		border-top: 1px solid var(--border-color);
		font-weight: 600;
		line-height: 1.5rem;
		padding: 0.5rem 0;
		text-align: center;
	}
</style>

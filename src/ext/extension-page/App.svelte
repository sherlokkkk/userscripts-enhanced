<script>
	import { onMount, onDestroy } from "svelte";
	import { blur } from "svelte/transition";
	import { items, log, notifications, settings, v4state } from "./store.js";
	import Sidebar from "./Components/Sidebar/Sidebar.svelte";
	import Editor from "./Components/Editor/Editor.svelte";
	import DataTools from "./Components/DataTools.svelte";
	import Settings from "./Components/Settings.svelte";
	import ModalWrapper from "./Components/ModalWrapper.svelte";
	import Notification from "./Components/Notification.svelte";
	import LogoText from "@shared/Components/LogoText.svelte";
	import { connectNative, sendNativeMessage } from "@ext/native.js";

	const logger = [];
	let showDataTools = location.hash.includes("enhanced");
	function handleHash() {
		if (location.hash.includes("enhanced")) {
			showDataTools = true;
			if ($v4state.includes("settings")) v4state.remove("settings");
		} else if (
			new URLSearchParams(location.hash.slice(1)).get("state") === "settings"
		) {
			showDataTools = false;
			if (!$v4state.includes("settings")) v4state.add("settings");
		}
	}
	function closeTools() {
		showDataTools = false;
		if (location.hash.includes("enhanced"))
			history.replaceState(null, "", `${location.pathname}${location.search}`);
	}

	$: $log.some((item) => {
		if (!logger.includes(item)) {
			console[item.type](item.message);
			logger.push(item);
		}
	});

	/* Override theme mode  */
	$: if ($settings["theme_mode"]) {
		if ($settings["theme_mode"] === "auto") {
			document.body.style.removeProperty("color-scheme");
		} else {
			document.body.style.setProperty("color-scheme", $settings["theme_mode"]);
		}
	}

	// disables default cmd+s (save) and cmd+f (find) behavior
	function preventKeyCommands(e) {
		if (e.metaKey && (e.code === "KeyS" || e.code === "KeyF")) {
			return e.preventDefault();
		}
	}

	// currently inactive, but could be used to globally prevent auto text replacement in app
	// function preventAutoTextReplacements(e) {
	// 	if (e.inputType === "insertReplacementText" && e.data === ". ") {
	// 		e.preventDefault();
	// 		e.target.value += " ";
	// 	}
	// }

	let initError = "";
	let initializing = false;
	let nativePort;
	async function initialize() {
		if (initializing) return;
		initializing = true;
		initError = "";
		v4state.remove("init-error");
		v4state.add("init");
		try {
			log.add("Requesting initialization data", "info", false);
			const initData = await sendNativeMessage({ name: "PAGE_INIT_DATA" });
			if (initData.error) throw new Error(initData.error);
			await settings.init(initData);
			v4state.add("items-loading");
			const files = await sendNativeMessage({ name: "PAGE_ALL_FILES" });
			if (files.error) throw new Error(files.error);
			items.set(files);
			v4state.remove("init");
			v4state.loadUrlState();
		} catch (error) {
			initError = String(error.message ?? error);
			v4state.add("init-error");
			log.add(initError, "error", false);
		} finally {
			v4state.remove("items-loading");
			initializing = false;
		}
	}
	onMount(() => {
		initialize();
		try {
			nativePort = connectNative();
			nativePort.onMessage.addListener((message) => {
				if (message.name === "SAVE_LOCATION_CHANGED") window.location.reload();
			});
		} catch (error) {
			log.add(String(error.message ?? error), "error", false);
		}
	});
	onDestroy(() => nativePort?.disconnect());

	let splitterActive = false;
	let sidebarHidden = false;
	let sidebarWidth = "23svw";
	const sidebarMinWidth = "20rem";
	const editorMinWidth = "20rem";

	function sidebarSwitch() {
		if (!sidebarHidden && !$items.find((i) => i.active)) {
			log.add("Please select or create a new item first.", "info", true);
			return;
		}
		sidebarHidden = !sidebarHidden;
	}

	function handleSplitterDrag(event) {
		if (event.type === "mouseup") {
			splitterActive = false;
		} else if (event.type === "mousedown") {
			splitterActive = true;
		} else if (event.type === "mousemove") {
			const vw = window.innerWidth;
			const sw = (event.x / vw) * 100;
			sidebarWidth = `max(min(${sw}svw, 100svw - ${editorMinWidth}), ${sidebarMinWidth})`;
		}
		event.preventDefault();
	}
</script>

<svelte:window on:keydown={preventKeyCommands} on:hashchange={handleHash} />

{#if $v4state.includes("init")}
	<div class="initializer" out:blur={{ duration: 350 }}>
		<LogoText />
		{#if $v4state.includes("init-error")}
			<p role="alert">{initError}</p>
			<button on:click={initialize} disabled={initializing}
				>Retry connection</button
			>
		{:else}
			<span>Initializing app...</span>
		{/if}
	</div>
{/if}
<button class="enhanced-tools" on:click={() => (showDataTools = true)}
	>Data &amp; Updates</button
>
<main
	style:--sidebar-width={sidebarWidth}
	style:--sidebar-min-width={sidebarMinWidth}
>
	{#if !sidebarHidden}
		<Sidebar {sidebarSwitch} />
		<div
			role="none"
			class="splitter"
			class:dragging={splitterActive}
			on:mousedown={handleSplitterDrag}
			on:mouseup={handleSplitterDrag}
		></div>
	{/if}
	<Editor {sidebarHidden} {sidebarSwitch} />
</main>
{#if splitterActive}
	<div
		role="none"
		class="resize-mask"
		on:mouseup={handleSplitterDrag}
		on:mousemove={handleSplitterDrag}
	></div>
{/if}
<ul>
	{#each $notifications as item (item.id)}
		<Notification on:click={() => notifications.remove(item.id)} {item} />
	{/each}
</ul>
{#if $v4state.includes("settings")}
	<ModalWrapper closeHandler={() => v4state.remove("settings")} let:navRegister>
		<Settings platform="macos" {nativePort} {navRegister} />
	</ModalWrapper>
{/if}

{#if showDataTools}
	<ModalWrapper closeHandler={closeTools}><DataTools /></ModalWrapper>
{/if}

<style>
	.enhanced-tools {
		position: fixed;
		right: 1rem;
		bottom: 1rem;
		z-index: 40;
		border: 1px solid var(--border-color);
		border-radius: 0.375rem;
		background: var(--color-bg-secondary);
		color: var(--text-color-primary);
		padding: 0.5rem 0.75rem;
	}

	.initializer {
		align-items: center;
		background-color: var(--color-bg-primary);
		display: flex;
		flex-direction: column;
		height: 100%;
		justify-content: center;
		left: 0;
		opacity: 1;
		position: absolute;
		top: 0;
		visibility: visible;
		width: 100%;
		z-index: 99;
	}

	.initializer :global(svg) {
		height: 1.5rem;
		margin-bottom: 0.5rem;
	}

	.initializer span {
		color: var(--text-color-secondary);
		font: var(--text-medium);
	}

	main {
		display: flex;
		flex: 1 0 0;
		overflow: hidden;
	}

	.resize-mask {
		background-color: transparent;
		cursor: col-resize;
		position: fixed;
		inset: 0;
		z-index: 20;
	}

	.splitter {
		--splitter-width: 6px;
		--splitter-offset: calc(var(--splitter-width) / 2);
		--sidebar-fixed-width: max(var(--sidebar-min-width), var(--sidebar-width));

		background-color: transparent;
		cursor: col-resize;
		position: fixed;
		left: calc(var(--sidebar-fixed-width) - var(--splitter-offset));
		width: var(--splitter-width);
		height: 100svh;
		z-index: 21;
		transition: background-color 0.2s ease-in-out;

		&:hover,
		&.dragging {
			background-color: var(--color-blue);
		}
	}

	ul {
		bottom: 1rem;
		left: 50%;
		position: fixed;
		transform: translateX(-50%);
		z-index: 98;
	}
</style>

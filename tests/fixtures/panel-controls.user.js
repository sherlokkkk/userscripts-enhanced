// ==UserScript==
// @name         Enhanced 控件示例
// @namespace    userscripts-enhanced.examples
// @version      1.0.0
// @match        http://localhost:8173/*
// @grant        UE.registerPanel
// @grant        GM_registerMenuCommand
// @grant        GM.registerMenuCommand
// @run-at       document-end
// ==/UserScript==
(() => {
	let scale = 1;
	let contrast = false;
	function apply() {
		document.body.style.fontSize = `${scale * 100}%`;
		document.body.style.filter = contrast ? "contrast(1.25)" : "";
	}
	if (
		typeof UE !== "undefined" &&
		UE.version === 1 &&
		typeof UE.registerPanel === "function"
	) {
		const handle = UE.registerPanel({
			version: 1,
			title: "阅读显示",
			controls: [
				{
					id: "scale",
					type: "range",
					label: "文字大小",
					min: 1,
					max: 1.5,
					step: 0.1,
					value: scale,
					onChange(value) {
						scale = value;
						apply();
					},
				},
				{
					id: "contrast",
					type: "toggle",
					label: "增强对比",
					value: contrast,
					onChange(value) {
						contrast = value;
						apply();
					},
				},
				{
					id: "reset",
					type: "button",
					label: "恢复默认",
					onClick() {
						scale = 1;
						contrast = false;
						apply();
						handle.update({ values: { scale, contrast } });
					},
				},
			],
		});
		window.addEventListener("pagehide", () => handle.dispose(), { once: true });
	} else {
		const register =
			typeof GM_registerMenuCommand === "function"
				? GM_registerMenuCommand
				: typeof GM !== "undefined" &&
					  typeof GM.registerMenuCommand === "function"
					? GM.registerMenuCommand.bind(GM)
					: undefined;
		if (register)
			Promise.resolve(
				register("切换阅读大小", () => {
					scale = scale === 1 ? 1.3 : 1;
					apply();
				}),
			).catch(console.warn);
		window.addEventListener("keydown", (event) => {
			if (event.altKey && event.shiftKey && event.code === "KeyR") {
				scale = scale === 1 ? 1.3 : 1;
				apply();
			}
		});
	}
})();

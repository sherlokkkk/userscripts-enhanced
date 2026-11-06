import { format } from "prettier";
import { mkdir, writeFile } from "node:fs/promises";
import { start } from "./helpers/engine-harness.js";
import {
	initialValues,
	isolationScripts,
} from "./helpers/isolation-scenarios.js";

const audit = await start(isolationScripts(), initialValues);
// Complete all asynchronous attack probes and storage round trips.
await new Promise((resolve) => setTimeout(resolve, 50));
const output = audit.host.document.getElementById("isolation-result");
const evidence = output ? JSON.parse(output.textContent) : null;
const snapshot = await audit.message({ name: "UE_MENU_SNAPSHOT" });
let callbacks = false;
if (evidence?.completed && snapshot?.scripts[0]) {
	const state = snapshot.scripts[0];
	const command = state.commands.find(
		(item) => item.title === "Isolated callback",
	);
	const control = state.panel.controls[0];
	const send = (commandId) => ({
		name: "UE_MENU_EXECUTE",
		documentId: snapshot.documentId,
		scriptId: "attacker",
		commandId,
	});
	const menu = await audit.message(send(command.commandId));
	const panel = await audit.message({
		...send(control.commandId),
		value: true,
	});
	const el = audit.host.document.getElementById("isolation-dom");
	callbacks =
		menu.ok &&
		panel.ok &&
		el.dataset.clicked === "yes" &&
		el.dataset.enabled === "true";
}
// Negative control: the same fixture must detect the original shared-realm
// Function vulnerability, using only a test-build transform and synthetic data.
const baseline = await start(isolationScripts(), initialValues, {}, true);
await new Promise((resolve) => setTimeout(resolve, 50));
const baselineOutput =
	baseline.host.document.getElementById("isolation-result");
const baselineEvidence = baselineOutput
	? JSON.parse(baselineOutput.textContent)
	: null;
const negativeControl =
	baselineEvidence?.results.find(
		(item) => item.name === "ambient browser.storage",
	)?.blocked === false;
const passed =
	negativeControl &&
	evidence?.completed === true &&
	evidence.results.length === 16 &&
	evidence.results.every((item) => item.blocked) &&
	callbacks &&
	JSON.stringify(evidence.own) === JSON.stringify({ allowed: [1, true] }) &&
	JSON.stringify(evidence.stored) ===
		JSON.stringify({ array: [1, { ok: true }] }) &&
	audit.host.privateMarker === undefined &&
	audit.host.Object.prototype.uePollution === undefined;
const report = {
	checkedAt: new Date().toISOString(),
	gate: "hostile-userscript-isolation",
	passed,
	finding: passed
		? "All explicit escape attempts blocked; granted storage, real DOM, menu and panel callbacks work."
		: "Isolation attack or positive control failed.",
	method:
		"Compile the actual entry and real DOM membrane, execute in JSDOM realms with synthetic extension APIs. Test-only observer does not replace the boundary.",
	safariVerified: false,
	evidence,
	callbacks,
	negativeControl,
	errors: audit.errors.map((items) =>
		items.map((item) => String(item?.message ?? item)),
	),
};
await mkdir("docs/reports", { recursive: true });
await writeFile(
	"docs/reports/sandbox-audit.json",
	await format(JSON.stringify(report), { parser: "json", useTabs: true }),
);
console.log(JSON.stringify(report, null, 2));
if (!passed) process.exitCode = 1;

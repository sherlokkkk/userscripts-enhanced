// Safari injects all_frames content scripts into the hidden script-realm
// iframes too: after near-membrane's document.open() they carry the page URL.
// There the global object is a userscript realm whose `browser` is denied on
// purpose, so no entry point may run (it would only fail, or worse, inject
// userscripts into the realm itself).
export const REALM_ATTRIBUTE = "data-ue-realm";
export const REALM_MARK = Symbol.for("userscripts-enhanced.realm");

export function insideScriptRealm() {
	try {
		if (globalThis[REALM_MARK] === true) return true;
	} catch {
		// Fall through to the frame check.
	}
	try {
		return window.frameElement?.hasAttribute?.(REALM_ATTRIBUTE) === true;
	} catch {
		return false;
	}
}

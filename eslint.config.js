/**
 * @file ESLint project configuration (New flat config)
 * @see {@link https://eslint.org/docs/latest/use/configure/configuration-files-new}
 * @see {@link https://eslint.org/docs/latest/use/configure/migration-guide}
 * @see {@link https://eslint.org/docs/latest/extend/plugin-migration-flat-config}
 * @see {@link https://eslint.org/blog/2022/08/new-config-system-part-1/}
 * @see {@link https://eslint.org/blog/2022/08/new-config-system-part-2/}
 */

import js from "@eslint/js";
import globals from "globals";
import eslintPluginSvelte from "eslint-plugin-svelte";
import eslintConfigPrettier from "eslint-config-prettier";

/** @type {import("eslint").Linter.Config[]} */
export default [
	/**
	 * @see {@link https://eslint.org/docs/latest/use/configure/configuration-files-new#using-predefined-configurations}
	 * @see {@link https://github.com/eslint/eslint/tree/main/packages/js}
	 */
	js.configs.recommended,

	/**
	 * @see {@link https://github.com/sveltejs/eslint-plugin-svelte}
	 */
	...eslintPluginSvelte.configs.recommended,
	...eslintPluginSvelte.configs.prettier,

	/**
	 * @see {@link https://github.com/prettier/eslint-config-prettier}
	 * turns off the conflict rules, put it last
	 */
	eslintConfigPrettier,

	/** custom config objects */

	/** @see {@link https://eslint.org/docs/latest/use/configure/configuration-files-new#globally-ignoring-files-with-ignores} */
	{
		ignores: [
			"**/dist/",
			"**/build/",
			"etc/",
			"xcode/",
			"public/",
			"artifacts/",
			"tests/reference/",
			"tests/local/",
		],
	},

	/** @see {@link https://eslint.org/docs/latest/use/configure/migration-guide#configuring-language-options} */
	{
		files: ["*.js", "scripts/**/*.js", "tests/**/*.js"],
		languageOptions: {
			globals: {
				...globals.node,
			},
		},
	},
	{
		files: ["src/{app,dev,shared}/**/*.{js,svelte}"],
		languageOptions: {
			globals: {
				...globals.browser,
			},
		},
	},
	{
		files: ["src/ext/**/*.{js,svelte}"],
		languageOptions: {
			globals: {
				...globals.browser,
				...globals.webextensions,
			},
		},
	},
	{
		files: ["tests/fixtures/*.user.js", "skills/**/assets/*.user.js"],
		languageOptions: {
			globals: {
				...globals.browser,
				GM: "readonly",
				UE: "readonly",
				GM_registerMenuCommand: "readonly",
				GM_unregisterMenuCommand: "readonly",
				GM_setValue: "readonly",
				GM_getValue: "readonly",
				GM_deleteValue: "readonly",
				GM_listValues: "readonly",
				GM_addValueChangeListener: "readonly",
				GM_removeValueChangeListener: "readonly",
				GM_xmlhttpRequest: "readonly",
				GM_addStyle: "readonly",
				GM_addElement: "readonly",
				GM_log: "readonly",
				GM_openInTab: "readonly",
				GM_getTab: "readonly",
				GM_saveTab: "readonly",
				GM_getTabs: "readonly",
				GM_setClipboard: "readonly",
			},
		},
	},
];

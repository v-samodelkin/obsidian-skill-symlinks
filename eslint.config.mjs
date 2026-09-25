import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	{ ignores: ["main.js", "node_modules/"] },
	...obsidianmd.configs.recommended,
	{
		languageOptions: {
			parserOptions: { projectService: { allowDefaultProject: ["eslint.config.mjs", "esbuild.config.mjs"] } },
		},
	},
	// node:test registers tests via returned promises that the runner awaits.
	{ files: ["test/**"], rules: { "@typescript-eslint/no-floating-promises": "off" } },
]);

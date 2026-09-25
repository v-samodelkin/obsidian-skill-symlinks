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
]);

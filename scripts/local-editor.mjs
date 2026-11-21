// Machine-local enrollment only. Credentials and their values are never printed.
import { buildSync } from "esbuild";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
const [action, vaultPath] = process.argv.slice(2);
if (!["enable", "disable"].includes(action) || !vaultPath) {
	console.error("Usage: npm run local-editor -- enable|disable <vault-path>");
	process.exit(2);
}
const source = buildSync({ entryPoints: ["src/editor/local.ts"], bundle: true, platform: "node", format: "cjs", write: false }).outputFiles[0].text;
const target = { exports: {} };
runInNewContext(source, { module: target, exports: target.exports, require: createRequire(import.meta.url), process, Buffer, TextEncoder });
target.exports.setLocalEditorEnabled(vaultPath, action === "enable");
process.stdout.write((action === "enable" ? "Local editor enrolled on this machine. Reload Skill Symlinks in Obsidian to activate it." : "Local editor disabled on this machine.") + "\n");

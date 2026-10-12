import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { buildSync } from "esbuild";
import type { Settings } from "../src/settings.ts";

const require = createRequire(import.meta.url);
const bundle = buildSync({
	entryPoints: ["src/main.ts"], bundle: true, platform: "node", format: "cjs",
	external: ["obsidian"], write: false,
}).outputFiles[0].text;

class Folder {
	path: string;
	constructor(value: string) { this.path = value; }
}

// Exercise the shipped plugin entry point with only Obsidian's host API stubbed.
async function loadPlugin(vaultPath: string, data: Partial<Settings>) {
	let saved = JSON.parse(JSON.stringify(data)) as Settings;
	const events = new Map<string, (file: Folder, oldPath?: string) => void>();
	class Adapter {
		getBasePath() { return vaultPath; }
	}
	class HostPlugin {
		app = {
			vault: { adapter: new Adapter(), on: (name: string, fn: (file: Folder, oldPath?: string) => void) => events.set(name, fn) },
			workspace: { onLayoutReady: (fn: () => void) => fn() },
		};
		loadData() { return Promise.resolve(saved); }
		saveData(value: Settings) {
			saved = JSON.parse(JSON.stringify(value)) as Settings;
			return Promise.resolve();
		}
		addSettingTab() {}
		addCommand() {}
		registerEvent() {}
	}
	const host = {
		Plugin: HostPlugin, FileSystemAdapter: Adapter, TFolder: Folder,
		Notice: class {}, PluginSettingTab: class {}, Modal: class {}, AbstractInputSuggest: class {},
		debounce: (fn: () => void) => fn,
	};
	const module = { exports: {} as { default: new () => { onload(): Promise<void>; settings: Settings } } };
	runInNewContext(bundle, {
		module, exports: module.exports, structuredClone,
		require: (name: string) => name === "obsidian" ? host : require(name) as unknown,
	});
	const plugin = new module.exports.default();
	await plugin.onload();
	return {
		plugin,
		data: () => saved,
		rename: (oldPath: string, newPath: string) => {
			fs.renameSync(path.join(vaultPath, oldPath), path.join(vaultPath, newPath));
			events.get("rename")!(new Folder(newPath), oldPath);
		},
	};
}

function fixture(enabled = true) {
	const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "skill-symlinks-plugin-")));
	const vault = path.join(tmp, "vault");
	const target = path.join(tmp, "agent");
	fs.mkdirSync(path.join(vault, "parent/skills/example"), { recursive: true });
	fs.writeFileSync(path.join(vault, "parent/skills/example/SKILL.md"), "example");
	fs.mkdirSync(target);
	return {
		tmp, vault, target,
		data: { enabled, skillsFolder: "parent/skills", requireSkillMd: true,
			targets: [{ path: target, enabled: true }], groups: [{ folder: "", skip: [] }] },
	};
}

test("plugin startup records existing links and repairs them after reopening a moved vault", async () => {
	const { tmp, vault, target, data } = fixture();
	fs.symlinkSync(path.join(vault, "parent/skills/example"), path.join(target, "example"), "junction");
	const first = await loadPlugin(vault, data);
	assert.equal(first.data().managedLinks[path.join(target, "example")], path.join(vault, "parent/skills/example"));
	const moved = path.join(tmp, "moved-vault");
	fs.renameSync(vault, moved);
	const second = await loadPlugin(moved, first.data());
	assert.equal(fs.readFileSync(path.join(target, "example/SKILL.md"), "utf8"), "example");
	assert.equal(second.data().managedLinks[path.join(target, "example")], path.join(moved, "parent/skills/example"));
});

test("a parent rename event persists the new skills folder and updates links", async () => {
	const { vault, target, data } = fixture();
	const host = await loadPlugin(vault, data);
	host.rename("parent", "renamed");
	assert.equal(host.data().skillsFolder, "renamed/skills");
	assert.equal(fs.realpathSync(path.join(target, "example")), path.join(vault, "renamed/skills/example"));
});

test("folder settings follow renames while sync is off without creating links", async () => {
	const { vault, target, data } = fixture(false);
	const host = await loadPlugin(vault, data);
	host.rename("parent", "renamed");
	assert.equal(host.data().skillsFolder, "renamed/skills");
	assert.deepEqual(fs.readdirSync(target), []);
});

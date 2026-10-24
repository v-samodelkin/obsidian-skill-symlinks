import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { buildSync } from "esbuild";
import type { Settings } from "../src/data.ts";
import type { Target } from "../src/model.ts";

// What the plugin saves: the settings with targets under their own key.
type Stored = Omit<Settings, "targets"> & { agentFolders: Target[] };

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
async function loadPlugin(vaultPath: string, data: object) {
	let saved = JSON.parse(JSON.stringify(data)) as Stored;
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
		saveData(value: Stored) {
			saved = JSON.parse(JSON.stringify(value)) as Stored;
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
		module, exports: module.exports, structuredClone, process,
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

test("1.0.x settings are left as they are until something changes", async () => {
	const { vault, data } = fixture(false);
	const host = await loadPlugin(vault, data);
	assert.deepEqual(host.data(), data);
	assert.equal(host.plugin.settings.version, 2);
});

test("1.0.x settings are written in the current format with the first sync record, and existing links stay", async () => {
	const { vault, target, data } = fixture();
	fs.symlinkSync(path.join(vault, "parent/skills/example"), path.join(target, "example"), "junction");
	const host = await loadPlugin(vault, data);
	const saved = host.data();
	assert.equal(saved.version, 2);
	assert.deepEqual(saved.agentFolders.map((t) => [t.kind, t.path, t.enabled]), [["folder", target, true]]);
	assert.deepEqual(saved.groups, [{ folder: "", routing: { mode: "all", except: [] } }]);
	assert.equal(fs.realpathSync(path.join(target, "example")), path.join(vault, "parent/skills/example"));
	const again = await loadPlugin(vault, saved);
	assert.deepEqual(again.data(), saved);
});

test("per-skill routing sends a skill to one Claude Code profile only", async () => {
	const { tmp, vault } = fixture();
	for (const profile of ["profile-a", "profile-b"]) fs.mkdirSync(path.join(tmp, profile, "skills"), { recursive: true });
	const host = await loadPlugin(vault, {
		version: 2,
		enabled: true,
		skillsFolder: "parent/skills",
		requireSkillMd: true,
		targets: [
			{ id: "a", label: "A", kind: "claude", path: path.join(tmp, "profile-a"), enabled: true },
			{ id: "b", label: "B", kind: "claude", path: path.join(tmp, "profile-b"), enabled: true },
		],
		groups: [{ folder: "", routing: { mode: "all", except: [] } }],
		skillRouting: { "parent/skills/example": { mode: "only", only: ["b"] } },
	});
	assert.deepEqual(fs.readdirSync(path.join(tmp, "profile-a/skills")), []);
	assert.equal(fs.realpathSync(path.join(tmp, "profile-b/skills/example")), path.join(vault, "parent/skills/example"));
	host.rename("parent/skills/example", "parent/skills/renamed");
	assert.deepEqual(Object.keys(host.data().skillRouting), ["parent/skills/renamed"]);
	assert.deepEqual(fs.readdirSync(path.join(tmp, "profile-a/skills")), []);
	assert.equal(fs.realpathSync(path.join(tmp, "profile-b/skills/renamed")), path.join(vault, "parent/skills/renamed"));
});

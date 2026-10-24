// Settings migration: 1.0.x data keeps its meaning, current data round-trips unchanged.
import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { SETTINGS_VERSION, defaultSettings, loadSettings } from "../src/data.ts";
import { claudeLabel, resolveTarget, targetFor } from "../src/model.ts";
import { apply, plan } from "../src/sync.ts";
import { FakeFs, fakeEnv } from "./fakefs.ts";

const home = path.resolve("/fake/home");
const env = fakeEnv(home);

// What 1.0.2 saved for a vault set up with both default folders and a group kept out of one of them.
const v1 = {
	enabled: true,
	skillsFolder: "skills",
	requireSkillMd: true,
	targets: [
		{ path: "~/.agents/skills", enabled: true },
		{ path: "~/.claude/skills", enabled: true },
		{ path: "~/.claude-work/skills", enabled: false },
		{ path: "~/.cursor/skills", enabled: true },
	],
	groups: [
		{ folder: "", skip: [] },
		{ folder: "claude-only", skip: ["~/.agents/skills", "~/.cursor/skills", "~/.gone/skills"] },
	],
	managedLinks: { "/x/link": "/vault/skills/a" },
};

test("a fresh install gets the shared agent folder and the default Claude Code profile", () => {
	const { settings, changed } = loadSettings(null);
	assert.equal(changed, false);
	assert.equal(settings.enabled, false);
	assert.deepEqual(
		settings.targets.map((t) => [t.id, t.kind, t.path, t.enabled]),
		[
			["agents", "folder", "~/.agents/skills", true],
			["claude", "claude", "~/.claude", true],
		],
	);
	assert.deepEqual(settings.groups, [{ folder: "", routing: { mode: "all", except: [] } }]);
	assert.deepEqual(settings, defaultSettings());
});

test("1.0.x settings migrate to profiles and exclusions that link to the same folders", () => {
	const { settings, changed } = loadSettings(structuredClone(v1));
	assert.equal(changed, true);
	assert.equal(settings.version, SETTINGS_VERSION);
	assert.deepEqual(
		settings.targets.map((t) => [t.id, t.label, t.kind, t.path, t.enabled]),
		[
			["agents", "Shared agent skills", "folder", "~/.agents/skills", true],
			["claude", "Claude Code", "claude", "~/.claude", true],
			["claude-work", "Claude Code (work)", "claude", "~/.claude-work", false],
			["cursor", "~/.cursor/skills", "folder", "~/.cursor/skills", true],
		],
	);
	// Every target still resolves to the folder 1.0.x linked into.
	for (const [i, target] of settings.targets.entries())
		assert.equal(resolveTarget(target, env).path, path.join(home, v1.targets[i].path.slice(1)));
	// Skip lists become exclusions, so a target added later still gets every group, as in 1.0.x.
	assert.deepEqual(settings.groups, [
		{ folder: "", routing: { mode: "all", except: [] } },
		{ folder: "claude-only", routing: { mode: "all", except: ["agents", "cursor"] } },
	]);
	assert.deepEqual(settings.skillRouting, {});
	assert.deepEqual(settings.managedLinks, v1.managedLinks);
	assert.equal(settings.enabled, true);
	assert.equal(settings.skillsFolder, "skills");
});

test("migrated settings plan the same links as 1.0.x", () => {
	const fs = new FakeFs();
	const vault = path.resolve("/fake/vault");
	fs.file(path.join(vault, "skills/review/SKILL.md")).file(path.join(vault, "skills/claude-only/tdd/SKILL.md"));
	for (const dir of [".agents/skills", ".claude/skills", ".claude-work/skills", ".cursor/skills"]) fs.dir(path.join(home, dir));
	const { settings } = loadSettings(structuredClone(v1));
	apply(plan({ vaultPath: vault, ...settings, managedLinks: {} }, { fs, env }), fs);
	const names = (dir: string) => Object.keys(fs.links(path.join(home, dir))).sort();
	assert.deepEqual(names(".agents/skills"), ["review"]);
	assert.deepEqual(names(".claude/skills"), ["review", "tdd"]);
	assert.deepEqual(names(".claude-work/skills"), []);
	assert.deepEqual(names(".cursor/skills"), ["review"]);
});

test("1.0.x defaults fill in missing fields the way 1.0.x read them", () => {
	const { settings } = loadSettings({ enabled: true, targets: [{ path: "~/a/skills" }] });
	assert.equal(settings.targets[0].enabled, false);
	assert.deepEqual(settings.groups, [{ folder: "", routing: { mode: "all", except: [] } }]);
	assert.equal(settings.requireSkillMd, true);
	assert.equal(settings.skillsFolder, "");
	assert.deepEqual(loadSettings({ enabled: false }).settings.targets, []);
});

test("current settings round-trip unchanged, and broken entries are repaired", () => {
	const migrated = loadSettings(structuredClone(v1)).settings;
	const again = loadSettings(JSON.parse(JSON.stringify(migrated)));
	assert.equal(again.changed, false);
	assert.deepEqual(again.settings, migrated);

	const { settings, changed } = loadSettings({
		version: 2,
		targets: [
			{ id: "a", label: "A", kind: "claude", path: "~/.claude" },
			{ id: "a", path: "~/b" },
			{ path: 3 },
		],
		groups: [{ folder: "", routing: { mode: "only", only: ["a", 1] } }, { folder: 2 }, { folder: "x", routing: "bad" }],
		skillRouting: { "skills/y": { mode: "nope" } },
		futureSetting: { kept: true },
	});
	assert.equal(changed, true);
	assert.deepEqual(
		settings.targets.map((t) => [t.id, t.label, t.kind, t.enabled]),
		[
			["a", "A", "claude", true],
			["b", "~/b", "folder", true],
		],
	);
	assert.deepEqual(settings.groups, [
		{ folder: "", routing: { mode: "only", only: ["a"] } },
		{ folder: "x", routing: { mode: "all", except: [] } },
	]);
	assert.deepEqual(settings.skillRouting, { "skills/y": { mode: "all", except: [] } });
	assert.deepEqual((settings as unknown as Record<string, unknown>).futureSetting, { kept: true });
});

test("new targets get readable ids and names", () => {
	assert.deepEqual(targetFor("~/.claude-work", "claude", ["claude"]), {
		id: "claude-work",
		label: "Claude Code (work)",
		kind: "claude",
		path: "~/.claude-work",
		enabled: true,
	});
	// A skills folder given for a profile is taken as its config folder.
	assert.equal(targetFor("~/.claude-work/skills/", "claude", []).path, "~/.claude-work");
	assert.equal(targetFor("~/.claude", "claude", ["claude"]).id, "claude-2");
	assert.deepEqual(targetFor("~/.my-agent/skills", "folder", []), {
		id: "my-agent",
		label: "~/.my-agent/skills",
		kind: "folder",
		path: "~/.my-agent/skills",
		enabled: true,
	});
	assert.equal(claudeLabel("/opt/profiles/claude-home"), "Claude Code (home)");
	assert.equal(claudeLabel("${CLAUDE_CONFIG_DIR}"), "Claude Code (${CLAUDE_CONFIG_DIR})");
});

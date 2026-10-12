import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, test } from "node:test";
import { type SyncConfig, apply, collectManagedLinks, plan, planRemoval } from "../src/sync.ts";
import { affectsConfiguredFolders, affectsSkillsFolder, followFolderRename } from "../src/rename.ts";

let tmp: string;
let cfg: SyncConfig;
const vault = () => path.join(tmp, "vault");
const agent = (name: string) => path.join(tmp, name);
const skill = (rel: string, withSkillMd = true) => {
	fs.mkdirSync(path.join(vault(), "skills", rel), { recursive: true });
	if (withSkillMd) fs.writeFileSync(path.join(vault(), "skills", rel, "SKILL.md"), "");
};
const links = (name: string) =>
	Object.fromEntries(
		fs
			.readdirSync(agent(name))
			.filter((n) => fs.lstatSync(path.join(agent(name), n)).isSymbolicLink())
			.map((n) => [n, path.relative(vault(), fs.readlinkSync(path.join(agent(name), n))).split(path.sep).join("/")]),
	);
const sync = () => apply(plan(cfg));

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "skill-symlinks-")));
	fs.mkdirSync(agent("claude"));
	fs.mkdirSync(agent("codex"));
	cfg = {
		vaultPath: vault(),
		skillsFolder: "skills",
		requireSkillMd: true,
		targets: [
			{ path: agent("claude"), enabled: true },
			{ path: agent("codex"), enabled: true },
		],
		groups: [
			{ folder: "", skip: [] },
			{ folder: "claude-only", skip: [agent("codex")] },
		],
	};
});

test("links top-level and group skills, routed per group", () => {
	skill("a");
	skill("claude-only/b");
	skill("draft", false);
	sync();
	assert.deepEqual(links("claude"), { a: "skills/a", b: "skills/claude-only/b" });
	assert.deepEqual(links("codex"), { a: "skills/a" });
});

test("follows renames, deletions and SKILL.md removal", () => {
	skill("a");
	skill("b");
	sync();
	fs.renameSync(path.join(vault(), "skills/a"), path.join(vault(), "skills/a2"));
	fs.rmSync(path.join(vault(), "skills/b/SKILL.md"));
	sync();
	assert.deepEqual(links("claude"), { a2: "skills/a2" });
	assert.deepEqual(plan(cfg), []);
});

test("leaves foreign entries alone and reports them", () => {
	skill("a");
	fs.mkdirSync(path.join(agent("claude"), "a"));
	fs.symlinkSync(tmp, path.join(agent("codex"), "other"), "junction");
	const ops = plan(cfg);
	assert.deepEqual(
		ops.map((op) => op.kind),
		["create", "conflict"],
	);
	apply(ops);
	assert.ok(fs.lstatSync(path.join(agent("claude"), "a")).isDirectory());
	assert.deepEqual(Object.keys(links("codex")).sort(), ["a", "other"]);
});

test("reports name clashes between groups", () => {
	skill("a");
	skill("claude-only/a");
	const conflicts = plan(cfg).filter((op) => op.kind === "conflict");
	assert.equal(conflicts.length, 1);
});

test("cleans up disabled targets, changed skills folder and on removal", () => {
	skill("a");
	sync();
	cfg.targets[1].enabled = false;
	sync();
	assert.deepEqual(links("codex"), {});
	skill("../other/x");
	cfg.skillsFolder = "other";
	sync();
	assert.deepEqual(links("claude"), { x: "other/x" });
	apply(planRemoval(cfg));
	assert.deepEqual(links("claude"), {});
});

test("skips missing targets", () => {
	skill("a");
	cfg.targets.push({ path: agent("missing"), enabled: true });
	sync();
	assert.equal(fs.existsSync(agent("missing")), false);
});

test("a group folder is not a skill even with SKILL.md", () => {
	skill("claude-only");
	skill("claude-only/b");
	sync();
	assert.deepEqual(links("claude"), { b: "skills/claude-only/b" });
});

test("repairs tracked links after the vault is renamed and reopened", () => {
	skill("a");
	skill("claude-only/b");
	sync();
	// Existing links from 1.0.0 are recorded on the first 1.0.1 sync.
	cfg.managedLinks = collectManagedLinks(cfg);
	const movedVault = path.join(tmp, "renamed-vault");
	fs.renameSync(vault(), movedVault);
	cfg = { ...JSON.parse(JSON.stringify(cfg)) as SyncConfig, vaultPath: movedVault };
	assert.deepEqual(sync().failed, []);
	assert.equal(fs.realpathSync(path.join(agent("claude"), "a")), path.join(movedVault, "skills/a"));
	assert.equal(fs.realpathSync(path.join(agent("claude"), "b")), path.join(movedVault, "skills/claude-only/b"));
	assert.equal(fs.existsSync(path.join(agent("codex"), "b")), false);
	assert.deepEqual(plan(cfg), []);
});

test("does not take over live links when a vault is copied", () => {
	skill("a");
	sync();
	cfg.managedLinks = collectManagedLinks(cfg);
	const copiedVault = path.join(tmp, "copied-vault");
	fs.cpSync(vault(), copiedVault, { recursive: true });
	cfg.vaultPath = copiedVault;
	assert.ok(plan(cfg).every((op) => op.kind === "conflict"));
	assert.equal(plan(cfg).length, 2);
});

test("preserves untracked broken links and links repointed by the user", () => {
	skill("a");
	sync();
	cfg.managedLinks = collectManagedLinks(cfg);
	const movedVault = path.join(tmp, "renamed-vault");
	fs.renameSync(vault(), movedVault);
	cfg.vaultPath = movedVault;
	fs.unlinkSync(path.join(agent("claude"), "a"));
	const foreign = path.join(tmp, "foreign-missing", "skills/a");
	fs.symlinkSync(foreign, path.join(agent("claude"), "a"), "junction");
	const foreignDest = fs.readlinkSync(path.join(agent("claude"), "a"));
	delete cfg.managedLinks[path.join(agent("codex"), "a")];
	assert.equal(plan(cfg).length, 2);
	assert.ok(plan(cfg).every((op) => op.kind === "conflict"));
	sync();
	assert.equal(fs.readlinkSync(path.join(agent("claude"), "a")), foreignDest);
});

test("keeps links while the adapter still points to an unavailable vault", () => {
	skill("a");
	sync();
	cfg.managedLinks = collectManagedLinks(cfg);
	fs.renameSync(vault(), path.join(tmp, "renamed-vault"));
	assert.deepEqual(plan(cfg), []);
	assert.deepEqual(collectManagedLinks(cfg), cfg.managedLinks);
});

test("retains ownership for unavailable targets and clears removed links", () => {
	skill("a");
	sync();
	cfg.managedLinks = collectManagedLinks(cfg);
	fs.renameSync(agent("claude"), agent("offline"));
	assert.deepEqual(collectManagedLinks(cfg), cfg.managedLinks);
	apply(planRemoval(cfg));
	assert.deepEqual(collectManagedLinks(cfg), {
		[path.join(agent("claude"), "a")]: path.join(vault(), "skills/a"),
	});
});

test("follows skills root and ancestor renames, preserving group routing", () => {
	skill("a");
	skill("claude-only/b");
	sync();
	fs.mkdirSync(path.join(vault(), "old"));
	fs.renameSync(path.join(vault(), "skills"), path.join(vault(), "old/skills"));
	assert.equal(followFolderRename(cfg, "skills", "old/skills"), true);
	sync();
	fs.renameSync(path.join(vault(), "old"), path.join(vault(), "new"));
	assert.equal(affectsSkillsFolder(cfg.skillsFolder, "old"), true);
	assert.equal(followFolderRename(cfg, "old", "new"), true);
	sync();
	assert.equal(cfg.skillsFolder, "new/skills");
	assert.deepEqual(links("claude"), { a: "new/skills/a", b: "new/skills/claude-only/b" });
	assert.deepEqual(links("codex"), { a: "new/skills/a" });
});

test("follows group and group ancestor renames without changing exclusions", () => {
	skill("claude-only/b");
	sync();
	fs.renameSync(path.join(vault(), "skills/claude-only"), path.join(vault(), "skills/private"));
	assert.equal(followFolderRename(cfg, "skills/claude-only", "skills/private"), true);
	sync();
	assert.deepEqual(cfg.groups[1], { folder: "private", skip: [agent("codex")] });
	assert.deepEqual(links("claude"), { b: "skills/private/b" });
	assert.deepEqual(links("codex"), {});
	cfg.groups[1].folder = "parent/private";
	assert.equal(followFolderRename(cfg, "skills/parent", "skills/renamed"), true);
	assert.equal(cfg.groups[1].folder, "renamed/private");
});

test("handles vault-root skills and ignores paths with only a shared prefix", () => {
	cfg.skillsFolder = "";
	cfg.groups[1].folder = "old/skills";
	assert.equal(followFolderRename(cfg, "old", "new"), true);
	assert.equal(cfg.skillsFolder, "");
	assert.equal(cfg.groups[0].folder, "");
	assert.equal(cfg.groups[1].folder, "new/skills");
	assert.equal(followFolderRename(cfg, "newer", "other"), false);
	assert.equal(affectsSkillsFolder("skills", "skills-other"), false);
	assert.equal(affectsSkillsFolder("skills-other", "skills"), false);
});

test("continues watching a group moved elsewhere in the vault", () => {
	skill("claude-only/b");
	sync();
	fs.renameSync(path.join(vault(), "skills/claude-only"), path.join(vault(), "private"));
	followFolderRename(cfg, "skills/claude-only", "private");
	sync();
	assert.deepEqual(links("claude"), { b: "private/b" });
	assert.deepEqual(links("codex"), {});
	assert.equal(affectsConfiguredFolders(cfg, "private/b/SKILL.md"), true);
	assert.equal(affectsConfiguredFolders(cfg, "unrelated/file.md"), false);
});

test("directory links are idempotent and removal preserves the source", () => {
	skill("a");
	assert.deepEqual(sync().failed, []);
	const link = path.join(agent("claude"), "a");
	assert.ok(fs.lstatSync(link).isSymbolicLink());
	assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(vault(), "skills/a")));
	assert.deepEqual(plan(cfg), []);
	assert.deepEqual(apply(planRemoval(cfg)).failed, []);
	assert.equal(fs.existsSync(link), false);
	assert.ok(fs.existsSync(path.join(vault(), "skills/a/SKILL.md")));
});

test("Windows junctions accept equivalent vault path spellings", { skip: process.platform !== "win32" }, () => {
	skill("a");
	assert.deepEqual(sync().failed, []);
	for (const vaultPath of [vault().toUpperCase(), vault().replaceAll("\\", "/"), path.toNamespacedPath(vault()), vault() + path.sep]) {
		const variant = { ...cfg, vaultPath };
		assert.deepEqual(plan(variant), [], vaultPath);
		assert.equal(planRemoval(variant).length, 2, vaultPath);
		assert.equal(Object.keys(collectManagedLinks(variant)).length, 2, vaultPath);
	}
});

test("Windows retains recorded junctions across target path spelling changes and a vault move", { skip: process.platform !== "win32" }, () => {
	skill("a");
	sync();
	cfg.managedLinks = collectManagedLinks(cfg);
	const moved = path.join(tmp, "moved-vault");
	fs.renameSync(vault(), moved);
	cfg.vaultPath = moved;
	cfg.targets = cfg.targets.map((target) => ({ ...target, path: path.toNamespacedPath(target.path.toUpperCase()) }));
	assert.deepEqual(sync().failed, []);
	assert.equal(fs.realpathSync(path.join(agent("claude"), "a")), fs.realpathSync(path.join(moved, "skills/a")));
	assert.deepEqual(plan(cfg), []);
	cfg.managedLinks = collectManagedLinks(cfg);
	assert.equal(Object.keys(cfg.managedLinks).length, 2);
	assert.deepEqual(apply(planRemoval(cfg)).failed, []);
	assert.deepEqual(collectManagedLinks(cfg), {});
});

test("does not claim a sibling vault with the same path prefix", () => {
	skill("a");
	const sibling = vault() + "-other";
	fs.mkdirSync(path.join(sibling, "skills/a"), { recursive: true });
	fs.symlinkSync(path.join(sibling, "skills/a"), path.join(agent("claude"), "a"), "junction");
	const ops = plan(cfg);
	assert.equal(ops.filter((op) => op.kind === "conflict").length, 1);
	assert.equal(ops.filter((op) => op.kind === "remove").length, 0);
	assert.deepEqual(collectManagedLinks(cfg), {});
	assert.deepEqual(planRemoval(cfg), []);
});

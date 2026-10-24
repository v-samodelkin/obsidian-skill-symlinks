// Planner edge cases: folders reached through symlinks, which links are ours, removing one target,
// and folders whose listing comes back short.
import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { type Target, type TargetKind } from "../src/model.ts";
import { type Context, type SyncConfig, apply, collectManagedLinks, plan, planRemoval } from "../src/sync.ts";
import { FakeFs, fakeEnv } from "./fakefs.ts";

const root = path.resolve("/fake");
const home = path.join(root, "home");
const vault = path.join(root, "vault");
const at = (...parts: string[]) => path.join(home, ...parts);
const target = (id: string, kind: TargetKind, p: string, enabled = true): Target => ({ id, label: id, kind, path: p, enabled });
const rel = (ops: { kind: string; link: string }[]) => ops.map((op) => `${op.kind} ${path.relative(home, op.link).split(path.sep).join("/")}`);

function setup(fs: FakeFs, vaultPath = vault) {
	const ctx: Context = { fs, env: fakeEnv(home) };
	const cfg: SyncConfig = {
		vaultPath,
		skillsFolder: "skills",
		requireSkillMd: true,
		targets: [target("agents", "folder", "~/.agents/skills"), target("claude", "claude", "~/.claude")],
		groups: [
			{ folder: "", routing: { mode: "all", except: [] } },
			{ folder: "personal", routing: { mode: "only", only: ["claude"] } },
		],
		skillRouting: {},
		configDir: ".obsidian",
	};
	return { ctx, cfg };
}

// Common setup: ~/.claude/skills is a symlink to ~/.agents/skills, so both default targets are one folder.
function aliased() {
	const fs = new FakeFs();
	fs.dir(at(".agents/skills")).file(at(".claude/settings.json")).link(at(".claude/skills"), at(".agents/skills"));
	fs.file(path.join(vault, "skills/review/SKILL.md")).file(path.join(vault, "skills/personal/journal/SKILL.md"));
	return { fs, ...setup(fs) };
}

test("targets that resolve to one folder through a symlink settle after one sync", () => {
	const { fs, ctx, cfg } = aliased();
	assert.deepEqual(apply(plan(cfg, ctx), fs).failed, []);
	assert.deepEqual(rel(plan(cfg, ctx)), []);
});

test("switching off one of two aliased targets does not delete the other's links", () => {
	const { fs, ctx, cfg } = aliased();
	apply(plan(cfg, ctx), fs);
	apply(plan(cfg, ctx), fs);
	apply(plan(cfg, ctx), fs);
	cfg.targets[1].enabled = false; // the Claude profile is off, ~/.agents/skills still wants review
	assert.deepEqual(rel(plan(cfg, ctx)).filter((op) => op.endsWith("/review")), []);
});

test("a vault does not claim links into a vault nested inside it", () => {
	const fs = new FakeFs();
	const nested = path.join(vault, "work");
	fs.dir(at(".agents/skills")).file(at(".claude/settings.json")).dir(at(".claude/skills"));
	fs.file(path.join(vault, "skills/review/SKILL.md")).file(path.join(nested, "skills/x/SKILL.md"));
	fs.link(at(".claude/skills/x"), path.join(nested, "skills/x")); // made by the nested vault's own plugin
	const { ctx, cfg } = setup(fs);
	assert.deepEqual(rel(plan(cfg, ctx)).filter((op) => op.startsWith("remove")), []);
});

test("a hand-made link into the vault that is not a skill is left alone", () => {
	const fs = new FakeFs();
	fs.dir(at(".agents/skills")).file(at(".claude/settings.json")).dir(at(".claude/skills"));
	fs.file(path.join(vault, "skills/review/SKILL.md")).dir(path.join(vault, "Notes/project"));
	fs.link(at(".claude/skills/project-notes"), path.join(vault, "Notes/project"));
	const { ctx, cfg } = setup(fs);
	apply(plan(cfg, ctx), fs);
	assert.equal(fs.kind(at(".claude/skills/project-notes")), "link");
});

test("removing one target plans only removals in that target", () => {
	const fs = new FakeFs();
	fs.dir(at(".agents/skills")).file(at(".claude/settings.json")).dir(at(".claude/skills"));
	fs.file(at(".claude-work/.claude.json")).dir(at(".claude-work/skills"));
	fs.file(path.join(vault, "skills/review/SKILL.md"));
	const { ctx, cfg } = setup(fs);
	cfg.targets.push(target("work", "claude", "~/.claude-work"));
	apply(plan(cfg, ctx), fs);
	fs.file(path.join(vault, "skills/lint/SKILL.md")); // not synced yet
	assert.deepEqual(rel(planRemoval(cfg, ctx, ["work"])), ["remove .claude-work/skills/review"]);
});

class PartlyUnreadableFs extends FakeFs {
	unreadable = new Set<string>();
	list(dir: string): string[] | null {
		// A listing that comes back empty although the folder has entries.
		return this.unreadable.has(path.resolve(dir)) ? [] : super.list(dir);
	}
}

test("a target folder that cannot be listed keeps its recorded links", () => {
	const fs = new PartlyUnreadableFs();
	fs.dir(at(".agents/skills")).file(at(".claude/settings.json")).dir(at(".claude/skills"));
	fs.file(path.join(vault, "skills/review/SKILL.md"));
	const { ctx, cfg } = setup(fs);
	apply(plan(cfg, ctx), fs);
	cfg.managedLinks = collectManagedLinks(cfg, ctx);
	const before = Object.keys(cfg.managedLinks).filter((l) => l.includes(".claude"));
	assert.equal(before.length, 1);
	fs.unreadable.add(at(".claude/skills"));
	const after = Object.keys(collectManagedLinks(cfg, ctx)).filter((l) => l.includes(".claude"));
	assert.deepEqual(after, before);
});

test("removing one of two aliased targets removes only what the other does not want", () => {
	const { fs, ctx, cfg } = aliased();
	apply(plan(cfg, ctx), fs);
	// journal goes only to the Claude profile; review goes to both and stays.
	assert.deepEqual(rel(planRemoval(cfg, ctx, ["claude"])), ["remove .agents/skills/journal"]);
	assert.deepEqual(rel(planRemoval(cfg, ctx)).sort(), ["remove .agents/skills/journal", "remove .agents/skills/review"]);
});

test("a vault inside the skills folder keeps its own links", () => {
	const fs = new FakeFs();
	fs.dir(at(".agents/skills")).file(at(".claude/settings.json")).dir(at(".claude/skills"));
	fs.dir(path.join(vault, "skills/team/.obsidian")).file(path.join(vault, "skills/team/x/SKILL.md"));
	fs.link(at(".claude/skills/x"), path.join(vault, "skills/team/x"));
	const { ctx, cfg } = setup(fs);
	assert.deepEqual(rel(plan(cfg, ctx)), []);
	assert.deepEqual(collectManagedLinks(cfg, ctx), {});
});

test("a hand-made link that an earlier version recorded is still left alone", () => {
	const fs = new FakeFs();
	fs.dir(at(".agents/skills")).file(at(".claude/settings.json")).dir(at(".claude/skills"));
	fs.dir(path.join(vault, "Notes/project"));
	fs.link(at(".claude/skills/project-notes"), path.join(vault, "Notes/project"));
	const { ctx, cfg } = setup(fs);
	// 1.0.1 and 1.0.2 recorded every link into the vault.
	cfg.managedLinks = { [at(".claude/skills/project-notes")]: path.join(vault, "Notes/project") };
	assert.deepEqual(rel(plan(cfg, ctx)), []);
	assert.deepEqual(collectManagedLinks(cfg, ctx), {});
});

class UnreadableFs extends FakeFs {
	unreadable = new Set<string>();
	list(dir: string): string[] | null {
		return this.unreadable.has(path.resolve(dir)) ? null : super.list(dir);
	}
}

test("a target folder that cannot be read is reported and left unchanged", () => {
	const fs = new UnreadableFs();
	fs.dir(at(".agents/skills")).file(at(".claude/settings.json")).dir(at(".claude/skills"));
	fs.file(path.join(vault, "skills/review/SKILL.md"));
	const { ctx, cfg } = setup(fs);
	apply(plan(cfg, ctx), fs);
	cfg.managedLinks = collectManagedLinks(cfg, ctx);
	fs.unreadable.add(at(".claude/skills"));
	cfg.groups[0].routing = { mode: "only", only: ["agents"] };
	const ops = plan(cfg, ctx);
	assert.deepEqual(
		ops.map((op) => [op.kind, op.link, op.kind === "conflict" ? op.reason : ""]),
		[["conflict", at(".claude/skills"), "this folder cannot be read, so nothing in it was changed"]],
	);
	assert.deepEqual(collectManagedLinks(cfg, ctx), cfg.managedLinks);
});

function caseInsensitive() {
	const fs = new FakeFs({ ignoreCase: true });
	fs.dir(at(".agents/skills")).file(at(".claude/settings.json")).dir(at(".claude/skills"));
	return { fs, ...setup(fs) };
}

test("skills whose names differ only in case are a clash where the folder ignores case", () => {
	const { fs, ctx, cfg } = caseInsensitive();
	fs.file(path.join(vault, "skills/Lint/SKILL.md")).file(path.join(vault, "skills/personal/lint/SKILL.md"));
	const ops = plan(cfg, ctx);
	const clash = ops.filter((op) => op.kind === "conflict");
	assert.deepEqual(clash.map((op) => op.target), ["claude"]);
	assert.match(clash[0].kind === "conflict" ? clash[0].reason : "", /differ only in letter case/);
	assert.deepEqual(apply(ops, fs).failed, []);
	assert.deepEqual(Object.keys(fs.links(at(".claude/skills"))), ["Lint"]);
	assert.deepEqual(plan(cfg, ctx).filter((op) => op.kind !== "conflict"), []);
});

test("a rename that changes only letter case replaces the link in one sync", () => {
	const { fs, ctx, cfg } = caseInsensitive();
	fs.file(path.join(vault, "skills/Review/SKILL.md"));
	apply(plan(cfg, ctx), fs);
	fs.drop(path.join(vault, "skills/Review")).file(path.join(vault, "skills/review/SKILL.md"));
	assert.deepEqual(rel(plan(cfg, ctx)), [
		"remove .agents/skills/Review",
		"remove .claude/skills/Review",
		"create .agents/skills/review",
		"create .claude/skills/review",
	]);
	assert.deepEqual(apply(plan(cfg, ctx), fs).failed, []);
	assert.deepEqual(Object.keys(fs.links(at(".claude/skills"))), ["review"]);
	assert.deepEqual(plan(cfg, ctx), []);
});

test("while a per-skill choice has no skill, new skills next to it are linked nowhere", () => {
	const fs = new FakeFs();
	fs.dir(at(".agents/skills")).file(at(".claude/settings.json")).dir(at(".claude/skills"));
	fs.file(path.join(vault, "skills/review/SKILL.md")).file(path.join(vault, "skills/journal/SKILL.md"));
	const { ctx, cfg } = setup(fs);
	cfg.skillRouting = { "skills/journal": { mode: "only", only: ["claude"] } };
	apply(plan(cfg, ctx), fs);
	cfg.managedLinks = collectManagedLinks(cfg, ctx);
	// Renamed outside Obsidian: the choice stays on the old path.
	fs.drop(path.join(vault, "skills/journal")).file(path.join(vault, "skills/diary/SKILL.md"));
	const ops = plan(cfg, ctx);
	assert.deepEqual(rel(ops.filter((op) => op.kind !== "conflict")), ["remove .claude/skills/journal"]);
	const held = ops.filter((op) => op.kind === "conflict");
	assert.deepEqual(held.map((op) => [op.name, op.target]), [["diary", null]]);
	assert.match(held[0].kind === "conflict" ? held[0].reason : "", /custom folders are kept for skills\/journal/);
	// Handing the choice to the renamed skill sends it where the old one went.
	cfg.skillRouting = { "skills/diary": cfg.skillRouting["skills/journal"] };
	assert.deepEqual(rel(plan(cfg, ctx)), ["remove .claude/skills/journal", "create .claude/skills/diary"]);
});

test("skills that were already linked are not held back", () => {
	const fs = new FakeFs();
	fs.dir(at(".agents/skills")).file(at(".claude/settings.json")).dir(at(".claude/skills"));
	fs.file(path.join(vault, "skills/review/SKILL.md"));
	const { ctx, cfg } = setup(fs);
	apply(plan(cfg, ctx), fs);
	cfg.managedLinks = collectManagedLinks(cfg, ctx);
	cfg.skillRouting = { "skills/gone": { mode: "only", only: [] } };
	assert.deepEqual(plan(cfg, ctx), []);
});

// 1.0 claimed every link into the vault. A config folder above the skills, for example in a parent of
// the skills folder that was once opened as a vault of its own, must not hide this vault's links.
for (const [skillsFolder, configAt] of [
	["AI/skills", "AI"],
	["skills", "skills"],
	["skills", "skills/personal"],
])
	test(`after upgrading from 1.0, a config folder in ${configAt} does not hide links to skills in ${skillsFolder}`, () => {
		const fs = new FakeFs();
		fs.dir(at(".agents/skills")).file(at(".claude/settings.json")).dir(at(".claude/skills"));
		const { ctx, cfg } = setup(fs);
		cfg.skillsFolder = skillsFolder;
		const skills = path.join(vault, skillsFolder);
		fs.dir(path.join(vault, configAt, ".obsidian"));
		for (const name of ["review", "lint", "personal/journal"]) fs.file(path.join(skills, name, "SKILL.md"));
		// What 1.0.1 and 1.0.2 left: every skill linked where its group goes, and recorded.
		cfg.managedLinks = {};
		for (const [dir, names] of [
			[".agents/skills", ["review", "lint"]],
			[".claude/skills", ["review", "lint", "personal/journal"]],
		] as const)
			for (const name of names) {
				const link = at(dir, path.basename(name));
				fs.link(link, path.join(skills, name));
				cfg.managedLinks[link] = path.join(skills, name);
			}
		assert.deepEqual(rel(plan(cfg, ctx)), []);
		assert.deepEqual(collectManagedLinks(cfg, ctx), cfg.managedLinks);

		// Outside Obsidian, lint is deleted and review renamed: the stale links go, as in 1.0.
		fs.drop(path.join(skills, "lint")).drop(path.join(skills, "review")).file(path.join(skills, "review-v2/SKILL.md"));
		assert.deepEqual(rel(plan(cfg, ctx)).sort(), [
			"create .agents/skills/review-v2",
			"create .claude/skills/review-v2",
			"remove .agents/skills/lint",
			"remove .agents/skills/review",
			"remove .claude/skills/lint",
			"remove .claude/skills/review",
		]);
		assert.deepEqual(apply(plan(cfg, ctx), fs).failed, []);
		cfg.managedLinks = collectManagedLinks(cfg, ctx);
		assert.equal(Object.keys(cfg.managedLinks).length, 3);
		assert.deepEqual(plan(cfg, ctx), []);

		// Turning a folder off unlinks it, and "Remove all links" removes every link.
		cfg.targets[1].enabled = false;
		assert.deepEqual(rel(plan(cfg, ctx)).sort(), ["remove .claude/skills/journal", "remove .claude/skills/review-v2"]);
		cfg.targets[1].enabled = true;
		assert.deepEqual(rel(planRemoval(cfg, ctx)).sort(), [
			"remove .agents/skills/review-v2",
			"remove .claude/skills/journal",
			"remove .claude/skills/review-v2",
		]);
	});

test("after upgrading from 1.0, a case-only clash keeps the link where 1.0 left it", () => {
	const { fs, ctx, cfg } = caseInsensitive();
	fs.file(path.join(vault, "skills/Lint/SKILL.md")).file(path.join(vault, "skills/personal/lint/SKILL.md"));
	// 1.0 linked personal/lint first; once Lint appeared it failed to link it on every sync.
	fs.link(at(".agents/skills/Lint"), path.join(vault, "skills/Lint"));
	fs.link(at(".claude/skills/lint"), path.join(vault, "skills/personal/lint"));
	const ops = plan(cfg, ctx);
	assert.deepEqual(rel(ops), ["conflict .claude/skills/Lint"]);
	assert.equal(ops[0].target, "claude");
	assert.match(ops[0].kind === "conflict" ? ops[0].reason : "", /differ only in letter case/);
	assert.deepEqual(apply(ops, fs).failed, []);
	assert.deepEqual(fs.links(at(".claude/skills")), { lint: path.join(vault, "skills/personal/lint") });
	assert.deepEqual(rel(plan(cfg, ctx)), ["conflict .claude/skills/Lint"]);
});

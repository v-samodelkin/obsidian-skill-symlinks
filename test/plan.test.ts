// Planner tests against an in-memory filesystem: routing, cleanup and ownership rules.
import assert from "node:assert/strict";
import * as path from "node:path";
import { beforeEach, test } from "node:test";
import { findClaudeConfigs, unlinkedClaudeConfigs } from "../src/discover.ts";
import { type Target, type TargetKind, setMode, setRoute } from "../src/model.ts";
import { resolvePath } from "../src/paths.ts";
import { followFolderRename } from "../src/rename.ts";
import { noticeLines, previewSections } from "../src/report.ts";
import { type Context, type Op, type SyncConfig, apply, collectManagedLinks, plan, planRemoval } from "../src/sync.ts";
import { FakeFs, fakeEnv } from "./fakefs.ts";

const root = path.resolve("/fake");
const home = path.join(root, "home");
const vault = path.join(root, "vault");
const at = (...parts: string[]) => path.join(home, ...parts);
const skillsOf = (config: string) => at(config, "skills");

let fs: FakeFs;
let ctx: Context;
let cfg: SyncConfig;

const target = (id: string, kind: TargetKind, p: string, enabled = true): Target => ({ id, label: id, kind, path: p, enabled });
const skill = (rel: string) => fs.file(path.join(vault, "skills", rel, "SKILL.md"));
const sync = () => apply(plan(cfg, ctx), fs);
// Link name -> destination relative to the vault, with "/" separators.
const linked = (dir: string) =>
	Object.fromEntries(
		Object.entries(fs.links(dir)).map(([name, dest]) => [name, path.relative(vault, dest).split(path.sep).join("/")]),
	);
const kinds = (ops: Op[]) => ops.map((op) => `${op.kind} ${path.relative(home, op.link).split(path.sep).join("/")}`);

beforeEach(() => {
	fs = new FakeFs();
	fs.dir(vault).dir(at(".agents/skills"));
	fs.file(at(".claude/settings.json")).dir(at(".claude/skills"));
	fs.file(at(".claude-work/.claude.json")).dir(at(".claude-work/skills"));
	ctx = { fs, env: fakeEnv(home) };
	cfg = {
		vaultPath: vault,
		skillsFolder: "skills",
		requireSkillMd: true,
		targets: [target("agents", "folder", "~/.agents/skills"), target("claude", "claude", "~/.claude"), target("work", "claude", "~/.claude-work")],
		groups: [
			{ folder: "", routing: { mode: "all", except: [] } },
			{ folder: "personal", routing: { mode: "only", only: ["claude"] } },
		],
		skillRouting: {},
	};
});

test("links each group into the targets it is routed to", () => {
	skill("review");
	skill("personal/journal");
	assert.deepEqual(sync().failed, []);
	assert.deepEqual(linked(at(".agents/skills")), { review: "skills/review" });
	assert.deepEqual(linked(skillsOf(".claude")), { journal: "skills/personal/journal", review: "skills/review" });
	assert.deepEqual(linked(skillsOf(".claude-work")), { review: "skills/review" });
	assert.deepEqual(plan(cfg, ctx), []);
});

test("a target added later joins groups routed to all, not groups routed to a selection", () => {
	skill("review");
	skill("personal/journal");
	sync();
	fs.dir(at(".cursor/skills"));
	cfg.targets.push(target("cursor", "folder", "~/.cursor/skills"));
	assert.deepEqual(kinds(plan(cfg, ctx)), ["create .cursor/skills/review"]);
});

test("per-skill routing replaces the group's and moves the link when changed", () => {
	skill("review");
	skill("journal");
	cfg.skillRouting = { "skills/journal": { mode: "only", only: ["claude"] } };
	sync();
	assert.deepEqual(Object.keys(linked(at(".agents/skills"))), ["review"]);
	assert.deepEqual(Object.keys(linked(skillsOf(".claude"))).sort(), ["journal", "review"]);
	assert.deepEqual(Object.keys(linked(skillsOf(".claude-work"))), ["review"]);

	cfg.skillRouting["skills/journal"] = { mode: "only", only: ["work"] };
	assert.deepEqual(kinds(plan(cfg, ctx)), ["remove .claude/skills/journal", "create .claude-work/skills/journal"]);
	sync();
	delete cfg.skillRouting["skills/journal"];
	assert.deepEqual(kinds(plan(cfg, ctx)), ["create .agents/skills/journal", "create .claude/skills/journal"]);
});

test("unrouting removes only links into this vault and leaves everything else alone", () => {
	skill("review");
	sync();
	fs.dir(at(".claude-work/skills/notes"));
	fs.link(at(".claude-work/skills/tool"), path.join(root, "elsewhere/tool"));
	fs.dir(path.join(root, "other-vault/skills/x")).link(at(".claude-work/skills/x"), path.join(root, "other-vault/skills/x"));
	cfg.groups[0].routing = { mode: "only", only: ["claude"] };
	assert.deepEqual(kinds(plan(cfg, ctx)), ["remove .agents/skills/review", "remove .claude-work/skills/review"]);
	sync();
	assert.deepEqual(Object.keys(fs.links(at(".claude-work/skills"))).sort(), ["tool", "x"]);
	assert.equal(fs.kind(at(".claude-work/skills/notes")), "dir");
});

test("a Claude profile without a skills folder is skipped until it has one", () => {
	skill("review");
	fs.file(at(".claude-new/settings.json"));
	cfg.targets.push(target("new", "claude", "~/.claude-new"));
	sync();
	assert.equal(fs.isDir(skillsOf(".claude-new")), false);
	fs.dir(skillsOf(".claude-new"));
	assert.deepEqual(kinds(plan(cfg, ctx)), ["create .claude-new/skills/review"]);
});

test("targets that name the same folder share one set of links", () => {
	skill("review");
	cfg.targets.push(target("same", "folder", "~/.claude/skills", false));
	assert.deepEqual(sync().failed, []);
	assert.deepEqual(Object.keys(linked(skillsOf(".claude"))), ["review"]);
	cfg.targets[3].enabled = true;
	cfg.targets[1].enabled = false;
	assert.deepEqual(plan(cfg, ctx), []);
});

test("removing a target or changing its path cleans up the links recorded there", () => {
	skill("review");
	sync();
	cfg.managedLinks = collectManagedLinks(cfg, ctx);
	cfg.targets = cfg.targets.filter((t) => t.id !== "work");
	const ops = plan(cfg, ctx);
	assert.deepEqual(kinds(ops), ["remove .claude-work/skills/review"]);
	assert.equal(ops[0].kind === "remove" && ops[0].target, null);
	sync();
	cfg.managedLinks = collectManagedLinks(cfg, ctx);
	assert.equal(Object.keys(cfg.managedLinks).some((link) => link.includes(".claude-work")), false);

	fs.dir(at(".agents-new/skills"));
	cfg.targets[0].path = "~/.agents-new/skills";
	assert.deepEqual(kinds(plan(cfg, ctx)), ["remove .agents/skills/review", "create .agents-new/skills/review"]);
});

test("cleanup of old folders waits while a target path cannot be resolved", () => {
	skill("review");
	sync();
	cfg.managedLinks = collectManagedLinks(cfg, ctx);
	cfg.targets = cfg.targets.filter((t) => t.id !== "work");
	cfg.targets.push(target("env", "folder", "$SKILLS_HOME/skills"));
	assert.deepEqual(plan(cfg, ctx), []);
	assert.deepEqual(collectManagedLinks(cfg, ctx), cfg.managedLinks);
	fs.dir(path.join(root, "shared/skills"));
	ctx.env.vars.SKILLS_HOME = path.join(root, "shared");
	assert.deepEqual(kinds(plan(cfg, ctx)), ["remove .claude-work/skills/review", "create ../shared/skills/review"]);
});

test("target paths expand ~ and environment variables", () => {
	const env = fakeEnv(home, { WORK: at(".claude-work"), EMPTY: "" });
	assert.equal(resolvePath("~", env).path, home);
	assert.equal(resolvePath(" ~/.claude ", env).path, at(".claude"));
	assert.equal(resolvePath("$WORK/skills", env).path, skillsOf(".claude-work"));
	assert.equal(resolvePath("${WORK}/skills", env).path, skillsOf(".claude-work"));
	assert.match(resolvePath("$MISSING/x", env).error ?? "", /\$MISSING is not set/);
	assert.match(resolvePath("${EMPTY}/x", env).error ?? "", /\$EMPTY is not set/);
	assert.equal(resolvePath("relative/skills", env).error, "not an absolute path");
	assert.equal(resolvePath("  ", env).error, "no path");

	skill("review");
	ctx.env.vars.WORK_CONFIG = at(".claude-work");
	cfg.targets[2].path = "${WORK_CONFIG}";
	assert.deepEqual(plan(cfg, ctx).map((op) => op.link).sort(), [
		at(".agents/skills/review"),
		skillsOf(".claude") + path.sep + "review",
		skillsOf(".claude-work") + path.sep + "review",
	].sort());
});

test("existing links this plugin does not own are reported with a reason and kept", () => {
	skill("review");
	skill("lint");
	cfg.skillRouting = {
		"skills/review": { mode: "only", only: ["claude"] },
		"skills/lint": { mode: "only", only: ["claude"] },
	};
	sync();
	cfg.skillRouting = {};
	const work = (name: string) => path.join(skillsOf(".claude-work"), name);
	fs.link(work("review"), path.join(skillsOf(".claude"), "review"));
	fs.link(work("lint"), path.join(root, "gone/lint"));
	const conflicts = plan(cfg, ctx).filter((op) => op.kind === "conflict");
	const reasons = Object.fromEntries(conflicts.map((op) => [op.name, op.kind === "conflict" ? op.reason : ""]));
	assert.deepEqual(Object.keys(reasons).sort(), ["lint", "review"]);
	assert.match(reasons.review, /already links to this skill through ~.*review, which this plugin does not manage/);
	assert.match(reasons.lint, /broken link/);
	sync();
	assert.equal(fs.readlink(work("review")), path.join(skillsOf(".claude"), "review"));
	assert.equal(fs.readlink(work("lint")), path.join(root, "gone/lint"));
});

test("removal can be limited to some targets", () => {
	skill("review");
	sync();
	assert.deepEqual(kinds(planRemoval(cfg, ctx, ["work"])), ["remove .claude-work/skills/review"]);
	assert.equal(planRemoval(cfg, ctx).length, 3);
});

test("name clashes are reported only where both skills are routed", () => {
	skill("a");
	skill("personal/a");
	const conflicts = plan(cfg, ctx).filter((op) => op.kind === "conflict");
	assert.deepEqual(
		conflicts.map((op) => op.target),
		["claude"],
	);
});

test("routing helpers keep the selection when switching modes", () => {
	const ids = ["agents", "claude", "work"];
	const all = setRoute({ mode: "all", except: [] }, "agents", false);
	assert.deepEqual(all, { mode: "all", except: ["agents"] });
	const only = setMode(all, "only", ids);
	assert.deepEqual(only, { mode: "only", only: ["claude", "work"] });
	assert.deepEqual(setMode(only, "all", ids), { mode: "all", except: ["agents"] });
	assert.deepEqual(setRoute(only, "agents", true), { mode: "only", only: ["claude", "work", "agents"] });
});

test("per-skill routing follows folder renames", () => {
	const settings = {
		skillsFolder: "skills",
		groups: [{ folder: "", routing: { mode: "all" as const, except: [] } }],
		skillRouting: { "skills/journal": { mode: "only" as const, only: ["claude"] } },
	};
	assert.equal(followFolderRename(settings, "skills/journal", "skills/diary"), true);
	assert.deepEqual(Object.keys(settings.skillRouting), ["skills/diary"]);
	assert.equal(followFolderRename(settings, "skills", "agent-skills"), true);
	assert.deepEqual(Object.keys(settings.skillRouting), ["agent-skills/diary"]);
	assert.equal(settings.skillsFolder, "agent-skills");
	assert.equal(followFolderRename(settings, "unrelated", "other"), false);
});

test("finds Claude Code config folders and suggests the ones not in the list", () => {
	fs.dir(at(".claude-instances/x"));
	fs.file(at(".claude.json"));
	fs.file(at(".config/claude/projects/p.jsonl"));
	fs.file(at(".config/some-tool/claude-home/settings.json"));
	fs.dir(at(".config/some-tool/claude-cache"));
	fs.file(path.join(root, "custom/.claude.json"));
	ctx.env.vars.CLAUDE_CONFIG_DIR = path.join(root, "custom");
	assert.deepEqual(findClaudeConfigs(ctx), [
		path.join(root, "custom"),
		at(".claude"),
		at(".claude-work"),
		at(".config/claude"),
		at(".config/some-tool/claude-home"),
	]);
	const targets = [target("claude", "claude", "~/.claude"), target("work", "folder", "~/.claude-work/skills")];
	assert.deepEqual(unlinkedClaudeConfigs(ctx, targets), [
		path.join(root, "custom"),
		at(".config/claude"),
		at(".config/some-tool/claude-home"),
	]);
});

test("a config folder reached through a symlink is found once and counts as linked", () => {
	fs.link(at(".config/claude"), at(".claude"));
	assert.deepEqual(findClaudeConfigs(ctx), [at(".claude"), at(".claude-work")]);
	const targets = [target("alias", "claude", "~/.config/claude")];
	assert.deepEqual(unlinkedClaudeConfigs(ctx, targets), [at(".claude-work")]);
});

test("previews and notices group changes by target", () => {
	skill("review");
	skill("personal/journal");
	sync();
	cfg.managedLinks = collectManagedLinks(cfg, ctx);
	cfg.targets = cfg.targets.filter((t) => t.id !== "work");
	cfg.groups[1].routing = { mode: "only", only: ["agents"] };
	const ops = plan(cfg, ctx);
	const sections = previewSections(ops, cfg.targets, vault, home);
	assert.deepEqual(sections, [
		{ title: `claude: ${path.join("~", ".claude", "skills")}`, lines: ["− journal"] },
		{ title: `${path.join("~", ".claude-work", "skills")} (no longer in the list)`, lines: ["− review"] },
		{ title: `agents: ${path.join("~", ".agents", "skills")}`, lines: ["+ journal → skills/personal/journal"] },
	]);
	const { done, failed } = apply(ops, fs);
	assert.deepEqual(noticeLines(done, [], failed, cfg.targets, home), [
		"claude: unlinked journal",
		`${path.join("~", ".claude-work", "skills")}: unlinked review`,
		"agents: linked journal",
	]);
});

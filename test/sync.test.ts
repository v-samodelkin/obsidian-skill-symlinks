import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, test } from "node:test";
import { type SyncConfig, apply, plan, planRemoval } from "../src/sync.ts";

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
			.map((n) => [n, path.relative(vault(), fs.readlinkSync(path.join(agent(name), n)))]),
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
	fs.symlinkSync(tmp, path.join(agent("codex"), "other"));
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

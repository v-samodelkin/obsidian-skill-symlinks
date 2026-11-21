import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { defaultSettings } from "../src/data.ts";
import { nodeContext } from "../src/sync.ts";
import { createEditorCore, type EditorHost } from "../src/editor/core.ts";
import { parseEditorCommand, type EditorCatalog, type EditorFile, type EditorMutation, type EditorTree } from "../src/editor/protocol.ts";

function fixture(t: TestContext) {
	const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "skills-editor-test-")));
	t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
	const vault = path.join(tmp, "vault"), source = path.join(vault, "skills/example"), target = path.join(tmp, "agent");
	fs.mkdirSync(source, { recursive: true }); fs.mkdirSync(target);
	fs.writeFileSync(path.join(source, "SKILL.md"), "entry"); fs.writeFileSync(path.join(source, "note.md"), "before");
	const settings = { ...defaultSettings(), enabled: true, skillsFolder: "skills", targets: [{ id: "a", label: "A", kind: "folder" as const, path: target, enabled: true }] };
	let clock = 1000, reads = 0, saves = 0;
	const host: EditorHost = {
		settings: () => settings, config: () => ({ ...settings, vaultPath: vault, configDir: ".obsidian" }), context: nodeContext(),
		async persist() { saves++; }, async read(name) { reads++; return fs.readFileSync(path.join(vault, name)); },
		async process(name, change) { const absolute = path.join(vault, name); fs.writeFileSync(absolute, change(fs.readFileSync(absolute, "utf8"))); },
		async create(name, data) { fs.writeFileSync(path.join(vault, name), data, { flag: "wx" }); }, async mkdir(name) { fs.mkdirSync(path.join(vault, name)); },
		async rename(from, to) { if (fs.existsSync(path.join(vault, to))) throw new Error("occupied"); fs.renameSync(path.join(vault, from), path.join(vault, to)); },
		async trash(name) { fs.renameSync(path.join(vault, name), path.join(tmp, "trashed-" + randomUUID())); },
		owned: (_paths, work) => work(),
	};
	const core = createEditorCore(host, "synthetic-editor-secret", () => clock);
	const mutation = (extra: Record<string, unknown>) => ({ operationId: randomUUID(), deadline: clock + 5000, ...extra });
	async function catalog() { const r = await core.run({ action: "catalog" }); assert.equal(r.status, 200); return r.body.result as EditorCatalog; }
	async function tree() { const c = await catalog(); const r = await core.run({ action: "tree", bundleId: c.bundles[0].id }); assert.equal(r.status, 200); return r.body.result as EditorTree; }
	async function read(name = "note.md") { const tr = await tree(), entry = tr.entries.find((e) => e.path === name)!; const r = await core.run({ action: "read", bundleId: tr.bundleId, fileId: entry.id }); assert.equal(r.status, 200); return r.body.result as EditorFile; }
	return { tmp, vault, source, target, settings, host, core, mutation, catalog, tree, read, time: (value: number) => { clock = value; }, reads: () => reads, saves: () => saves };
}

test("save preserves BOM bytes, saves one file, and conditionally undoes", async (t) => {
	const f = fixture(t); fs.writeFileSync(path.join(f.source, "note.md"), "\uFEFFbefore");
	const file = await f.read(); assert.equal(file.text, "\uFEFFbefore");
	const result = await f.core.run(f.mutation({ action: "save", bundleId: file.bundleId, fileId: file.fileId, expectedRevision: file.revision, text: "after" }));
	assert.equal(result.status, 200); assert.equal(fs.readFileSync(path.join(f.source, "note.md"), "utf8"), "\uFEFFafter");
	assert.equal(fs.readFileSync(path.join(f.source, "SKILL.md"), "utf8"), "entry");
	const undo = (result.body.result as EditorMutation).undoId;
	assert.equal((await f.core.run(f.mutation({ action: "undo", undoId: undo }))).status, 200);
	assert.equal(fs.readFileSync(path.join(f.source, "note.md"), "utf8"), "\uFEFFbefore");
});

test("save and Undo refuse external edits and never overwrite a newer file", async (t) => {
	const f = fixture(t), file = await f.read();
	const saved = await f.core.run(f.mutation({ action: "save", bundleId: file.bundleId, fileId: file.fileId, expectedRevision: file.revision, text: "after" }));
	fs.writeFileSync(path.join(f.source, "note.md"), "external");
	assert.equal((await f.core.run(f.mutation({ action: "undo", undoId: (saved.body.result as EditorMutation).undoId }))).status, 409);
	assert.equal((await f.core.run(f.mutation({ action: "save", bundleId: file.bundleId, fileId: file.fileId, expectedRevision: file.revision, text: "stale" }))).status, 409);
	assert.equal(fs.readFileSync(path.join(f.source, "note.md"), "utf8"), "external");
});

test("an uncertain write is cached including failure and cannot be replayed", async (t) => {
	const f = fixture(t), file = await f.read(); let writes = 0;
	f.host.process = async (name, change) => { writes++; const p = path.join(f.vault, name); fs.writeFileSync(p, change(fs.readFileSync(p, "utf8"))); throw new Error("PRIVATE_SOURCE_SENTINEL"); };
	const command = f.mutation({ action: "save", bundleId: file.bundleId, fileId: file.fileId, expectedRevision: file.revision, text: "after" });
	const first = await f.core.run(command), retry = await f.core.run({ ...command, deadline: 9000 });
	assert.equal(first.status, 500); assert.deepEqual(retry, first); assert.equal(writes, 1); assert.ok(!JSON.stringify(first).includes("PRIVATE_SOURCE_SENTINEL"));
	assert.equal((await f.core.run({ ...command, text: "different" })).status, 409);
	f.time(700000); await f.core.run(f.mutation({ action: "undo", undoId: randomUUID() }));
	assert.equal((await f.core.run({ ...command, deadline: 900000 })).status, 409); assert.equal(writes, 1);
});

test("queued and in-process expired commands cannot mutate", async (t) => {
	const f = fixture(t), file = await f.read(); const original = f.host.read.bind(f.host);
	let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
	f.host.read = async (name) => { await gate; return original(name); };
	const first = f.core.run({ action: "read", bundleId: file.bundleId, fileId: file.fileId });
	const second = f.core.run(f.mutation({ action: "save", bundleId: file.bundleId, fileId: file.fileId, expectedRevision: file.revision, text: "late" }));
	f.time(10000); release(); await first;
	assert.equal((await second).status, 410); assert.equal(fs.readFileSync(path.join(f.source, "note.md"), "utf8"), "before");
	f.time(1000); f.host.read = original;
	f.host.process = async (name, change) => { f.time(10000); fs.writeFileSync(path.join(f.vault, name), change("before")); };
	assert.equal((await f.core.run(f.mutation({ action: "save", bundleId: file.bundleId, fileId: file.fileId, expectedRevision: file.revision, text: "late" }))).status, 410);
});

test("unsafe roots, symlinks, hard links and nested vaults never reach source reads", async (t) => {
	const f = fixture(t); fs.writeFileSync(path.join(f.tmp, "outside"), "private");
	fs.symlinkSync(path.join(f.tmp, "outside"), path.join(f.source, "linked.md")); fs.linkSync(path.join(f.tmp, "outside"), path.join(f.source, "hard.md"));
	fs.mkdirSync(path.join(f.source, "nested/.obsidian"), { recursive: true }); fs.writeFileSync(path.join(f.source, "nested/secret.md"), "private");
	const tr = await f.tree();
	for (const name of ["linked.md", "hard.md", "nested"]) { const e = tr.entries.find((e) => e.path === name)!; assert.equal(e.kind, "blocked"); assert.equal((await f.core.run({ action: "read", bundleId: tr.bundleId, fileId: e.id })).status, 404); }
	assert.equal(f.reads(), 0); f.settings.groups = [{ folder: "../../outside", routing: { mode: "all", except: [] } }];
	assert.equal((await f.core.run({ action: "catalog" })).status, 403); assert.equal(f.reads(), 0);
});

test("editor bundles require a protected SKILL.md even when normal sync does not", async (t) => {
	const f = fixture(t); f.settings.requireSkillMd = false;
	fs.renameSync(path.join(f.source, "SKILL.md"), path.join(f.source, "not-an-entry.md"));
	assert.deepEqual((await f.catalog()).bundles, []);
});

test("rename Undo retains newer edits and root SKILL.md stays protected", async (t) => {
	const f = fixture(t), tr = await f.tree();
	for (const action of ["rename", "trash"]) {
		const entry = tr.entries.find((e) => e.path === "SKILL.md")!;
		const command = action === "rename" ? { action, bundleId: tr.bundleId, fileId: entry.id, name: "moved.md", expectedRevision: tr.revision } : { action, bundleId: tr.bundleId, fileId: entry.id, expectedRevision: (await f.read("SKILL.md")).revision };
		assert.equal((await f.core.run(f.mutation(command))).status, 403);
	}
	const renamed = await f.core.run(f.mutation({ action: "rename", bundleId: tr.bundleId, fileId: tr.entries.find((e) => e.path === "note.md")!.id, name: "moved.md", expectedRevision: tr.revision }));
	assert.equal(renamed.status, 200); fs.writeFileSync(path.join(f.source, "moved.md"), "newer");
	assert.equal((await f.core.run(f.mutation({ action: "undo", undoId: (renamed.body.result as EditorMutation).undoId }))).status, 409);
	assert.equal(fs.readFileSync(path.join(f.source, "moved.md"), "utf8"), "newer");
});

test("create-folder Undo refuses a populated folder; trash Undo refuses an occupied path", async (t) => {
	const f = fixture(t), tr = await f.tree();
	const created = await f.core.run(f.mutation({ action: "create", bundleId: tr.bundleId, parentId: tr.rootId, name: "refs", kind: "folder", expectedRevision: tr.revision }));
	assert.equal(created.status, 200); fs.writeFileSync(path.join(f.source, "refs/keep.md"), "keep");
	assert.equal((await f.core.run(f.mutation({ action: "undo", undoId: (created.body.result as EditorMutation).undoId }))).status, 409);
	const file = await f.read(), trashed = await f.core.run(f.mutation({ action: "trash", bundleId: file.bundleId, fileId: file.fileId, expectedRevision: file.revision }));
	fs.writeFileSync(path.join(f.source, "note.md"), "replacement");
	assert.equal((await f.core.run(f.mutation({ action: "undo", undoId: (trashed.body.result as EditorMutation).undoId }))).status, 409);
	assert.equal(fs.readFileSync(path.join(f.source, "note.md"), "utf8"), "replacement");
});

test("routing persists before links, combines aliases, and never cleans unrelated stale links", async (t) => {
	const f = fixture(t); f.settings.targets.push({ id: "alias", label: "Alias", kind: "folder", path: f.target, enabled: true });
	fs.symlinkSync(path.join(f.vault, "skills/gone"), path.join(f.target, "gone"));
	const c = await f.catalog(); assert.equal(c.targets.length, 1); assert.equal(c.bundles[0].entryPath, "skills/example/SKILL.md");
	const oldPersist = f.host.persist.bind(f.host);
	f.host.persist = async () => { assert.equal(fs.existsSync(path.join(f.target, "example")), f.saves() > 0); await oldPersist(); };
	const result = await f.core.run(f.mutation({ action: "connect", bundleId: c.bundles[0].id, targetId: c.targets[0].id, enabled: true, expectedRevision: c.revision }));
	assert.equal(result.status, 200); assert.deepEqual(f.settings.skillRouting["skills/example"], { mode: "only", only: ["a", "alias"] });
	assert.equal(fs.realpathSync(path.join(f.target, "example")), f.source); assert.equal(fs.lstatSync(path.join(f.target, "gone")).isSymbolicLink(), true);
	assert.equal((result.body.result as EditorMutation).catalog!.bundles[0].connections[0].linked, true);
});

test("failed routing persistence and duplicate names leave links and settings unchanged", async (t) => {
	const f = fixture(t); let c = await f.catalog();
	f.host.persist = async () => { throw new Error("private settings"); };
	let result = await f.core.run(f.mutation({ action: "connect", bundleId: c.bundles[0].id, targetId: c.targets[0].id, enabled: true, expectedRevision: c.revision }));
	assert.equal(result.status, 500); assert.deepEqual(f.settings.skillRouting, {}); assert.deepEqual(fs.readdirSync(f.target), []);
	fs.mkdirSync(path.join(f.vault, "other/example"), { recursive: true }); fs.writeFileSync(path.join(f.vault, "other/example/SKILL.md"), "other");
	f.settings.groups.push({ folder: "../other", routing: { mode: "all", except: [] } });
	assert.equal((await f.core.run({ action: "catalog" })).status, 403);
	f.settings.groups.pop(); fs.mkdirSync(path.join(f.vault, "skills/group/example"), { recursive: true }); fs.writeFileSync(path.join(f.vault, "skills/group/example/SKILL.md"), "other");
	f.settings.groups.push({ folder: "group", routing: { mode: "all", except: [] } }); c = await f.catalog();
	result = await f.core.run(f.mutation({ action: "connect", bundleId: c.bundles[0].id, targetId: c.targets[0].id, enabled: true, expectedRevision: c.revision }));
	assert.equal(result.status, 409); assert.deepEqual(f.settings.skillRouting, {});
});

test("foreign source ownership and partial link failures remain observed conflicts", async (t) => {
	const f = fixture(t); const other = path.join(f.vault, "skills/missing/example"); fs.symlinkSync(other, path.join(f.target, "example"));
	const c = await f.catalog();
	const result = await f.core.run(f.mutation({ action: "connect", bundleId: c.bundles[0].id, targetId: c.targets[0].id, enabled: true, expectedRevision: c.revision }));
	assert.equal(result.status, 200); assert.equal(fs.readlinkSync(path.join(f.target, "example")), other);
	const mutation = result.body.result as EditorMutation; assert.ok(mutation.warning); assert.equal(mutation.catalog!.bundles[0].connections[0].linked, false);
});

test("strict command schemas reject actors, unknown fields and traversal", async (t) => {
	assert.throws(() => parseEditorCommand({ action: "catalog", actor: { kind: "owner" } }));
	const f = fixture(t), tr = await f.tree();
	for (const name of ["../outside.md", ".hidden", "bad\\name", "bad\u0000name"]) assert.equal((await f.core.run(f.mutation({ action: "create", bundleId: tr.bundleId, parentId: tr.rootId, name, kind: "file", expectedRevision: tr.revision }))).status, 400);
});

test("routing Undo cannot overwrite an edit made while persistence was pending", async (t) => {
	const f = fixture(t), c = await f.catalog();
	f.host.persist = async () => { f.settings.skillRouting["skills/example"] = { mode: "all", except: ["a"] }; };
	const result = await f.core.run(f.mutation({ action: "connect", bundleId: c.bundles[0].id, targetId: c.targets[0].id, enabled: true, expectedRevision: c.revision }));
	assert.equal(result.status, 200); assert.ok((result.body.result as EditorMutation).warning); assert.deepEqual(fs.readdirSync(f.target), []);
	assert.equal((await f.core.run(f.mutation({ action: "undo", undoId: (result.body.result as EditorMutation).undoId }))).status, 409);
	assert.deepEqual(f.settings.skillRouting["skills/example"], { mode: "all", except: ["a"] });
});

test("expiry after settings persistence returns committed desired state without applying late links", async (t) => {
	const f = fixture(t), c = await f.catalog(); f.host.persist = async () => { f.time(10000); };
	const result = await f.core.run(f.mutation({ action: "connect", bundleId: c.bundles[0].id, targetId: c.targets[0].id, enabled: true, expectedRevision: c.revision }));
	assert.equal(result.status, 200); const mutation = result.body.result as EditorMutation;
	assert.ok(mutation.warning); assert.equal(mutation.catalog!.bundles[0].connections[0].wanted, true); assert.equal(mutation.catalog!.bundles[0].connections[0].linked, false); assert.deepEqual(fs.readdirSync(f.target), []);
});

test("observed-link persistence failure remains a partial result and retries do not reapply", async (t) => {
	const f = fixture(t), c = await f.catalog(); let persist = 0;
	f.host.persist = async () => { if (++persist > 1) throw new Error("private settings"); };
	const command = f.mutation({ action: "connect", bundleId: c.bundles[0].id, targetId: c.targets[0].id, enabled: true, expectedRevision: c.revision });
	const result = await f.core.run(command); assert.equal(result.status, 200);
	const mutation = result.body.result as EditorMutation; assert.ok(mutation.warning); assert.equal(mutation.catalog!.bundles[0].connections[0].linked, true);
	assert.deepEqual(await f.core.run(command), result); assert.equal(persist, 2);
});

test("routing census includes normal sync folders without an editor entry file", async (t) => {
 const f = fixture(t); f.settings.requireSkillMd = false;
 fs.mkdirSync(path.join(f.vault, "skills/sibling"));
 f.settings.skillRouting["skills/sibling"] = { mode: "only", only: ["a"] };
 f.settings.skillRouting["skills/example"] = { mode: "only", only: [] };
 const c = await f.catalog();
 assert.equal(c.bundles.length, 1);
 const r = await f.core.run(f.mutation({ action: "inherit", bundleId: c.bundles[0].id, expectedRevision: c.revision }));
 assert.equal(r.status, 200);
 assert.equal(fs.realpathSync(path.join(f.target, "example")), f.source);
 assert.equal(fs.existsSync(path.join(f.target, "sibling")), false, "selected mutation must not create sibling links");
});

test("a custom parent config still blocks default nested vaults", async (t) => {
 const f = fixture(t); f.host.config = () => ({ ...f.settings, vaultPath: f.vault, configDir: ".custom" });
 fs.mkdirSync(path.join(f.source, "nested/.obsidian"), { recursive: true });
 fs.writeFileSync(path.join(f.source, "nested/secret.md"), "private");
 const tr = await f.tree();
 assert.equal(tr.entries.find(e => e.path === "nested")?.kind, "blocked");
 assert.ok(!tr.entries.some(e => e.path.endsWith("secret.md")));
});

test("rename and file Undo recheck admission after async reads", async (t) => {
 for (const action of ["rename", "undo-rename", "undo-create"] as const) {
  const f = fixture(t); const file = await f.read(); let command: Record<string, unknown>;
  if (action === "rename") command = f.mutation({ action: "rename", bundleId: file.bundleId, fileId: file.fileId, name: "renamed.md", expectedRevision: (await f.tree()).revision });
  else {
   const create = action === "undo-create";
   const applied = await f.core.run(f.mutation(create ? { action: "create", bundleId: file.bundleId, parentId: (await f.tree()).rootId, name: "new.md", kind: "file", expectedRevision: (await f.tree()).revision } : { action: "rename", bundleId: file.bundleId, fileId: file.fileId, name: "renamed.md", expectedRevision: (await f.tree()).revision }));
   command = f.mutation({ action: "undo", undoId: (applied.body.result as EditorMutation).undoId });
  }
  const read = f.host.read.bind(f.host);
  f.host.read = async name => { const data = await read(name); f.settings.groups = []; return data; };
  const r = await f.core.run(command);
  assert.equal(r.status, 404, action);
  assert.equal(fs.existsSync(path.join(f.source, action === "undo-rename" ? "renamed.md" : action === "undo-create" ? "new.md" : "note.md")), true, action);
 }
});

test("catalog holds use the full normal census and absent groups are skipped", async (t) => {
 const f = fixture(t); f.settings.requireSkillMd = false;
 f.settings.groups[0].routing = { mode: "only", only: [] };
 f.settings.groups.push({ folder: "not-created", routing: { mode: "all", except: [] } });
 fs.mkdirSync(path.join(f.vault, "skills/sibling"));
 f.settings.skillRouting["skills/sibling"] = { mode: "only", only: ["a"] };
 const c = await f.catalog();
 assert.equal(c.bundles.length, 1);
 assert.equal(c.bundles[0].connections[0].state, "off", "a normal sibling is not a false routing orphan");
});

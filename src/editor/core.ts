import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { TextDecoder } from "node:util";
import type { Settings } from "../data.ts";
import { toData } from "../data.ts";
import { type Routing, resolveTarget, routes } from "../model.ts";
import { entryKey, folderKey, inside, samePath, toPosix } from "../paths.ts";
import { effectiveRouting, heldSkills, listSkills, plan, type Context, type Skill, type SyncConfig } from "../sync.ts";
import { ASSET_LIMIT, EDITOR_SCHEMA, TEXT_LIMIT, parseEditorCommand, type EditorBundle, type EditorCatalog, type EditorCommand, type EditorEntry, type EditorFile, type EditorMutation, type EditorReply, type EditorResult, type EditorTarget, type EditorTree } from "./protocol.ts";

export class EditorError extends Error {
	readonly status: number;
	readonly code: string;
	constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
export interface EditorHost {
	settings(): Settings;
	config(): SyncConfig | null;
	context: Context;
	persist(): Promise<void>;
	changed?(): void;
	exclusive?<T>(work: () => Promise<T>): Promise<T>;
	read(vaultPath: string): Promise<Uint8Array>;
	process(vaultPath: string, change: (text: string) => string): Promise<void>;
	create(vaultPath: string, data: Uint8Array): Promise<void>;
	mkdir(vaultPath: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	trash(vaultPath: string): Promise<void>;
	/** Only these exact paths skip the existing auto sync; external changes keep their normal behavior. */
	owned<T>(paths: string[], work: () => Promise<T>): Promise<T>;
}
const hash = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const deny = (status: number, code: string, message: string): never => { throw new EditorError(status, code, message); };
const ignored = new Set(["node_modules", "__pycache__", ".venv", "venv", "dist", "build", "coverage"]);
const textExt = new Set([".md", ".txt", ".json", ".yaml", ".yml", ".toml", ".py", ".sh", ".js", ".ts", ".tsx", ".jsx", ".css", ".html", ".svg", ".xml", ".csv", ".sql", ".ini", ".conf", ".mjs", ".cjs"]);
const mimeOf = (name: string) => ({ ".md": "text/markdown", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" }[path.extname(name).toLowerCase()] ?? "text/plain");
interface Bundle { skill: Skill; root: string; cfg: SyncConfig }
interface Target { view: EditorTarget; ids: string[]; directory: string | null }
interface Undo { bytes: number; run(command: EditorCommand): Promise<Pick<EditorMutation, "warning" | "catalog"> | void> }
interface EditorResponse { status: number; body: EditorReply }
const safePart = (part: string) => !!part && part !== "." && part !== ".." && !part.startsWith(".") && !ignored.has(part) && !/[\\<>:"|?*]/.test(part) && ![...part].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) && !/[. ]$/.test(part) && Buffer.byteLength(part) <= 255;
const relativePath = (value: string, empty = false) => (empty && !value) || (!path.isAbsolute(value) && value.length <= 512 && value.split("/").every(safePart));
const exists = (absolute: string) => { try { fs.lstatSync(absolute); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } };
const stamp = (absolute: string) => { const st = fs.lstatSync(absolute); return `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.nlink}`; };
function children(directory: string): string[] {
	const names: string[] = [], dir = fs.opendirSync(directory);
	try { for (let e = dir.readSync(); e; e = dir.readSync()) { if (names.length >= 1500) deny(413, "tree-too-large", "This skill has too many files. Open it in Obsidian."); names.push(e.name); } }
	finally { dir.closeSync(); }
	return names.sort();
}

export function createEditorCore(host: EditorHost, secret: string, now = () => Date.now()) {
	let chain: Promise<unknown> = Promise.resolve();
	const operations = new Map<string, { digest: string; response: EditorResponse; at: number; bytes: number }>();
	let operationBytes = 0;
	const undos = new Map<string, Undo>();
	let undoBytes = 0;
	const id = (kind: string, value: string) => hash(secret + ":" + kind + ":" + value).slice(0, 32);
	const reply = (result: EditorResult): EditorReply => ({ schema: EDITOR_SCHEMA, mode: "live", provenance: { source: "Obsidian Skill Symlinks", at: new Date(now()).toISOString() }, available: true, result });
	function config(): SyncConfig {
		const cfg = host.config();
		if (!cfg) return deny(503, "desktop-only", "Open this vault in the desktop app");
		const real = fs.realpathSync(cfg.vaultPath);
		if (!samePath(real, cfg.vaultPath)) return deny(403, "unsafe-vault", "A linked vault is not available to the editor");
		if (!cfg.configDir || path.basename(cfg.configDir) !== cfg.configDir || !relativePath(cfg.skillsFolder, true) || cfg.groups.length > 64 || cfg.targets.length > 64 || cfg.groups.some((g) => !relativePath(g.folder, true))) return deny(403, "unsafe-settings", "The configured skill folders are not available to the editor");
		for (const directory of [path.join(cfg.vaultPath, cfg.skillsFolder), ...cfg.groups.map((g) => path.join(cfg.vaultPath, cfg.skillsFolder, g.folder))]) {
			let present = directory;
			while (!exists(present) && inside(cfg.vaultPath, present)) present = path.dirname(present);
			if (!samePath(present, cfg.vaultPath)) secure(cfg, present, true);
		}
		return cfg;
	}
	function census(cfg: SyncConfig): Skill[] {
		const bounded = { ...host.context.fs, list(directory: string) { return exists(directory) ? children(directory) : null; } };
		const candidates = listSkills(cfg, bounded);
		if (candidates.length > 500) return deny(413, "catalog-too-large", "Too many skills are configured for the editor");
		return candidates;
	}
	function bundles(): Bundle[] {
		const cfg = config();
		return census({ ...cfg, requireSkillMd: false }).flatMap((skill) => {
			try {
				const root = secure(cfg, skill.source, true);
				// The editor requires a protected entry file even if normal sync accepts folders without one.
				secure(cfg, path.join(root, "SKILL.md")); if (!fs.lstatSync(path.join(root, "SKILL.md")).isFile()) return [];
				return [{ skill, root, cfg }];
			} catch { return []; }
		});
	}
	/** Check each component without following links; never enter a nested vault or generated directory. */
	function secure(cfg: SyncConfig, absolute: string, directory = false): string {
		if (!inside(cfg.vaultPath, absolute)) return deny(403, "outside-skill", "This path is outside the selected skill");
		let cursor = cfg.vaultPath;
		for (const part of path.relative(cfg.vaultPath, absolute).split(path.sep)) {
			if (!safePart(part)) return deny(403, "protected-path", "This path is not available to the editor");
			cursor = path.join(cursor, part);
			const st = fs.lstatSync(cursor);
			if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory()) || (st.isFile() && st.nlink !== 1)) return deny(403, "linked-path", "Links are not followed by the editor");
			// Also detect default-config nested vaults when this vault uses a custom config.
			if (st.isDirectory() && [".obsidian", cfg.configDir].some((name) => name && exists(path.join(cursor, name)))) return deny(403, "nested-vault", "Nested vaults are not available to the editor");
		}
		const real = fs.realpathSync(absolute);
		if (!samePath(real, absolute) || (directory && !fs.statSync(real).isDirectory())) return deny(403, "linked-path", "Links are not followed by the editor");
		return real;
	}
	function bundle(bundleId: string): Bundle {
		return bundles().find((b) => id("bundle", b.skill.key) === bundleId) ?? deny(404, "skill-missing", "The skill moved or is no longer available. Refresh the list; drafts are kept.");
	}
	function current(b: Bundle): Bundle { return bundle(id("bundle", b.skill.key)); }
	const fileId = (b: Bundle, relative: string) => id("file", b.skill.key + "/" + relative);
	function tree(b: Bundle): EditorTree {
		const entries: EditorEntry[] = [];
		const stamps: string[] = [stamp(b.root)];
		const visit = (relative: string, depth: number) => {
			if (depth > 16 || entries.length > 1500) return deny(413, "tree-too-large", "This skill has too many files. Open it in Obsidian.");
			const directory = relative ? path.join(b.root, relative) : b.root;
			secure(b.cfg, directory, true);
			for (const name of children(directory)) {
				if (!safePart(name)) continue;
				if (entries.length >= 1500) return deny(413, "tree-too-large", "This skill has too many files. Open it in Obsidian.");
				const rel = relative ? relative + "/" + name : name;
				const absolute = path.join(b.root, rel);
				const st = fs.lstatSync(absolute);
				const blocked = st.isSymbolicLink() || (!st.isDirectory() && !st.isFile()) || (st.isFile() && st.nlink !== 1) || (st.isDirectory() && [".obsidian", b.cfg.configDir].some((name) => name && exists(path.join(absolute, name))));
				const kind = blocked ? "blocked" : st.isDirectory() ? "folder" : "file";
				stamps.push(`${rel}:${kind}:${stamp(absolute)}`);
				entries.push({ id: fileId(b, rel), parentId: fileId(b, relative || "."), path: rel, name, kind, bytes: kind === "file" ? st.size : null, editable: kind === "file" && st.size <= TEXT_LIMIT && textExt.has(path.extname(name).toLowerCase()), mime: mimeOf(name) });
				if (kind === "folder") visit(rel, depth + 1);
			}
		};
		visit("", 0);
		return { kind: "tree", bundleId: id("bundle", b.skill.key), rootId: fileId(b, "."), revision: hash(stamps.join("\n")), entries };
	}
	function entry(b: Bundle, value: string, kind?: "file" | "folder"): EditorEntry {
		const e = tree(b).entries.find((e) => e.id === value);
		if (!e || e.kind === "blocked" || (kind && e.kind !== kind)) return deny(404, "file-missing", "This file is no longer available. Refresh the skill; drafts are kept.");
		secure(b.cfg, path.join(b.root, e.path), e.kind === "folder");
		return e;
	}
	const vaultPath = (b: Bundle, relative: string) => toPosix(path.relative(b.cfg.vaultPath, path.join(b.root, relative)));
	async function bytes(b: Bundle, e: EditorEntry): Promise<Uint8Array> {
		if (e.bytes === null || e.bytes > ASSET_LIMIT) return deny(413, "file-too-large", "This file is too large for the editor. Open it in Obsidian.");
		secure(b.cfg, path.join(b.root, e.path));
		const before = stamp(path.join(b.root, e.path));
		const data = await host.read(vaultPath(b, e.path));
		secure(b.cfg, path.join(b.root, e.path));
		checkRevision(stamp(path.join(b.root, e.path)), before);
		if (data.byteLength > ASSET_LIMIT) return deny(413, "file-too-large", "This file is too large for the editor. Open it in Obsidian.");
		return data;
	}
	function decode(data: Uint8Array): string { try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data); } catch { return deny(415, "binary-file", "This file can be viewed as an asset, not edited as text"); } }
	async function read(b: Bundle, e: EditorEntry): Promise<EditorFile> {
		const data = await bytes(b, e);
		const editable = e.editable && data.byteLength <= TEXT_LIMIT;
		const result: EditorFile = { kind: "file", bundleId: id("bundle", b.skill.key), fileId: e.id, path: e.path, name: e.name, revision: hash(data), bytes: data.byteLength, mime: e.mime, editable };
		if (editable) result.text = decode(data);
		else if (/^image\/(png|jpeg|gif|webp)$/.test(e.mime)) result.data = Buffer.from(data).toString("base64");
		return result;
	}
	function targets(cfg: SyncConfig): Target[] {
		const groups = new Map<string, Target>();
		for (const t of host.settings().targets) {
			const resolved = resolveTarget(t, host.context.env);
			const directory = resolved.error === undefined ? resolved.path : null;
			const key = directory === null ? "unresolved:" + t.id : folderKey(host.context.fs, directory);
			let target = groups.get(key);
			if (!target) {
				target = { view: { id: id("target", key), label: t.label, labels: [], enabled: false }, ids: [], directory };
				groups.set(key, target);
			}
			target.ids.push(t.id); target.view.labels.push(t.label); target.view.enabled ||= t.enabled;
			target.view.label = target.view.labels.join(" / ");
		}
		return [...groups.values()];
	}
	const settingsRevision = () => hash(JSON.stringify(toData(host.settings())));
	function safePlan(cfg: SyncConfig) {
		const groupDirs = new Set(cfg.groups.map((g) => path.join(cfg.vaultPath, cfg.skillsFolder, g.folder)));
		const context: Context = { ...host.context, fs: { ...host.context.fs, list(directory) { return groupDirs.has(directory) ? (exists(directory) ? children(directory) : null) : host.context.fs.list(directory); } } };
		return plan(cfg, context);
	}
	function catalog(): EditorCatalog {
		const bs = bundles(), cfg = config(), ts = targets(cfg), held = heldSkills(cfg, census(cfg));
		const planned = safePlan(cfg);
		const summaries: EditorBundle[] = bs.map((b) => ({
			id: id("bundle", b.skill.key), entryPath: vaultPath(b, "SKILL.md"), name: b.skill.name, group: b.skill.group.folder || "Top level", routing: host.settings().skillRouting[b.skill.key] ? "custom" : "group",
			connections: ts.map((t) => {
				const wanted = t.ids.some((targetId) => routes(effectiveRouting(cfg, b.skill), targetId));
				const linked = !!t.directory && samePath(host.context.fs.realpath(path.join(t.directory, b.skill.name)), b.root) && host.context.fs.kind(path.join(t.directory, b.skill.name)) === "link";
				const conflict = held.has(b.skill.key) || planned.some((op) => op.kind === "conflict" && op.name === b.skill.name && (op.target === null || t.ids.includes(op.target)));
				const state = !host.settings().enabled ? "sync-off" : !t.view.enabled ? "profile-off" : conflict ? "conflict" : !t.directory || !host.context.fs.isDir(t.directory) ? "missing" : wanted && linked ? "linked" : wanted || linked ? "conflict" : "off";
				return { targetId: t.view.id, wanted, linked, state, detail: state === "sync-off" ? "Turn on sync in Obsidian" : state === "profile-off" ? "This profile is off in Obsidian" : state === "conflict" ? "The requested connection does not match the installed link. Check the plugin preview in Obsidian." : state === "missing" ? "The agent folder is unavailable" : null };
			}),
		}));
		return { kind: "catalog", vault: { id: id("vault", cfg.vaultPath), name: path.basename(cfg.vaultPath) }, revision: settingsRevision(), syncEnabled: host.settings().enabled, bundles: summaries, targets: ts.map((t) => t.view) };
	}
	function checkRevision(actual: string, expected: string | undefined) { if (actual !== expected) deny(409, "changed", "Changed outside this editor. Refresh to compare; your draft is kept."); }
	function deadline(c: EditorCommand) { if (c.deadline === undefined || now() >= c.deadline) deny(410, "expired", "This operation expired before it could be applied. Refresh to check the current state."); }
	function destination(b: Bundle, relative: string): string {
		if (!relativePath(relative)) return deny(400, "invalid-name", "Choose a relative name inside this skill");
		const absolute = path.join(b.root, relative);
		if (!inside(b.root, absolute)) return deny(403, "outside-skill", "Choose a name inside this skill");
		secure(b.cfg, path.dirname(absolute), true);
		const parent = path.dirname(absolute), insensitive = host.context.fs.ignoresCase(parent);
		const key = (name: string) => insensitive ? name.normalize("NFC").toLowerCase() : name;
		if (exists(absolute) || children(parent).some((name) => key(name) === key(path.basename(absolute)))) return deny(409, "name-used", "That name is already in use");
		return vaultPath(b, relative);
	}
	function remember(undo: Undo): string {
		const key = randomUUID(); undos.set(key, undo); undoBytes += undo.bytes;
		while (undos.size > 32 || undoBytes > 8 * 1024 * 1024) { const first = undos.entries().next().value; if (!first) break; undoBytes -= first[1].bytes; undos.delete(first[0]); }
		return key;
	}
	const routingValue = (b: Bundle) => JSON.stringify(host.settings().skillRouting[b.skill.key]);
	function putRouting(b: Bundle, value: Routing | undefined) { if (value) host.settings().skillRouting[b.skill.key] = structuredClone(value); else delete host.settings().skillRouting[b.skill.key]; }
	async function routeChange(b: Bundle, next: Routing | undefined, c: EditorCommand): Promise<Pick<EditorMutation, "warning" | "catalog">> {
		b = current(b); const bs = bundles();
		if (bs.filter((s) => s.skill.name.normalize("NFC").toLowerCase() === b.skill.name.normalize("NFC").toLowerCase()).length !== 1) return deny(409, "ambiguous-skill", "Two skills use this link name. Resolve the conflict in Obsidian.");
		const before = host.settings().skillRouting[b.skill.key] && structuredClone(host.settings().skillRouting[b.skill.key]);
		deadline(c); putRouting(b, next); const after = routingValue(b), revision = settingsRevision();
		try { await host.persist(); } catch {
			if (routingValue(b) === after) putRouting(b, before);
			host.changed?.(); return deny(500, "settings-not-saved", "The routing setting could not be saved. Links were not changed. Refresh to check the current state.");
		}
		host.changed?.();
		// A saved choice is already a committed change; never pretend an elapsed request changed nothing.
		if (now() >= c.deadline! || settingsRevision() !== revision || !host.settings().enabled) return { warning: "The routing choice was saved. Links were not changed because the request expired or plugin settings changed. Refresh to check the current state.", catalog: catalog() };
		b = current(b); const cfg = config(), fsys = host.context.fs, ts = targets(cfg);
		const dirs = new Map(ts.filter((t) => t.directory !== null).map((t) => [folderKey(fsys, t.directory!), t]));
		const ops = safePlan(cfg).filter((op) => {
			if (op.name !== b.skill.name || !dirs.has(folderKey(fsys, path.dirname(op.link)))) return false;
			if (op.kind === "create") return samePath(op.source, b.root);
			if (op.kind === "remove") return fsys.kind(op.link) === "link" && samePath(path.resolve(path.dirname(op.link), fsys.readlink(op.link)), b.root);
			return true;
		});
		let partial = ops.some((op) => op.kind === "conflict");
		for (const op of ops) {
			if (op.kind === "conflict") continue;
			try {
				deadline(c); secure(b.cfg, b.root, true);
				if (op.kind === "remove") {
					if (fsys.kind(op.link) !== "link" || !samePath(path.resolve(path.dirname(op.link), fsys.readlink(op.link)), b.root)) { partial = true; continue; }
					fsys.unlink(op.link);
				} else {
					if (fsys.kind(op.link) !== null) { partial = true; continue; }
					fsys.symlink(b.root, op.link);
				}
			} catch { partial = true; }
		}
		const managed = { ...host.settings().managedLinks };
		for (const t of ts) {
			if (!t.directory || !fsys.isDir(t.directory)) continue;
			const link = path.join(t.directory, b.skill.name), key = entryKey(fsys, link);
			const linked = fsys.kind(link) === "link" && samePath(path.resolve(path.dirname(link), fsys.readlink(link)), b.root);
			for (const [stored, source] of Object.entries(managed)) if (entryKey(fsys, stored) === key && samePath(source, b.root)) delete managed[stored];
			if (linked) managed[link] = b.root;
		}
		host.settings().managedLinks = managed;
		try { await host.persist(); } catch { partial = true; }
		host.changed?.();
		return { ...(partial ? { warning: "The routing choice was saved, but some links or their observed records could not be updated. Check the current connections and the plugin preview in Obsidian." } : {}), catalog: catalog() };
	}
	async function execute(c: EditorCommand): Promise<EditorResult> {
		if (c.action === "catalog") return catalog();
		if (c.action === "undo") {
			const u = undos.get(c.undoId!); if (!u) return deny(409, "undo-expired", "This Undo is no longer available");
			deadline(c); undos.delete(c.undoId!); undoBytes -= u.bytes;
			const result = await u.run(c);
			return { kind: "mutation", operationId: c.operationId!, undoId: null, ...result };
		}
		const b = bundle(c.bundleId!);
		if (c.action === "tree") return tree(b);
		if (c.action === "read") return read(b, entry(b, c.fileId!, "file"));
		deadline(c);
		let undoId: string | null = null, nextFile: string | undefined;
		if (c.action === "save") {
			const e = entry(b, c.fileId!, "file"); if (!e.editable) return deny(415, "read-only", "Open this file in Obsidian to edit it");
			const data = await bytes(b, e), before = decode(data); checkRevision(hash(data), c.expectedRevision); deadline(c);
			const after = before.startsWith("\uFEFF") && !c.text!.startsWith("\uFEFF") ? "\uFEFF" + c.text : c.text!;
			if (Buffer.byteLength(after) > TEXT_LIMIT) return deny(413, "file-too-large", "This file is too large for the editor");
			await host.process(vaultPath(b, e.path), (actual) => { current(b); secure(b.cfg, path.join(b.root, e.path)); deadline(c); checkRevision(hash(actual), c.expectedRevision); return after; });
			const afterStamp = stamp(path.join(b.root, e.path));
			undoId = remember({ bytes: Buffer.byteLength(before) + Buffer.byteLength(after), async run(undo) {
				current(b); entry(b, e.id, "file"); await host.process(vaultPath(b, e.path), (actual) => { current(b); secure(b.cfg, path.join(b.root, e.path)); deadline(undo); checkRevision(stamp(path.join(b.root, e.path)), afterStamp); checkRevision(hash(actual), hash(after)); return before; });
			} }); nextFile = e.id;
		} else if (c.action === "create") {
			const t = tree(b); checkRevision(t.revision, c.expectedRevision);
			const parent = c.parentId === t.rootId ? "" : entry(b, c.parentId!, "folder").path;
			const relative = parent ? parent + "/" + c.name : c.name!;
			const dest = destination(b, relative); deadline(c);
			await host.owned([dest], () => c.kind === "folder" ? host.mkdir(dest) : host.create(dest, new Uint8Array()));
			const createdId = fileId(b, relative), afterStamp = stamp(path.join(b.root, relative));
			if (c.kind === "file") nextFile = createdId;
			undoId = remember({ bytes: 0, async run(undo) {
				current(b); const e = entry(b, createdId, c.kind); checkRevision(stamp(path.join(b.root, relative)), afterStamp);
				if (c.kind === "folder") { if (children(path.join(b.root, relative)).length) deny(409, "changed", "This folder is no longer empty. Its contents were kept."); }
				else checkRevision(hash(await bytes(b, e)), hash(""));
				current(b); deadline(undo); checkRevision(stamp(path.join(b.root, relative)), afterStamp); await host.owned([dest], () => host.trash(dest));
			} });
		} else if (c.action === "rename") {
			checkRevision(tree(b).revision, c.expectedRevision); const e = entry(b, c.fileId!, "file");
			if (e.path.toLowerCase() === "skill.md") return deny(403, "entry-file", "SKILL.md is the skill entry file and keeps its name");
			const contentHash = hash(await bytes(b, e)); current(b); checkRevision(tree(b).revision, c.expectedRevision);
			const dest = destination(b, c.name!), old = vaultPath(b, e.path); deadline(c);
			await host.owned([old, dest], () => host.rename(old, dest)); nextFile = fileId(b, c.name!);
			const newId = nextFile, afterStamp = stamp(path.join(b.root, c.name!));
			undoId = remember({ bytes: 0, async run(undo) {
				current(b); const moved = entry(b, newId, "file"); checkRevision(hash(await bytes(b, moved)), contentHash);
				current(b); destination(b, e.path); deadline(undo); checkRevision(stamp(path.join(b.root, c.name!)), afterStamp); await host.owned([old, dest], () => host.rename(dest, old));
			} });
		} else if (c.action === "trash") {
			const e = entry(b, c.fileId!, "file"); if (e.path.toLowerCase() === "skill.md") return deny(403, "entry-file", "SKILL.md is required. Manage the whole skill in Obsidian.");
			const beforeStamp = stamp(path.join(b.root, e.path)), data = await bytes(b, e); checkRevision(hash(data), c.expectedRevision); const old = vaultPath(b, e.path); current(b); deadline(c); secure(b.cfg, path.join(b.root, e.path)); checkRevision(stamp(path.join(b.root, e.path)), beforeStamp);
			await host.owned([old], () => host.trash(old)); undoId = remember({ bytes: data.byteLength, async run(undo) { current(b); destination(b, e.path); deadline(undo); await host.owned([old], () => host.create(old, data)); } });
		} else if (c.action === "connect" || c.action === "inherit") {
			checkRevision(settingsRevision(), c.expectedRevision); if (!host.settings().enabled) return deny(409, "sync-off", "Turn on sync in Obsidian first");
			const before = host.settings().skillRouting[b.skill.key] ? structuredClone(host.settings().skillRouting[b.skill.key]) : undefined;
			let next: Routing | undefined;
			if (c.action === "connect") {
				const t = targets(b.cfg).find((t) => t.view.id === c.targetId); if (!t || !t.view.enabled || !t.directory || !host.context.fs.isDir(t.directory)) return deny(409, "profile-off", "This agent folder is unavailable. Check it in Obsidian.");
				const selected = host.settings().targets.filter((target) => routes(effectiveRouting(config(), b.skill), target.id)).map((target) => target.id);
				next = { mode: "only", only: c.enabled ? [...new Set([...selected, ...t.ids])] : selected.filter((targetId) => !t.ids.includes(targetId)) };
			}
			const after = JSON.stringify(next), result = await routeChange(b, next, c);
			undoId = remember({ bytes: 0, async run(undo) { current(b); checkRevision(routingValue(b), after); if (!host.settings().enabled) deny(409, "sync-off", "Sync is off. Manage this routing choice in Obsidian."); return routeChange(b, before, undo); } });
			return { kind: "mutation", operationId: c.operationId!, undoId, ...result };
		}
		return { kind: "mutation", operationId: c.operationId!, undoId, ...(nextFile ? { fileId: nextFile } : {}) };
	}
	return {
		async run(raw: unknown): Promise<EditorResponse> {
			const failure = (error: unknown): EditorResponse => {
				const known = error instanceof EditorError;
				return { status: known ? error.status : 500, body: { schema: EDITOR_SCHEMA, mode: "live", provenance: { source: "Obsidian Skill Symlinks", at: new Date(now()).toISOString() }, available: false, reason: known ? error.code : "editor-failed", detail: known ? error.message : "The operation could not be completed. Refresh to check the actual state; drafts are kept." } };
			};
			let command: EditorCommand;
			try { command = parseEditorCommand(raw); } catch { return failure(new EditorError(400, "invalid-request", "The editor request is invalid or too large")); }
			const work = async (): Promise<EditorResponse> => {
				const stable = Object.fromEntries(Object.entries(command).filter(([key]) => key !== "deadline").sort(([a], [b]) => a.localeCompare(b)));
				const digest = hash(JSON.stringify(stable));
				const prior = command.operationId ? operations.get(command.operationId) : undefined;
				if (prior) return prior.digest === digest ? prior.response : failure(new EditorError(409, "operation-reused", "This operation ID was already used"));
				if (command.operationId && operations.size >= 1024) return failure(new EditorError(429, "operation-limit", "This editor session reached its operation limit. Reload the plugin before making more changes."));
				let out: EditorResponse;
				try { out = { status: 200, body: reply(await execute(command)) }; } catch (error) { out = failure(error); }
				// Keep used IDs even after their full result expires; retries cannot replay an uncertain write.
				if (command.operationId) {
					const bytes = Buffer.byteLength(JSON.stringify(out));
					operations.set(command.operationId, { digest, response: out, at: now(), bytes }); operationBytes += bytes;
					for (const op of operations.values()) if (now() - op.at > 10 * 60_000 || operationBytes > 8 * 1024 * 1024) {
						const tombstone = failure(new EditorError(409, "operation-handled", "This operation was already handled. Refresh to check the current state."));
						operationBytes -= op.bytes; op.response = tombstone; op.bytes = Buffer.byteLength(JSON.stringify(tombstone)); operationBytes += op.bytes;
					}
				}
				return out;
			};
			const pending = chain.then(() => host.exclusive ? host.exclusive(work) : work()); chain = pending.catch(() => undefined);
			return pending;
		},
	};
}

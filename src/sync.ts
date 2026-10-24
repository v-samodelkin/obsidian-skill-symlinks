// Plans and applies link changes. No Obsidian imports, and every filesystem call goes through
// FileSystem, so planning can be tested against an in-memory fake.
import * as path from "path";
import { type Env, type FileSystem, nodeEnv, nodeFs } from "./fsys.ts";
import { type Group, type Routing, type Target, resolveTarget, routes } from "./model.ts";
import { inside, pathKey, samePath, tildify, toPosix } from "./paths.ts";

export interface SyncConfig {
	vaultPath: string;
	skillsFolder: string; // vault-relative; "" is the vault root
	requireSkillMd: boolean;
	targets: Target[];
	groups: Group[];
	skillRouting?: Record<string, Routing>; // vault-relative skill folder -> routing that replaces its group's
	managedLinks?: Record<string, string>; // last observed link -> source, persisted across vault moves
}

export interface Context {
	fs: FileSystem;
	env: Env;
}

export const nodeContext = (): Context => ({ fs: nodeFs, env: nodeEnv() });

export interface Skill {
	name: string; // the link name
	source: string; // absolute folder path
	key: string; // vault-relative folder path with "/" separators, used for per-skill routing
	group: Group;
}

// `target` is the id of the target the link belongs to, or null for a folder that is no longer a target.
export type Op =
	| { kind: "create"; target: string; name: string; link: string; source: string }
	| { kind: "remove"; target: string | null; name: string; link: string }
	| { kind: "conflict"; target: string; name: string; link: string; reason: string };

export interface PlanOptions {
	/** Plan as if these targets (or all of them) were turned off, which removes their links. */
	disable?: "all" | string[];
}

const linkDest = (fs: FileSystem, link: string): string => path.resolve(path.dirname(link), fs.readlink(link));

const recordedLinks = (cfg: SyncConfig): Map<string, string> =>
	new Map(Object.entries(cfg.managedLinks ?? {}).map(([link, dest]) => [pathKey(link), pathKey(dest)]));

export const effectiveRouting = (cfg: Pick<SyncConfig, "skillRouting">, skill: Skill): Routing =>
	cfg.skillRouting?.[skill.key] ?? skill.group.routing;

/** Every skill folder in the configured groups, in group order. */
export function listSkills(cfg: SyncConfig, fs: FileSystem): Skill[] {
	const root = path.join(cfg.vaultPath, cfg.skillsFolder);
	const groupDirs = cfg.groups.map((g) => path.join(root, g.folder));
	const skills: Skill[] = [];
	for (const group of cfg.groups) {
		const dir = path.join(root, group.folder);
		for (const name of fs.list(dir)) {
			const source = path.join(dir, name);
			if (name.startsWith(".") || fs.kind(source) !== "dir") continue;
			// A group folder (or a folder containing one) is never a skill itself.
			if (groupDirs.some((d) => samePath(d, source) || inside(source, d))) continue;
			if (cfg.requireSkillMd && !fs.exists(path.join(source, "SKILL.md"))) continue;
			skills.push({ name, source, key: toPosix(path.relative(cfg.vaultPath, source)), group });
		}
	}
	return skills;
}

interface Folder {
	dir: string;
	ids: string[]; // every target that resolves to this folder
	active: string[]; // the enabled ones
	wants: Map<string, { source: string; target: string }>;
}

// Resolved target folders, merged when two targets name the same folder.
function targetFolders(cfg: SyncConfig, env: Env, off: (t: Target) => boolean) {
	const folders = new Map<string, Folder>();
	let unresolved = false;
	for (const target of cfg.targets) {
		const resolved = resolveTarget(target, env);
		if (resolved.error !== undefined) {
			unresolved = true;
			continue;
		}
		const key = pathKey(resolved.path);
		const folder: Folder = folders.get(key) ?? { dir: resolved.path, ids: [], active: [], wants: new Map() };
		folder.ids.push(target.id);
		if (!off(target)) folder.active.push(target.id);
		folders.set(key, folder);
	}
	return { folders, unresolved };
}

/**
 * Links into this vault, and recorded links whose old destination is gone after a vault move, are ours.
 * Each enabled target gets the skills routed to it; everything else of ours in a target is removed,
 * so disabled targets and skills routed elsewhere are cleaned up. Recorded links in folders that are no
 * longer targets are removed too. Anything else is reported and left alone.
 */
export function plan(cfg: SyncConfig, ctx: Context = nodeContext(), options: PlanOptions = {}): Op[] {
	const { fs, env } = ctx;
	// The adapter may still refer to the old vault path until Obsidian reopens it.
	if (!fs.isDir(cfg.vaultPath)) return [];
	const disable = options.disable;
	const off = (t: Target) => !t.enabled || disable === "all" || (disable?.includes(t.id) ?? false);
	const { folders, unresolved } = targetFolders(cfg, env, off);
	const conflicts: Op[] = [];

	for (const skill of listSkills(cfg, fs)) {
		const routing = effectiveRouting(cfg, skill);
		for (const folder of folders.values()) {
			const target = folder.active.find((id) => routes(routing, id));
			if (!target) continue;
			const taken = folder.wants.get(skill.name);
			if (!taken) folder.wants.set(skill.name, { source: skill.source, target });
			else if (!samePath(taken.source, skill.source))
				conflicts.push({
					kind: "conflict",
					target,
					name: skill.name,
					link: path.join(folder.dir, skill.name),
					reason: `both ${tildify(taken.source, env.home)} and ${tildify(skill.source, env.home)} are named "${skill.name}"`,
				});
		}
	}

	const recorded = recordedLinks(cfg);
	const owned = (link: string, dest: string) =>
		inside(cfg.vaultPath, dest) || (recorded.get(pathKey(link)) === pathKey(dest) && !fs.exists(dest));
	const removes: Op[] = [];
	const creates: Op[] = [];
	for (const folder of folders.values()) {
		if (!fs.isDir(folder.dir)) continue;
		for (const name of fs.list(folder.dir)) {
			const link = path.join(folder.dir, name);
			if (fs.kind(link) !== "link") continue;
			const dest = linkDest(fs, link);
			if (owned(link, dest) && !samePath(folder.wants.get(name)?.source, dest))
				removes.push({ kind: "remove", target: folder.active[0] ?? folder.ids[0], name, link });
		}
		for (const [name, { source, target }] of folder.wants) {
			const link = path.join(folder.dir, name);
			const kind = fs.kind(link);
			const dest = kind === "link" ? linkDest(fs, link) : null;
			if (samePath(dest, source)) continue;
			if (!kind || (dest && owned(link, dest))) creates.push({ kind: "create", target, name, link, source });
			else conflicts.push({ kind: "conflict", target, name, link, reason: conflictReason(fs, env, link, dest, source) });
		}
	}

	// A target that was removed or now points elsewhere leaves recorded links behind. Skip this while
	// any target path cannot be resolved: its links would look abandoned when they are not.
	if (!unresolved) {
		const seen = new Set<string>();
		for (const link of Object.keys(cfg.managedLinks ?? {})) {
			if (seen.has(pathKey(link)) || folders.has(pathKey(path.dirname(link))) || fs.kind(link) !== "link") continue;
			seen.add(pathKey(link));
			if (owned(link, linkDest(fs, link)))
				removes.push({ kind: "remove", target: null, name: path.basename(link), link });
		}
	}

	return [...removes, ...creates, ...conflicts];
}

function conflictReason(fs: FileSystem, env: Env, link: string, dest: string | null, source: string): string {
	if (dest === null) return "a folder or file with this name already exists and is not managed by this plugin";
	const shown = tildify(dest, env.home);
	const real = fs.realpath(link);
	if (real && samePath(real, fs.realpath(source)))
		return `already links to this skill through ${shown}, which this plugin does not manage; delete that link to let the plugin manage it`;
	if (!fs.exists(link)) return `a broken link to ${shown} that this plugin did not create; delete it to let the plugin link this skill`;
	return `links to ${shown}, which this plugin does not manage`;
}

/**
 * The links this vault manages, observed on disk, including existing installations and operations that
 * failed. Records for unavailable folders are kept so they can be repaired or cleaned up later.
 */
export function collectManagedLinks(cfg: SyncConfig, ctx: Context = nodeContext()): Record<string, string> {
	const { fs, env } = ctx;
	const managed = { ...cfg.managedLinks };
	const recorded = recordedLinks(cfg);
	const { folders, unresolved } = targetFolders(cfg, env, () => false);
	for (const folder of folders.values()) {
		if (!fs.isDir(folder.dir)) continue;
		for (const link of Object.keys(managed)) {
			if (samePath(path.dirname(link), folder.dir)) delete managed[link];
		}
		for (const name of fs.list(folder.dir)) {
			const link = path.join(folder.dir, name);
			if (fs.kind(link) !== "link") continue;
			const dest = linkDest(fs, link);
			if (inside(cfg.vaultPath, dest) || recorded.get(pathKey(link)) === pathKey(dest)) managed[link] = dest;
		}
	}
	// Folders that are no longer targets: forget links that are gone, so cleanup ends once it succeeds.
	if (!unresolved)
		for (const [link, dest] of Object.entries(managed)) {
			const dir = path.dirname(link);
			if (folders.has(pathKey(dir)) || !fs.isDir(dir)) continue;
			if (fs.kind(link) !== "link" || !samePath(linkDest(fs, link), dest)) delete managed[link];
		}
	return managed;
}

/** Plan that removes every link this vault owns, or only those in the given targets. */
export const planRemoval = (cfg: SyncConfig, ctx: Context = nodeContext(), ids?: string[]): Op[] =>
	plan(cfg, ctx, { disable: ids ?? "all" });

export function apply(ops: Op[], fs: FileSystem = nodeFs): { done: Op[]; failed: { op: Op; error: string }[] } {
	const done: Op[] = [];
	const failed: { op: Op; error: string }[] = [];
	for (const op of ops) {
		try {
			if (op.kind === "remove") fs.unlink(op.link);
			else if (op.kind === "create") fs.symlink(op.source, op.link);
			else continue;
			done.push(op);
		} catch (e) {
			failed.push({ op, error: e instanceof Error ? e.message : String(e) });
		}
	}
	return { done, failed };
}

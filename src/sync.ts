// Plans and applies link changes. No Obsidian imports, and every filesystem call goes through
// FileSystem, so planning can be tested against an in-memory fake.
import * as os from "os";
import * as path from "path";
import { type Env, type FileSystem, nodeEnv, nodeFs } from "./fsys.ts";
import { type Group, type Routing, type Target, resolveTarget, routes } from "./model.ts";
import { entryKey, folderKey, inside, pathKey, samePath, tildify, toPosix } from "./paths.ts";

export interface SyncConfig {
	vaultPath: string;
	skillsFolder: string; // vault-relative; "" is the vault root
	requireSkillMd: boolean;
	targets: Target[];
	groups: Group[];
	skillRouting?: Record<string, Routing>; // vault-relative skill folder -> routing that replaces its group's
	managedLinks?: Record<string, string>; // last observed link -> source, persisted across vault moves
	configDir?: string; // Obsidian's config folder name, which marks a vault nested inside this one
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

// `target` is the id of the target the link belongs to, or null for a folder that is no longer a target
// (and, for a conflict, for a skill that is held back everywhere).
export type Op =
	| { kind: "create"; target: string; name: string; link: string; source: string }
	| { kind: "remove"; target: string | null; name: string; link: string }
	| { kind: "conflict"; target: string | null; name: string; link: string; reason: string };

export interface PlanOptions {
	/** Plan as if these targets (or all of them) were turned off, which removes their links. */
	disable?: "all" | string[];
}

const linkDest = (fs: FileSystem, link: string): string => path.resolve(path.dirname(link), fs.readlink(link));

const linksTo = (fs: FileSystem, link: string, source: string): boolean => fs.kind(link) === "link" && samePath(linkDest(fs, link), source);

// Links this plugin creates are always named after the skill folder they point to.
const sameName = (a: string, b: string): boolean =>
	os.platform() === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;

export const effectiveRouting = (cfg: Pick<SyncConfig, "skillRouting">, skill: Skill): Routing =>
	cfg.skillRouting?.[skill.key] ?? skill.group.routing;

/** Every skill folder in the configured groups, in group order. */
export function listSkills(cfg: SyncConfig, fs: FileSystem): Skill[] {
	const root = path.join(cfg.vaultPath, cfg.skillsFolder);
	const groupDirs = cfg.groups.map((g) => path.join(root, g.folder));
	const skills: Skill[] = [];
	for (const group of cfg.groups) {
		const dir = path.join(root, group.folder);
		for (const name of fs.list(dir) ?? []) {
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

/**
 * Per-skill routing is keyed by the skill's vault path and follows renames made in Obsidian. A rename
 * made elsewhere (Finder, git, a sync client) looks like one skill gone and a new one, which would
 * fall back to its group's routing. So while a per-skill choice has no skill, new skills in the same
 * folder are held back, linked nowhere, until the choice is moved to one of them or forgotten.
 * "New" means no recorded link points to it yet. Returns skill key -> the orphaned key holding it.
 */
export function heldSkills(cfg: Pick<SyncConfig, "skillRouting" | "managedLinks">, skills: Skill[]): Map<string, string> {
	const overrides = cfg.skillRouting ?? {};
	const found = new Set(skills.map((s) => s.key));
	const orphans = Object.keys(overrides).filter((key) => !found.has(key));
	const held = new Map<string, string>();
	if (!orphans.length) return held;
	const linked = new Set(Object.values(cfg.managedLinks ?? {}).map(pathKey));
	for (const skill of skills) {
		if (overrides[skill.key] || linked.has(pathKey(skill.source))) continue;
		const orphan = orphans.find((key) => path.posix.dirname(key) === path.posix.dirname(skill.key));
		if (orphan) held.set(skill.key, orphan);
	}
	return held;
}

interface Want {
	name: string;
	source: string;
	target: string;
}

interface Folder {
	key: string; // folderKey of dir
	dir: string;
	ids: string[]; // every target that resolves to this folder, through symlinks too
	active: string[]; // the enabled ones
	ignoreCase: boolean;
	wants: Map<string, Want>; // by nameKey
}

const nameKey = (folder: Folder, name: string): string => (folder.ignoreCase ? name.normalize("NFC").toLowerCase() : name);

// Resolved target folders, merged when two targets reach the same folder.
function targetFolders(cfg: SyncConfig, { fs, env }: Context, off: (t: Target) => boolean) {
	const folders = new Map<string, Folder>();
	const unresolved: { target: Target; error: string }[] = [];
	for (const target of cfg.targets) {
		const resolved = resolveTarget(target, env);
		if (resolved.error !== undefined) {
			unresolved.push({ target, error: resolved.error });
			continue;
		}
		const key = folderKey(fs, resolved.path);
		let folder = folders.get(key);
		if (!folder) {
			const ignoreCase = fs.isDir(resolved.path) && fs.ignoresCase(resolved.path);
			folder = { key, dir: resolved.path, ids: [], active: [], ignoreCase, wants: new Map() };
			folders.set(key, folder);
		}
		folder.ids.push(target.id);
		if (!off(target)) folder.active.push(target.id);
	}
	return { folders, unresolved };
}

/**
 * Which links belong to this vault. A link this plugin made is named after the folder it points to.
 * Inside this vault that folder is ours when it is a skill folder (directly inside a group folder, or
 * anywhere under the skills folder when one is set), when it is gone (renamed or deleted), or when the
 * link is recorded. Outside the vault only a recorded link whose destination is gone is ours, so it can
 * be repaired after a vault move. Links into a vault nested inside this one, and other links into this
 * vault, are never ours.
 *
 * A nested vault is a folder with its own config folder. The skills folder, the group folders and the
 * folders above them never count as one: this vault's own skills are inside them, for example when a
 * parent of the skills folder was once opened as a vault of its own, as 1.0 treated it.
 */
function ownership(cfg: SyncConfig, fs: FileSystem): (link: string, dest: string) => boolean {
	const recorded = new Map(Object.entries(cfg.managedLinks ?? {}).map(([link, dest]) => [entryKey(fs, link), pathKey(dest)]));
	const root = path.join(cfg.vaultPath, cfg.skillsFolder);
	const groupDirs = cfg.groups.map((g) => path.join(root, g.folder));
	const configured = [root, ...groupDirs];
	const holdsSkills = (dir: string): boolean => configured.some((d) => samePath(d, dir) || inside(dir, d));
	const { configDir } = cfg;
	const inVault = (dest: string): boolean => {
		if (!inside(cfg.vaultPath, dest)) return false;
		if (configDir)
			for (let dir = path.dirname(dest); inside(cfg.vaultPath, dir); dir = path.dirname(dir))
				if (!holdsSkills(dir) && fs.kind(path.join(dir, configDir)) === "dir") return false;
		return true;
	};
	const skillFolder = (dest: string): boolean =>
		(cfg.skillsFolder !== "" && inside(root, dest)) || groupDirs.some((d) => samePath(d, path.dirname(dest)));
	return (link, dest) => {
		if (!sameName(path.basename(link), path.basename(dest))) return false;
		const isRecorded = recorded.get(entryKey(fs, link)) === pathKey(dest);
		if (inVault(dest))
			return isRecorded || skillFolder(dest) || !fs.exists(dest);
		return isRecorded && !inside(cfg.vaultPath, dest) && !fs.exists(dest);
	};
}

/**
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
	const { folders, unresolved } = targetFolders(cfg, ctx, off);
	const conflicts: Op[] = [];
	const shown = (p: string) => tildify(p, env.home);
	for (const { target, error } of unresolved)
		if (!off(target))
			conflicts.push({ kind: "conflict", target: target.id, name: "", link: target.path, reason: `${error}, so this folder is skipped` });

	const skills = listSkills(cfg, fs);
	const held = heldSkills(cfg, skills);
	for (const skill of skills) {
		const orphan = held.get(skill.key);
		if (orphan !== undefined) {
			conflicts.push({
				kind: "conflict",
				target: null,
				name: skill.name,
				link: skill.source,
				reason: `not linked anywhere yet: custom folders are kept for ${orphan}, which is no longer found. In the plugin settings, use them for this skill or forget them`,
			});
			continue;
		}
		const routing = effectiveRouting(cfg, skill);
		for (const folder of folders.values()) {
			const target = folder.active.find((id) => routes(routing, id));
			if (!target) continue;
			const key = nameKey(folder, skill.name);
			const taken = folder.wants.get(key);
			const want: Want = { name: skill.name, source: skill.source, target };
			if (!taken) folder.wants.set(key, want);
			else if (!samePath(taken.source, skill.source)) {
				const reason =
					taken.name === skill.name
						? `both ${shown(taken.source)} and ${shown(skill.source)} are named "${skill.name}"`
						: `${shown(taken.source)} and ${shown(skill.source)} differ only in letter case, which this folder does not tell apart`;
				// Names that differ only in case: the skill already linked here keeps its link, so a clash
				// that an earlier version left in place does not move the link to the other skill.
				const holds = taken.name !== skill.name && linksTo(fs, path.join(folder.dir, skill.name), skill.source);
				const skipped = holds ? taken : want;
				if (holds) folder.wants.set(key, want);
				conflicts.push({ kind: "conflict", target: skipped.target, name: skipped.name, link: path.join(folder.dir, skipped.name), reason });
			}
		}
	}

	const owned = ownership(cfg, fs);
	const removes: Op[] = [];
	const creates: Op[] = [];
	for (const folder of folders.values()) {
		if (!fs.isDir(folder.dir)) continue;
		const names = fs.list(folder.dir);
		if (names === null) {
			conflicts.push({
				kind: "conflict",
				target: folder.active[0] ?? folder.ids[0],
				name: "",
				link: folder.dir,
				reason: "this folder cannot be read, so nothing in it was changed",
			});
			continue;
		}
		const present = new Map<string, string>(); // nameKey -> name on disk
		const replaced = new Set<string>(); // nameKeys whose link is removed and created again
		for (const name of names) {
			const key = nameKey(folder, name);
			present.set(key, name);
			const link = path.join(folder.dir, name);
			if (fs.kind(link) !== "link") continue;
			const dest = linkDest(fs, link);
			if (!owned(link, dest)) continue;
			const want = folder.wants.get(key);
			if (want && want.name === name && samePath(want.source, dest)) continue;
			removes.push({ kind: "remove", target: folder.active[0] ?? folder.ids[0], name, link });
			// Also a rename that changes only letter case: one remove and one create.
			if (want) replaced.add(key);
		}
		for (const [key, { name, source, target }] of folder.wants) {
			const link = path.join(folder.dir, name);
			const existing = present.get(key);
			if (existing === undefined || replaced.has(key)) {
				creates.push({ kind: "create", target, name, link, source });
				continue;
			}
			const at = path.join(folder.dir, existing);
			const dest = fs.kind(at) === "link" ? linkDest(fs, at) : null;
			if (samePath(dest, source)) continue;
			conflicts.push({ kind: "conflict", target, name, link: at, reason: conflictReason(fs, env, at, dest, source, cfg.vaultPath) });
		}
	}

	// A target that was removed or now points elsewhere leaves recorded links behind. Skip this while
	// any target path cannot be resolved: its links would look abandoned when they are not.
	if (!unresolved.length) {
		const seen = new Set<string>();
		for (const link of Object.keys(cfg.managedLinks ?? {})) {
			const key = entryKey(fs, link);
			if (seen.has(key) || folders.has(folderKey(fs, path.dirname(link))) || fs.kind(link) !== "link") continue;
			seen.add(key);
			if (owned(link, linkDest(fs, link))) removes.push({ kind: "remove", target: null, name: path.basename(link), link });
		}
	}

	return [...removes, ...creates, ...conflicts];
}

function conflictReason(fs: FileSystem, env: Env, link: string, dest: string | null, source: string, vaultPath: string): string {
	if (dest === null) return "a folder or file with this name already exists and is not managed by this plugin";
	const shown = tildify(dest, env.home);
	const real = fs.realpath(link);
	if (real && samePath(real, fs.realpath(source)))
		return `already links to this skill through ${shown}, which this plugin does not manage; delete that link to let the plugin manage it`;
	if (!fs.exists(link)) return `a broken link to ${shown} that this plugin did not create; delete it to let the plugin link this skill`;
	if (inside(vaultPath, dest))
		return `links to ${shown}, which is not a skill folder in the current settings and was not linked by this plugin; delete it to let the plugin link this skill`;
	return `links to ${shown}, which this plugin does not manage`;
}

/**
 * The links this vault manages, observed on disk, including existing installations and operations that
 * failed. Records for unavailable folders, and for folders that cannot be read, are kept so they can be
 * repaired or cleaned up later.
 */
export function collectManagedLinks(cfg: SyncConfig, ctx: Context = nodeContext()): Record<string, string> {
	const { fs } = ctx;
	const managed = { ...cfg.managedLinks };
	const owned = ownership(cfg, fs);
	const { folders, unresolved } = targetFolders(cfg, ctx, () => false);
	for (const folder of folders.values()) {
		if (!fs.isDir(folder.dir)) continue;
		const names = fs.list(folder.dir);
		if (names === null) continue;
		// Look at every listed entry and at every recorded link directly, so a listing that comes back
		// short never drops a record of a link that is still there.
		const candidates = new Map(names.map((name) => [entryKey(fs, path.join(folder.dir, name)), path.join(folder.dir, name)]));
		for (const link of Object.keys(managed)) {
			if (folderKey(fs, path.dirname(link)) !== folder.key) continue;
			delete managed[link];
			const key = entryKey(fs, link);
			if (!candidates.has(key)) candidates.set(key, link);
		}
		for (const link of candidates.values()) {
			if (fs.kind(link) !== "link") continue;
			const dest = linkDest(fs, link);
			if (owned(link, dest)) managed[link] = dest;
		}
	}
	// Folders that are no longer targets: forget links that are gone, so cleanup ends once it succeeds.
	if (!unresolved.length)
		for (const [link, dest] of Object.entries(managed)) {
			const dir = path.dirname(link);
			if (folders.has(folderKey(fs, dir)) || !fs.isDir(dir)) continue;
			if (fs.kind(link) !== "link" || !samePath(linkDest(fs, link), dest)) delete managed[link];
		}
	return managed;
}

/**
 * Plan that removes every link this vault owns, or only those in the folders of the given targets.
 * It never creates links, and removing one target leaves pending changes elsewhere for the next sync.
 */
export function planRemoval(cfg: SyncConfig, ctx: Context = nodeContext(), ids?: string[]): Op[] {
	const removes = plan(cfg, ctx, { disable: ids ?? "all" }).filter((op) => op.kind === "remove");
	if (!ids) return removes;
	const { fs, env } = ctx;
	const dirs = new Set(
		cfg.targets
			.filter((t) => ids.includes(t.id))
			.flatMap((t) => {
				const resolved = resolveTarget(t, env);
				return resolved.error === undefined ? [folderKey(fs, resolved.path)] : [];
			}),
	);
	return removes.filter((op) => dirs.has(folderKey(fs, path.dirname(op.link))));
}

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

// Filesystem side of the plugin: no Obsidian imports, so it can be tested with plain Node.
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface Target {
	path: string; // may start with "~"
	enabled: boolean;
}

export interface Group {
	folder: string; // relative to the skills folder; "" is the top level
	skip: string[]; // target paths this group is not linked into
}

export interface SyncConfig {
	vaultPath: string;
	skillsFolder: string; // vault-relative; "" is the vault root
	requireSkillMd: boolean;
	targets: Target[];
	groups: Group[];
	managedLinks?: Record<string, string>; // last observed link -> source, persisted across vault moves
}

export type Op =
	| { kind: "create"; link: string; source: string }
	| { kind: "remove"; link: string }
	| { kind: "conflict"; link: string; reason: string };

export const expandHome = (p: string): string =>
	p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;

const isDir = (p: string): boolean => {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
};

const lstat = (p: string): fs.Stats | null => {
	try {
		return fs.lstatSync(p);
	} catch {
		return null;
	}
};

const subdirs = (dir: string): string[] =>
	isDir(dir)
		? fs
				.readdirSync(dir, { withFileTypes: true })
				.filter((e) => e.isDirectory() && !e.name.startsWith("."))
				.map((e) => e.name)
		: [];

const linkDest = (link: string): string => path.resolve(path.dirname(link), fs.readlinkSync(link));

export const targetExists = (target: string): boolean => isDir(expandHome(target));

// Codex, Cursor, Copilot, Gemini CLI, OpenCode and most other agents read ~/.agents/skills;
// Claude Code reads only ~/.claude/skills. Agents' own folders are left out: linking there too lists skills twice.
export const DEFAULT_TARGETS = ["~/.agents/skills", "~/.claude/skills"];

// Target path -> (skill name -> source folder), plus name clashes between groups.
function desired(cfg: SyncConfig): { want: Map<string, Map<string, string>>; conflicts: Op[] } {
	const root = path.join(cfg.vaultPath, cfg.skillsFolder);
	const groupDirs = cfg.groups.map((g) => path.join(root, g.folder));
	const want = new Map(cfg.targets.filter((t) => t.enabled).map((t) => [t.path, new Map<string, string>()]));
	const conflicts: Op[] = [];
	for (const group of cfg.groups) {
		const dir = path.join(root, group.folder);
		for (const name of subdirs(dir)) {
			const source = path.join(dir, name);
			// A group folder (or a folder containing one) is never a skill itself.
			if (groupDirs.some((d) => d === source || d.startsWith(source + path.sep))) continue;
			if (cfg.requireSkillMd && !fs.existsSync(path.join(source, "SKILL.md"))) continue;
			for (const [target, skills] of want) {
				if (group.skip.includes(target)) continue;
				const taken = skills.get(name);
				if (!taken) skills.set(name, source);
				else if (taken !== source)
					conflicts.push({
						kind: "conflict",
						link: path.join(expandHome(target), name),
						reason: `both ${taken} and ${source} are named "${name}"`,
					});
			}
		}
	}
	return { want, conflicts };
}

// Links into this vault and recorded broken links from its old location are ours.
// Disabled targets get an empty wish list, so their links are cleaned up.
export function plan(cfg: SyncConfig): Op[] {
	// The adapter may still refer to the old vault path until Obsidian reopens it.
	if (!isDir(cfg.vaultPath)) return [];
	const { want, conflicts } = desired(cfg);
	const owned = (link: string, dest: string) =>
		dest.startsWith(cfg.vaultPath + path.sep) ||
		(cfg.managedLinks?.[link] === dest && !fs.existsSync(dest));
	const removes: Op[] = [];
	const creates: Op[] = [];
	for (const target of cfg.targets) {
		const dir = expandHome(target.path);
		if (!isDir(dir)) continue;
		const skills = want.get(target.path) ?? new Map<string, string>();
		for (const name of fs.readdirSync(dir)) {
			const link = path.join(dir, name);
			if (!lstat(link)?.isSymbolicLink()) continue;
			const dest = linkDest(link);
			if (owned(link, dest) && skills.get(name) !== dest) removes.push({ kind: "remove", link });
		}
		for (const [name, source] of skills) {
			const link = path.join(dir, name);
			const st = lstat(link);
			const dest = st?.isSymbolicLink() ? linkDest(link) : null;
			if (dest === source) continue;
			if (!st || (dest && owned(link, dest))) creates.push({ kind: "create", link, source });
			else conflicts.push({ kind: "conflict", link, reason: "already exists and is not managed by this plugin" });
		}
	}
	return [...removes, ...creates, ...conflicts];
}

// Observe actual links, including existing installations and operations that failed.
// Keep records for unavailable targets so they can be repaired when mounted again.
export function collectManagedLinks(cfg: SyncConfig): Record<string, string> {
	const managed = { ...cfg.managedLinks };
	for (const target of cfg.targets) {
		const dir = expandHome(target.path);
		if (!isDir(dir)) continue;
		for (const link of Object.keys(managed)) {
			if (path.dirname(link) === dir) delete managed[link];
		}
		for (const name of fs.readdirSync(dir)) {
			const link = path.join(dir, name);
			if (!lstat(link)?.isSymbolicLink()) continue;
			const dest = linkDest(link);
			if (dest.startsWith(cfg.vaultPath + path.sep) || cfg.managedLinks?.[link] === dest) managed[link] = dest;
		}
	}
	return managed;
}

// Plan that removes every link this vault owns in the given targets.
export const planRemoval = (cfg: SyncConfig, targets = cfg.targets): Op[] =>
	plan({ ...cfg, targets: targets.map((t) => ({ ...t, enabled: false })) });

export function apply(ops: Op[]): { done: Op[]; failed: { op: Op; error: string }[] } {
	const done: Op[] = [];
	const failed: { op: Op; error: string }[] = [];
	for (const op of ops) {
		try {
			if (op.kind === "remove") fs.unlinkSync(op.link);
			// "junction" makes directory links work on Windows without admin rights; it is ignored elsewhere.
			else if (op.kind === "create") fs.symlinkSync(op.source, op.link, "junction");
			else continue;
			done.push(op);
		} catch (e) {
			failed.push({ op, error: e instanceof Error ? e.message : String(e) });
		}
	}
	return { done, failed };
}

// Targets, groups and routing: the shapes stored in settings and the rules that connect them.
import * as path from "path";
import type { Env } from "./fsys.ts";
import { type Resolved, resolvePath } from "./paths.ts";

/**
 * "folder": `path` is a folder an agent reads skills from, such as ~/.agents/skills.
 * "claude": `path` is a Claude Code config folder (~/.claude, or any folder used as CLAUDE_CONFIG_DIR),
 * and links go into its skills subfolder.
 */
export type TargetKind = "folder" | "claude";

export interface Target {
	id: string; // stable, referenced by routings; never changes when the label or path is edited
	label: string;
	kind: TargetKind;
	path: string; // may start with "~" and use $NAME or ${NAME}
	enabled: boolean;
}

/** Which targets receive a set of skills. "all" includes targets added later; "only" does not. */
export type Routing = { mode: "all"; except: string[] } | { mode: "only"; only: string[] };

export interface Group {
	folder: string; // relative to the skills folder; "" is the top level
	routing: Routing;
}

export const routes = (routing: Routing, id: string): boolean =>
	routing.mode === "all" ? !routing.except.includes(id) : routing.only.includes(id);

/** The routing with one target switched on or off, keeping its mode. */
export function setRoute(routing: Routing, id: string, on: boolean): Routing {
	if (routing.mode === "all") {
		const except = routing.except.filter((x) => x !== id);
		return { mode: "all", except: on ? except : [...except, id] };
	}
	const only = routing.only.filter((x) => x !== id);
	return { mode: "only", only: on ? [...only, id] : only };
}

/** Switches the mode without changing which of the current targets are selected. */
export function setMode(routing: Routing, mode: Routing["mode"], ids: string[]): Routing {
	if (routing.mode === mode) return routing;
	const selected = ids.filter((id) => routes(routing, id));
	return mode === "all"
		? { mode: "all", except: ids.filter((id) => !selected.includes(id)) }
		: { mode: "only", only: selected };
}

export const forgetTarget = (routing: Routing, id: string): Routing =>
	routing.mode === "all"
		? { mode: "all", except: routing.except.filter((x) => x !== id) }
		: { mode: "only", only: routing.only.filter((x) => x !== id) };

/** The folder links are created in: the target folder itself, or the skills folder of a Claude Code config folder. */
export function resolveTarget(target: Pick<Target, "kind" | "path">, env: Env): Resolved {
	const resolved = resolvePath(target.path, env);
	if (resolved.error !== undefined || target.kind !== "claude") return resolved;
	return { path: path.join(resolved.path, "skills") };
}

/** The Claude Code config folder a target links into, if it is one. */
export function claudeConfigOf(target: Pick<Target, "kind" | "path">, env: Env): string | null {
	const resolved = resolvePath(target.path, env);
	if (resolved.error !== undefined) return null;
	if (target.kind === "claude") return resolved.path;
	return path.basename(resolved.path) === "skills" ? path.dirname(resolved.path) : null;
}

const baseName = (p: string): string => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";

// "~/.claude" -> "Claude Code", "~/.claude-work" -> "Claude Code (work)", "/x/claude-home" -> "Claude Code (home)".
export function claudeLabel(configPath: string): string {
	const name = baseName(configPath).replace(/^\./, "");
	if (/^claude$/i.test(name)) return "Claude Code";
	const suffix = name.replace(/^claude[-_.]?/i, "");
	return `Claude Code (${suffix || name || configPath})`;
}

export function uniqueId(base: string, taken: Iterable<string>): string {
	const slug =
		base
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "folder";
	const used = new Set(taken);
	if (!used.has(slug)) return slug;
	for (let i = 2; ; i++) if (!used.has(`${slug}-${i}`)) return `${slug}-${i}`;
}

export const SHARED_AGENTS_PATH = "~/.agents/skills";
export const CLAUDE_CONFIG_PATH = "~/.claude";

// Codex, Cursor, Copilot, Gemini CLI, OpenCode and most other agents read ~/.agents/skills;
// Claude Code reads only the skills folder of its config folder. Agents' own folders are left out:
// linking there too lists skills twice.
export const defaultTargets = (): Target[] => [
	{ id: "agents", label: "Shared agent skills", kind: "folder", path: SHARED_AGENTS_PATH, enabled: true },
	{ id: "claude", label: "Claude Code", kind: "claude", path: CLAUDE_CONFIG_PATH, enabled: true },
];

/** A new target for a path typed by the user or read from old settings. */
export function targetFor(value: string, kind: TargetKind | "auto", taken: string[]): Target {
	const p = value.trim();
	const claudeSkills = /^(.*?)[\\/]+skills[\\/]*$/.exec(p);
	if (kind === "claude" || (kind === "auto" && claudeSkills && /^\.?claude([-_.].*)?$/i.test(baseName(claudeSkills[1])))) {
		// A Claude Code profile is its config folder; accept its skills folder too.
		const config = claudeSkills ? claudeSkills[1] : p.replace(/[\\/]+$/, "") || p;
		const label = claudeLabel(config);
		const id = config === CLAUDE_CONFIG_PATH ? uniqueId("claude", taken) : uniqueId(label.replace(/^Claude Code/, "claude"), taken);
		return { id, label, kind: "claude", path: config, enabled: true };
	}
	if (p === SHARED_AGENTS_PATH)
		return { id: uniqueId("agents", taken), label: "Shared agent skills", kind: "folder", path: p, enabled: true };
	return { id: uniqueId(baseName(path.dirname(p)) || baseName(p), taken), label: p, kind: "folder", path: p, enabled: true };
}

// Finds Claude Code config folders so settings can suggest them. Nothing is added automatically.
import * as path from "path";
import { type Target, claudeConfigOf } from "./model.ts";
import { folderKey, literalPath, resolvePath } from "./paths.ts";
import type { Context } from "./sync.ts";

// Claude Code keeps projects/ and settings.json in its config folder, and .claude.json too when the
// folder is set with CLAUDE_CONFIG_DIR. Other folders whose names merely contain "claude" lack them.
const MARKERS = [".claude.json", "projects", "settings.json"];

export const looksLikeClaudeConfig = ({ fs }: Context, dir: string): boolean =>
	fs.isDir(dir) && MARKERS.some((marker) => fs.kind(path.join(dir, marker)) !== null);

/**
 * Candidates: $CLAUDE_CONFIG_DIR when Obsidian sees it, ~/.claude, ~/.claude-<name> (or ~/.claude.<name>),
 * and folders named like "claude" in the config home (~/.config or $XDG_CONFIG_HOME) or one level below it.
 */
export function findClaudeConfigs(ctx: Context): string[] {
	const { fs, env } = ctx;
	const found: string[] = [];
	const keys = new Set<string>();
	// The same folder reached through a symlink is listed once.
	const add = (dir: string) => {
		const key = folderKey(fs, dir);
		if (keys.has(key) || !looksLikeClaudeConfig(ctx, dir)) return;
		keys.add(key);
		found.push(dir);
	};
	// Claude Code reads the variable as a path, so a "$" in it is part of a folder name.
	const fromEnv = env.vars.CLAUDE_CONFIG_DIR ? resolvePath(literalPath(env.vars.CLAUDE_CONFIG_DIR), env).path : undefined;
	if (fromEnv) add(fromEnv);
	add(path.join(env.home, ".claude"));
	for (const name of (fs.list(env.home) ?? []).sort()) if (/^\.claude[-_.]/i.test(name)) add(path.join(env.home, name));
	const configHome = env.vars.XDG_CONFIG_HOME || path.join(env.home, ".config");
	for (const name of (fs.list(configHome) ?? []).sort()) {
		const dir = path.join(configHome, name);
		if (/claude/i.test(name)) add(dir);
		else if (fs.kind(dir) === "dir")
			for (const inner of (fs.list(dir) ?? []).sort()) if (/claude/i.test(inner)) add(path.join(dir, inner));
	}
	return found;
}

/** Found config folders that no target links into yet. */
export const unlinkedClaudeConfigs = (ctx: Context, targets: Target[]): string[] => {
	const linked = new Set(targets.flatMap((t) => claudeConfigOf(t, ctx.env) ?? []).map((p) => folderKey(ctx.fs, p)));
	return findClaudeConfigs(ctx).filter((dir) => !linked.has(folderKey(ctx.fs, dir)));
};

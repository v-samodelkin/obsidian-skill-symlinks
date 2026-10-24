// Finds Claude Code config folders so settings can suggest them. Nothing is added automatically.
import * as path from "path";
import { type Target, claudeConfigOf } from "./model.ts";
import { resolvePath, samePath } from "./paths.ts";
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
	const add = (dir: string) => {
		if (!found.some((p) => samePath(p, dir)) && looksLikeClaudeConfig(ctx, dir)) found.push(dir);
	};
	const fromEnv = env.vars.CLAUDE_CONFIG_DIR ? resolvePath(env.vars.CLAUDE_CONFIG_DIR, env).path : undefined;
	if (fromEnv) add(fromEnv);
	add(path.join(env.home, ".claude"));
	for (const name of fs.list(env.home).sort()) if (/^\.claude[-_.]/i.test(name)) add(path.join(env.home, name));
	const configHome = env.vars.XDG_CONFIG_HOME || path.join(env.home, ".config");
	for (const name of fs.list(configHome).sort()) {
		const dir = path.join(configHome, name);
		if (/claude/i.test(name)) add(dir);
		else if (fs.kind(dir) === "dir")
			for (const inner of fs.list(dir).sort()) if (/claude/i.test(inner)) add(path.join(dir, inner));
	}
	return found;
}

/** Found config folders that no target links into yet. */
export const unlinkedClaudeConfigs = (ctx: Context, targets: Target[]): string[] => {
	const linked = targets.map((t) => claudeConfigOf(t, ctx.env));
	return findClaudeConfigs(ctx).filter((dir) => !linked.some((p) => samePath(p, dir)));
};

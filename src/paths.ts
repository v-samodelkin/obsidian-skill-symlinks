import * as os from "os";
import * as path from "path";
import type { Env, FileSystem } from "./fsys.ts";

export type Resolved = { path: string; error?: undefined } | { path?: undefined; error: string };

const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

// Expands a leading "~" and $NAME or ${NAME} variables. Obsidian started from a dock or start menu
// usually lacks variables set only in a shell profile, so an unset variable is an error, not "".
export function resolvePath(value: string, env: Env): Resolved {
	let p = value.trim();
	if (!p) return { error: "no path" };
	const missing = new Set<string>();
	p = p.replace(VARIABLE, (match: string, braced?: string, bare?: string) => {
		const name = braced ?? bare ?? "";
		const found = env.vars[name];
		if (!found) missing.add(name);
		return found ?? match;
	});
	if (missing.size) return { error: `$${[...missing].join(", $")} is not set in Obsidian's environment` };
	if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) p = path.join(env.home, p.slice(1));
	if (!path.isAbsolute(p)) return { error: "not an absolute path" };
	return { path: path.resolve(p) };
}

// Shortens a path under the home folder for display.
export function tildify(p: string, home: string): string {
	if (!home) return p;
	if (samePath(p, home)) return "~";
	return inside(home, p) ? "~" + path.sep + path.relative(home, p) : p;
}

// Compare equivalent Windows paths without changing the paths used for filesystem operations.
export const pathKey = (value: string): string => {
	const absolute = path.toNamespacedPath(path.resolve(value));
	return os.platform() === "win32" ? absolute.toLowerCase() : absolute;
};

export const samePath = (left: string | null | undefined, right: string | null | undefined): boolean =>
	left != null && right != null && pathKey(left) === pathKey(right);

export const inside = (parent: string, child: string): boolean => {
	const relative = path.relative(pathKey(parent), pathKey(child));
	return relative !== "" && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
};

export const toPosix = (p: string): string => p.split(path.sep).join("/");

/** Key for a folder that is the same for every path reaching it, including through symlinks. */
export const folderKey = (fs: Pick<FileSystem, "realpath">, dir: string): string => pathKey(fs.realpath(dir) ?? dir);

/** Key for an entry in a folder, with the folder reached through any symlinks. */
export const entryKey = (fs: Pick<FileSystem, "realpath">, p: string): string =>
	pathKey(path.join(fs.realpath(path.dirname(p)) ?? path.dirname(p), path.basename(p)));

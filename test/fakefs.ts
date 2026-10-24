// In-memory FileSystem for planner tests: directories, files and symlinks with POSIX-like resolution,
// optionally on a volume that ignores letter case (keeping each name as it was created).
import * as path from "node:path";
import type { EntryKind, Env, FileSystem } from "../src/fsys.ts";

type Entry = { kind: "dir" } | { kind: "file" } | { kind: "link"; to: string };

const fail = (code: string, p: string): never => {
	throw Object.assign(new Error(`${code}: ${p}`), { code });
};

export class FakeFs implements FileSystem {
	entries = new Map<string, Entry>();
	private ignoreCase: boolean;

	constructor(options: { ignoreCase?: boolean } = {}) {
		this.ignoreCase = options.ignoreCase ?? false;
	}

	// The stored spelling of a path, which differs from `p` only in letter case on a case-insensitive volume.
	private stored(p: string): string | undefined {
		if (this.entries.has(p)) return p;
		if (!this.ignoreCase) return undefined;
		const folded = p.toLowerCase();
		for (const key of this.entries.keys()) if (key.toLowerCase() === folded) return key;
		return undefined;
	}

	// Where a path is (or would be) stored, with every parent in its stored spelling; links are not followed.
	private place(p: string): string {
		const abs = path.resolve(p);
		if (abs === path.parse(abs).root) return abs;
		const at = path.join(this.place(path.dirname(abs)), path.basename(abs));
		return this.stored(at) ?? at;
	}

	/** Creates a directory and its parents. */
	dir(p: string): this {
		const abs = path.resolve(p);
		if (abs !== path.parse(abs).root) {
			this.dir(path.dirname(abs));
			const at = this.place(abs);
			if (!this.entries.has(at)) this.entries.set(at, { kind: "dir" });
		}
		return this;
	}

	file(p: string): this {
		this.dir(path.dirname(p));
		this.entries.set(this.place(p), { kind: "file" });
		return this;
	}

	link(link: string, to: string): this {
		this.dir(path.dirname(link));
		this.entries.set(this.place(link), { kind: "link", to });
		return this;
	}

	/** Removes a path and everything below it, as a rename or delete outside the plugin would. */
	drop(p: string): this {
		const at = this.place(p);
		for (const key of [...this.entries.keys()]) if (key === at || key.startsWith(at + path.sep)) this.entries.delete(key);
		return this;
	}

	// Canonical path with every link followed, or null when a component is missing.
	private follow(p: string, depth = 0): string | null {
		if (depth > 40) return null;
		const abs = path.resolve(p);
		const { root } = path.parse(abs);
		let current = root;
		for (const part of abs.slice(root.length).split(path.sep).filter(Boolean)) {
			const next = this.stored(path.join(current, part));
			const entry = next === undefined ? undefined : this.entries.get(next);
			if (next === undefined || !entry) return null;
			if (entry.kind === "link") {
				const resolved = this.follow(path.resolve(current, entry.to), depth + 1);
				if (resolved === null) return null;
				current = resolved;
			} else current = next;
		}
		return current;
	}

	// The entry itself, with links followed only in its parent folders.
	private lstat(p: string): { at: string; entry: Entry | null } | null {
		const abs = path.resolve(p);
		if (abs === path.parse(abs).root) return { at: abs, entry: { kind: "dir" } };
		const parent = this.follow(path.dirname(abs));
		if (parent === null) return null;
		const wanted = path.join(parent, path.basename(abs));
		const at = this.stored(wanted);
		return at === undefined ? { at: wanted, entry: null } : { at, entry: this.entries.get(at) ?? null };
	}

	kind(p: string): EntryKind | null {
		return this.lstat(p)?.entry?.kind ?? null;
	}

	isDir(p: string): boolean {
		const real = this.follow(p);
		return real !== null && (real === path.parse(real).root || this.entries.get(real)?.kind === "dir");
	}

	exists(p: string): boolean {
		return this.follow(p) !== null;
	}

	list(dir: string): string[] | null {
		const real = this.follow(dir);
		if (real === null || !this.isDir(real)) return null;
		return [...this.entries.keys()].filter((k) => k !== real && path.dirname(k) === real).map((k) => path.basename(k));
	}

	readlink(link: string): string {
		const entry = this.lstat(link)?.entry;
		if (entry?.kind !== "link") return fail("EINVAL", link);
		return entry.to;
	}

	realpath(p: string): string | null {
		return this.follow(p);
	}

	ignoresCase(): boolean {
		return this.ignoreCase;
	}

	symlink(source: string, link: string): void {
		const found = this.lstat(link);
		if (!found || !this.isDir(path.dirname(found.at))) fail("ENOENT", link);
		if (found!.entry) fail("EEXIST", link);
		this.entries.set(found!.at, { kind: "link", to: source });
	}

	unlink(link: string): void {
		const found = this.lstat(link);
		if (!found?.entry) return fail("ENOENT", link);
		if (found.entry.kind === "dir") fail("EISDIR", link);
		this.entries.delete(found.at);
	}

	mkdir(dir: string): void {
		const found = this.lstat(dir);
		if (!found || !this.isDir(path.dirname(found.at))) fail("ENOENT", dir);
		if (found!.entry) fail("EEXIST", dir);
		this.entries.set(found!.at, { kind: "dir" });
	}

	/** Link name -> destination for every symlink in a folder. */
	links(dir: string): Record<string, string> {
		return Object.fromEntries(
			(this.list(dir) ?? [])
				.filter((name) => this.kind(path.join(dir, name)) === "link")
				.map((name) => [name, this.readlink(path.join(dir, name))]),
		);
	}
}

export const fakeEnv = (home: string, vars: Record<string, string> = {}): Env => ({ home, vars });

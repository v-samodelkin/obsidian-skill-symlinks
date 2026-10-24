// In-memory FileSystem for planner tests: directories, files and symlinks with POSIX-like resolution.
import * as path from "node:path";
import type { EntryKind, Env, FileSystem } from "../src/fsys.ts";

type Entry = { kind: "dir" } | { kind: "file" } | { kind: "link"; to: string };

const fail = (code: string, p: string): never => {
	throw Object.assign(new Error(`${code}: ${p}`), { code });
};

export class FakeFs implements FileSystem {
	entries = new Map<string, Entry>();

	/** Creates a directory and its parents. */
	dir(p: string): this {
		const abs = path.resolve(p);
		const root = path.parse(abs).root;
		if (abs !== root) {
			this.dir(path.dirname(abs));
			if (!this.entries.has(abs)) this.entries.set(abs, { kind: "dir" });
		}
		return this;
	}

	file(p: string): this {
		this.dir(path.dirname(p));
		this.entries.set(path.resolve(p), { kind: "file" });
		return this;
	}

	link(link: string, to: string): this {
		this.dir(path.dirname(link));
		this.entries.set(path.resolve(link), { kind: "link", to });
		return this;
	}

	// Canonical path with every link followed, or null when a component is missing.
	private follow(p: string, depth = 0): string | null {
		if (depth > 40) return null;
		const abs = path.resolve(p);
		const { root } = path.parse(abs);
		let current = root;
		for (const part of abs.slice(root.length).split(path.sep).filter(Boolean)) {
			const next = path.join(current, part);
			const entry = this.entries.get(next);
			if (!entry) return null;
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
		const at = path.join(parent, path.basename(abs));
		return { at, entry: this.entries.get(at) ?? null };
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

	list(dir: string): string[] {
		const real = this.follow(dir);
		if (real === null || !this.isDir(real)) return [];
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
			this.list(dir)
				.filter((name) => this.kind(path.join(dir, name)) === "link")
				.map((name) => [name, this.readlink(path.join(dir, name))]),
		);
	}
}

export const fakeEnv = (home: string, vars: Record<string, string> = {}): Env => ({ home, vars });

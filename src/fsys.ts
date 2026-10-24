// The few filesystem and environment calls the planner needs, so tests can swap in an in-memory fake.
import * as fs from "fs";
import * as os from "os";

export type EntryKind = "dir" | "file" | "link";

export interface FileSystem {
	/** What is at this path without following a symlink, or null when nothing is there. */
	kind(p: string): EntryKind | null;
	/** Whether the path is a directory, following symlinks. */
	isDir(p: string): boolean;
	/** Whether the path exists, following symlinks: false for a broken link. */
	exists(p: string): boolean;
	/** Entry names of a directory, or an empty list when it cannot be read. */
	list(dir: string): string[];
	readlink(link: string): string;
	/** Canonical path with every link resolved, or null when it does not resolve. */
	realpath(p: string): string | null;
	symlink(source: string, link: string): void;
	unlink(link: string): void;
	mkdir(dir: string): void;
}

export interface Env {
	home: string;
	vars: Record<string, string | undefined>;
}

export const nodeFs: FileSystem = {
	kind(p) {
		try {
			const st = fs.lstatSync(p);
			return st.isSymbolicLink() ? "link" : st.isDirectory() ? "dir" : "file";
		} catch {
			return null;
		}
	},
	isDir(p) {
		try {
			return fs.statSync(p).isDirectory();
		} catch {
			return false;
		}
	},
	exists: (p) => fs.existsSync(p),
	list(dir) {
		try {
			return fs.readdirSync(dir);
		} catch {
			return [];
		}
	},
	readlink: (link) => fs.readlinkSync(link),
	realpath(p) {
		try {
			return fs.realpathSync(p);
		} catch {
			return null;
		}
	},
	// "junction" makes directory links work on Windows without admin rights; it is ignored elsewhere.
	symlink: (source, link) => fs.symlinkSync(source, link, "junction"),
	unlink: (link) => fs.unlinkSync(link),
	mkdir: (dir) => fs.mkdirSync(dir),
};

export const nodeEnv = (): Env => ({ home: os.homedir(), vars: process.env });

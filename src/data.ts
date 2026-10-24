// Stored settings: defaults, validation and migration from earlier formats. No Obsidian imports.
import * as path from "path";
import { type Group, type Routing, type Target, defaultTargets, targetFor, uniqueId } from "./model.ts";
import { literalPath } from "./paths.ts";

export const SETTINGS_VERSION = 2;

// Targets are stored under their own key from version 2 on. Version 1.0 reads only "targets" and
// starts with none when it is missing, so it does nothing with newer settings instead of misreading them.
const TARGETS_KEY = "agentFolders";

export interface Settings {
	version: number;
	enabled: boolean;
	skillsFolder: string;
	requireSkillMd: boolean;
	targets: Target[];
	groups: Group[];
	skillRouting: Record<string, Routing>; // vault-relative skill folder -> routing that replaces its group's
	hiddenSuggestions: string[]; // suggested folders the user dismissed
	managedLinks: Record<string, string>;
}

export const defaultSettings = (): Settings => ({
	version: SETTINGS_VERSION,
	enabled: false,
	skillsFolder: "",
	requireSkillMd: true,
	targets: defaultTargets(),
	groups: [{ folder: "", routing: { mode: "all", except: [] } }],
	skillRouting: {},
	hiddenSuggestions: [],
	managedLinks: {},
});

type Raw = Record<string, unknown>;

const isObject = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const strings = (value: unknown): string[] => [...new Set(list(value).filter((x): x is string => typeof x === "string"))];
const text = (value: unknown, fallback: string): string => (typeof value === "string" ? value : fallback);
const flag = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback);
const stringRecord = (value: unknown): Record<string, string> =>
	isObject(value) ? Object.fromEntries(Object.entries(value).filter((e): e is [string, string] => typeof e[1] === "string")) : {};

function routing(value: unknown): Routing {
	if (isObject(value) && value.mode === "only") return { mode: "only", only: strings(value.only) };
	return { mode: "all", except: isObject(value) ? strings(value.except) : [] };
}

// 1.0.x read a path as written, expanding only a leading "~/". A path that was absolute that way named a
// real folder, so a "$" in it stays a "$". Any other path could never be linked, and now expands.
const fromV1Path = (written: string, converted: string): string =>
	written === "~" || written.startsWith("~/") || path.isAbsolute(written) ? literalPath(converted) : converted;

/**
 * 1.0.x stored targets as skills folder paths and groups as lists of target paths to skip.
 * Paths keep their meaning: ~/.claude/skills becomes the Claude Code config folder ~/.claude, whose
 * skills folder is the same folder, and skip lists become exclusions, so targets added later still get
 * every group, as before.
 */
function fromV1(raw: Raw): Settings {
	const targets: Target[] = [];
	const idByPath = new Map<string, string>();
	for (const entry of list(raw.targets)) {
		if (!isObject(entry) || typeof entry.path !== "string" || idByPath.has(entry.path)) continue;
		const target = targetFor(entry.path, "auto", targets.map((t) => t.id));
		target.path = fromV1Path(entry.path, target.path);
		// 1.0.x skipped a target unless `enabled` was true.
		target.enabled = entry.enabled === true;
		targets.push(target);
		idByPath.set(entry.path, target.id);
	}
	const groups: Group[] =
		raw.groups === undefined
			? defaultSettings().groups
			: list(raw.groups)
					.filter(isObject)
					.filter((g) => typeof g.folder === "string")
					.map((g) => ({
						folder: g.folder as string,
						routing: {
							mode: "all",
							except: [...new Set(strings(g.skip).flatMap((p) => idByPath.get(p) ?? []))],
						},
					}));
	return {
		version: SETTINGS_VERSION,
		enabled: flag(raw.enabled, false),
		skillsFolder: text(raw.skillsFolder, ""),
		requireSkillMd: flag(raw.requireSkillMd, true),
		targets,
		groups,
		skillRouting: {},
		hiddenSuggestions: [],
		managedLinks: stringRecord(raw.managedLinks),
	};
}

function fromV2(raw: Raw): Settings {
	// Unknown fields from a newer version survive a round trip: on the settings, targets and groups.
	// Builds of 1.1.0 before its release stored targets as "targets".
	const { [TARGETS_KEY]: stored, targets: early, ...rest } = raw;
	const targets: Target[] = [];
	for (const entry of list(stored ?? early)) {
		if (!isObject(entry) || typeof entry.path !== "string") continue;
		const taken = targets.map((t) => t.id);
		const id = typeof entry.id === "string" && entry.id && !taken.includes(entry.id) ? entry.id : uniqueId(entry.path, taken);
		targets.push({
			...entry,
			id,
			label: text(entry.label, entry.path),
			kind: entry.kind === "claude" ? "claude" : "folder",
			path: entry.path,
			enabled: flag(entry.enabled, true),
		});
	}
	const groups = list(raw.groups)
		.filter(isObject)
		.filter((g) => typeof g.folder === "string")
		.map((g) => ({ ...g, folder: g.folder as string, routing: routing(g.routing) }));
	const skillRouting = isObject(raw.skillRouting)
		? Object.fromEntries(Object.entries(raw.skillRouting).map(([key, value]) => [key, routing(value)]))
		: {};
	return {
		...rest,
		version: Math.max(SETTINGS_VERSION, typeof raw.version === "number" ? raw.version : 0),
		enabled: flag(raw.enabled, false),
		skillsFolder: text(raw.skillsFolder, ""),
		requireSkillMd: flag(raw.requireSkillMd, true),
		targets,
		groups,
		skillRouting,
		hiddenSuggestions: strings(raw.hiddenSuggestions),
		managedLinks: stringRecord(raw.managedLinks),
	};
}

/** What is saved: the settings with targets under their storage key. */
export function toData(settings: Settings): Record<string, unknown> {
	const { targets, ...rest } = settings;
	return { ...rest, [TARGETS_KEY]: targets };
}

/**
 * Settings from saved data, and whether saving them would change the data. Older formats are converted
 * in memory only; the plugin writes the current format with the first change or sync record.
 */
export function loadSettings(data: unknown): { settings: Settings; changed: boolean } {
	// A fresh install links nothing until sync is turned on; a missing folder is skipped until it exists.
	if (!isObject(data)) return { settings: defaultSettings(), changed: false };
	const settings = data.version === undefined ? fromV1(data) : fromV2(data);
	return { settings, changed: JSON.stringify(toData(settings)) !== JSON.stringify(data) };
}

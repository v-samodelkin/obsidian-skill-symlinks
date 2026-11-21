/** Versioned local editor protocol. No paths outside a selected skill are accepted. */
export const EDITOR_SCHEMA = 1 as const;
export const TEXT_LIMIT = 256 * 1024;
export const ASSET_LIMIT = 512 * 1024;
export type EditorAction = "catalog" | "tree" | "read" | "save" | "create" | "rename" | "trash" | "connect" | "inherit" | "undo";
export interface EditorCommand {
	action: EditorAction;
	bundleId?: string;
	fileId?: string;
	parentId?: string;
	targetId?: string;
	name?: string;
	kind?: "file" | "folder";
	text?: string;
	enabled?: boolean;
	expectedRevision?: string;
	operationId?: string;
	undoId?: string;
	deadline?: number;
}
export interface EditorTarget { id: string; label: string; labels: string[]; enabled: boolean }
export interface EditorConnection {
	targetId: string;
	wanted: boolean;
	linked: boolean;
	state: "linked" | "off" | "profile-off" | "sync-off" | "conflict" | "missing";
	detail: string | null;
}
export interface EditorBundle {
	id: string;
	entryPath: string;
	name: string;
	group: string;
	routing: "group" | "custom";
	connections: EditorConnection[];
}
export interface EditorCatalog {
	kind: "catalog";
	vault: { id: string; name: string };
	revision: string;
	syncEnabled: boolean;
	bundles: EditorBundle[];
	targets: EditorTarget[];
}
export interface EditorEntry {
	id: string;
	parentId: string;
	path: string;
	name: string;
	kind: "file" | "folder" | "blocked";
	bytes: number | null;
	editable: boolean;
	mime: string;
}
export interface EditorTree { kind: "tree"; bundleId: string; rootId: string; revision: string; entries: EditorEntry[] }
export interface EditorFile {
	kind: "file";
	bundleId: string;
	fileId: string;
	path: string;
	name: string;
	revision: string;
	bytes: number;
	mime: string;
	editable: boolean;
	text?: string;
	data?: string;
}
export interface EditorMutation { kind: "mutation"; operationId: string; undoId: string | null; fileId?: string; warning?: string; catalog?: EditorCatalog }
export type EditorResult = EditorCatalog | EditorTree | EditorFile | EditorMutation;
export interface EditorReply {
	schema: typeof EDITOR_SCHEMA;
	mode: "live";
	provenance: { source: "Obsidian Skill Symlinks"; at: string };
	available: boolean;
	result?: EditorResult;
	reason?: string;
	detail?: string;
}

const fields: Record<EditorAction, string[]> = {
	catalog: [], tree: ["bundleId"], read: ["bundleId", "fileId"],
	save: ["bundleId", "fileId", "expectedRevision", "text", "operationId", "deadline"],
	create: ["bundleId", "parentId", "name", "kind", "expectedRevision", "operationId", "deadline"],
	rename: ["bundleId", "fileId", "name", "expectedRevision", "operationId", "deadline"],
	trash: ["bundleId", "fileId", "expectedRevision", "operationId", "deadline"],
	connect: ["bundleId", "targetId", "enabled", "expectedRevision", "operationId", "deadline"],
	inherit: ["bundleId", "expectedRevision", "operationId", "deadline"],
	undo: ["undoId", "operationId", "deadline"],
};
/** The same shape is validated at the browser boundary, the bridge and this API. */
export function parseEditorCommand(value: unknown): EditorCommand {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid editor command");
	const raw = value as Record<string, unknown>;
	if (typeof raw.action !== "string" || !Object.prototype.hasOwnProperty.call(fields, raw.action)) throw new Error("Invalid editor command");
	const action = raw.action as EditorAction;
	const allowed = ["action", ...fields[action]];
	if (Object.keys(raw).some((key) => !allowed.includes(key))) throw new Error("Invalid editor command");
	for (const key of fields[action]) {
		const v = raw[key];
		if (key === "deadline") {
			if (v !== undefined && (!Number.isSafeInteger(v) || (v as number) <= 0)) throw new Error("Invalid editor command");
		} else if (key === "enabled") {
			if (typeof v !== "boolean") throw new Error("Invalid editor command");
		} else if (key === "text") {
			if (typeof v !== "string" || new TextEncoder().encode(v).length > TEXT_LIMIT) throw new Error("File is too large");
		} else if (typeof v !== "string" || !v || v.length > (key === "name" ? 512 : 96)) throw new Error("Invalid editor command");
	}
	if (raw.kind !== undefined && raw.kind !== "file" && raw.kind !== "folder") throw new Error("Invalid editor command");
	if (raw.operationId !== undefined && (typeof raw.operationId !== "string" || !/^[a-zA-Z0-9_-]{16,80}$/.test(raw.operationId))) throw new Error("Invalid editor command");
	return raw as unknown as EditorCommand;
}

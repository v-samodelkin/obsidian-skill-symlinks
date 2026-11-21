import { TFile, TFolder } from "obsidian";
import type SkillSymlinksPlugin from "../main.ts";
import { createEditorCore, EditorError, type EditorHost } from "./core.ts";
import { readPreference, startLocalEditor, vaultHash } from "./local.ts";

export function editorHost(plugin: SkillSymlinksPlugin): EditorHost {
	const vault = plugin.app.vault;
	const file = (name: string) => {
		const entry = vault.getAbstractFileByPath(name);
		if (!(entry instanceof TFile) || entry.path !== name) throw new EditorError(409, "file-changed", "This file changed. Refresh to compare; your draft is kept.");
		return entry;
	};
	return {
		settings: () => plugin.settings, config: () => plugin.config(), context: plugin.ctx,
		persist: () => plugin.saveSettings(),
		changed: () => plugin.settingsChanged(), exclusive: (work) => plugin.editorOperation(work),
		async read(name) { return new Uint8Array(await vault.readBinary(file(name))); },
		async process(name, change) { const current = file(name); await vault.process(current, (text) => { if (current.path !== name) throw new EditorError(409, "file-changed", "This file moved. Refresh to compare; your draft is kept."); return change(text); }); },
		async create(name, bytes) { await vault.createBinary(name, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer); },
		async mkdir(name) { await vault.createFolder(name); },
		async rename(from, to) { await vault.rename(file(from), to); },
		async trash(name) {
			const current = vault.getAbstractFileByPath(name);
			if (!current || current.path !== name || (current instanceof TFolder && current.isRoot())) throw new EditorError(409, "file-changed", "This entry changed. Refresh to compare.");
			// The editor always uses recoverable trash, even if Obsidian's preference is permanent deletion.
			await vault.trash(current, true);
		},
		async owned(paths, work) {
			for (const name of paths) plugin.editorPaths.add(name);
			try { return await work(); } finally { for (const name of paths) plugin.editorPaths.delete(name); }
		},
	};
}
export async function openEditor(plugin: SkillSymlinksPlugin) {
	const cfg = plugin.config();
	if (!cfg) return null;
	const preference = readPreference(cfg.vaultPath);
	if (!preference?.enabled) return null;
	// IDs are not credentials. A stable vault namespace keeps drafts addressable after token rotation.
	return startLocalEditor(cfg.vaultPath, createEditorCore(editorHost(plugin), vaultHash(cfg.vaultPath)));
}

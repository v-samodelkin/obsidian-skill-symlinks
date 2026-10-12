import * as path from "path";
import type { Group } from "./sync";

interface FolderSettings {
	skillsFolder: string;
	groups: Group[];
}

const movedPath = (value: string, oldPath: string, newPath: string): string =>
	value === oldPath || value.startsWith(oldPath + "/") ? newPath + value.slice(oldPath.length) : value;

// Obsidian emits one rename for a folder, including when it contains the skills root.
export function followFolderRename(settings: FolderSettings, oldPath: string, newPath: string): boolean {
	const oldRoot = settings.skillsFolder;
	const newRoot = movedPath(oldRoot, oldPath, newPath);
	let changed = newRoot !== oldRoot;
	for (const group of settings.groups) {
		const oldGroup = path.posix.join(oldRoot, group.folder);
		const newGroup = movedPath(oldGroup, oldPath, newPath);
		const relative = path.posix.relative(newRoot || ".", newGroup);
		if (relative !== group.folder) {
			group.folder = relative;
			changed = true;
		}
	}
	settings.skillsFolder = newRoot;
	return changed;
}

export function affectsSkillsFolder(folder: string, changedPath: string): boolean {
	return !folder || changedPath === folder || changedPath.startsWith(folder + "/") || folder.startsWith(changedPath + "/");
}

export function affectsConfiguredFolders(settings: FolderSettings, changedPath: string): boolean {
	return affectsSkillsFolder(settings.skillsFolder, changedPath) || settings.groups.some((group) =>
		affectsSkillsFolder(path.posix.join(settings.skillsFolder, group.folder), changedPath),
	);
}

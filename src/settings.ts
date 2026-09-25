import { AbstractInputSuggest, App, Modal, PluginSettingTab, Setting, TFolder, normalizePath } from "obsidian";
import type SkillSymlinksPlugin from "./main";
import { Group, Op, Target, detectTargets, targetExists } from "./sync";

export interface Settings {
	enabled: boolean;
	skillsFolder: string;
	requireSkillMd: boolean;
	targets: Target[];
	groups: Group[];
}

export const DEFAULT_SETTINGS: Settings = {
	enabled: false,
	skillsFolder: "",
	requireSkillMd: true,
	targets: [],
	groups: [{ folder: "", skip: [] }],
};

const folderPath = (value: string) => (value.trim() ? normalizePath(value.trim()) : "");

export class SkillSymlinksSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: SkillSymlinksPlugin,
	) {
		super(app, plugin);
	}

	private get settings() {
		return this.plugin.settings;
	}

	private async save(redraw = false) {
		await this.plugin.saveSettings();
		if (redraw) this.display();
	}

	// Edits are applied when the settings window closes, so half-typed paths never touch the disk.
	hide() {
		this.plugin.sync();
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Sync")
			.setDesc("Keep links to your skills in the agent folders below. You will see the changes before anything is written.")
			.addToggle((toggle) =>
				toggle.setValue(this.settings.enabled).onChange((on) => {
					if (!on) {
						this.settings.enabled = false;
						return void this.save();
					}
					new PreviewModal(this.app, this.plugin.plan(), async () => {
						this.settings.enabled = true;
						await this.save();
						this.plugin.sync();
					}, () => this.display()).open();
				}),
			)
			.addButton((button) => button.setButtonText("Sync now").onClick(() => this.plugin.sync(true)));

		new Setting(containerEl)
			.setName("Skills folder")
			.setDesc("Vault folder that holds your skills. Each subfolder is one skill.")
			.addSearch((search) => {
				new FolderSuggest(this.app, search.inputEl);
				search
					.setPlaceholder("Vault root")
					.setValue(this.settings.skillsFolder)
					.onChange(async (value) => {
						this.settings.skillsFolder = folderPath(value);
						await this.save();
					});
			});

		new Setting(containerEl)
			.setName("Only folders with SKILL.md")
			.setDesc("Skip folders until they contain a SKILL.md file.")
			.addToggle((toggle) =>
				toggle.setValue(this.settings.requireSkillMd).onChange(async (value) => {
					this.settings.requireSkillMd = value;
					await this.save();
				}),
			);

		this.displayTargets(containerEl);
		this.displayGroups(containerEl);
	}

	private displayTargets(containerEl: HTMLElement) {
		new Setting(containerEl)
			.setName("Agent folders")
			.setDesc("Folders that agents read skills from. Missing folders are skipped until they exist.")
			.setHeading();

		for (const target of this.settings.targets) {
			new Setting(containerEl)
				.setName(target.path)
				.setDesc(targetExists(target.path) ? "" : "Not found, skipped.")
				.addToggle((toggle) =>
					toggle.setValue(target.enabled).onChange(async (value) => {
						target.enabled = value;
						await this.save();
					}),
				)
				.addExtraButton((button) =>
					button
						.setIcon("trash")
						.setTooltip("Remove and delete its links")
						.onClick(async () => {
							this.plugin.removeTarget(target);
							this.settings.targets.remove(target);
							this.settings.groups.forEach((g) => g.skip.remove(target.path));
							await this.save(true);
						}),
				);
		}

		const known = new Set(this.settings.targets.map((t) => t.path));
		for (const path of detectTargets().filter((p) => !known.has(p))) {
			new Setting(containerEl)
				.setName(path)
				.setDesc("Found on this device.")
				.addButton((button) => button.setButtonText("Add").onClick(() => this.addTarget(path)));
		}

		let custom = "";
		new Setting(containerEl)
			.setName("Add folder")
			.addText((text) => text.setPlaceholder("~/.my-agent/skills").onChange((value) => (custom = value.trim())))
			.addButton((button) => button.setButtonText("Add").onClick(() => custom && this.addTarget(custom)));
	}

	private async addTarget(path: string) {
		if (!this.settings.targets.some((t) => t.path === path)) this.settings.targets.push({ path, enabled: true });
		await this.save(true);
	}

	private displayGroups(containerEl: HTMLElement) {
		new Setting(containerEl)
			.setName("Groups")
			.setDesc(
				"A group is a folder inside the skills folder whose subfolders are skills. Choose which agent folders each group is linked into.",
			)
			.setHeading();

		for (const group of this.settings.groups) {
			const setting = new Setting(containerEl).setName(group.folder === "" ? "Top level" : "Group folder");
			if (group.folder !== "") {
				setting
					.addText((text) =>
						text.setValue(group.folder).onChange(async (value) => {
							group.folder = folderPath(value);
							await this.save();
						}),
					)
					.addExtraButton((button) =>
						button
							.setIcon("trash")
							.setTooltip("Remove group")
							.onClick(async () => {
								this.settings.groups.remove(group);
								await this.save(true);
							}),
					);
			}
			const list = setting.descEl.createDiv({ cls: "skill-symlinks-targets" });
			for (const target of this.settings.targets) {
				const label = list.createEl("label");
				const checkbox = label.createEl("input", { type: "checkbox" });
				checkbox.checked = !group.skip.includes(target.path);
				checkbox.onchange = async () => {
					if (checkbox.checked) group.skip.remove(target.path);
					else group.skip.push(target.path);
					await this.save();
				};
				label.appendText(target.path);
			}
		}

		new Setting(containerEl).addButton((button) =>
			button.setButtonText("Add group").onClick(async () => {
				this.settings.groups.push({ folder: "new-group", skip: [] });
				await this.save(true);
			}),
		);
	}
}

class PreviewModal extends Modal {
	private confirmed = false;

	constructor(
		app: App,
		private ops: Op[],
		private onConfirm: () => Promise<void>,
		private onCancel: () => void,
	) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		this.titleEl.setText("Turn on sync");
		const sections: [string, Op["kind"]][] = [
			["Links to create", "create"],
			["Links to remove", "remove"],
			["Skipped", "conflict"],
		];
		if (!this.ops.length) contentEl.createEl("p", { text: "Nothing to change right now." });
		for (const [title, kind] of sections) {
			const ops = this.ops.filter((op) => op.kind === kind);
			if (!ops.length) continue;
			contentEl.createEl("h4", { text: `${title} (${ops.length})` });
			const list = contentEl.createEl("ul", { cls: "skill-symlinks-preview" });
			for (const op of ops)
				list.createEl("li", {
					text: op.kind === "create" ? `${op.link} → ${op.source}` : op.kind === "conflict" ? `${op.link}: ${op.reason}` : op.link,
				});
		}
		new Setting(contentEl)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText("Turn on")
					.setCta()
					.onClick(async () => {
						this.confirmed = true;
						this.close();
						await this.onConfirm();
					}),
			);
	}

	onClose() {
		this.contentEl.empty();
		if (!this.confirmed) this.onCancel();
	}
}

class FolderSuggest extends AbstractInputSuggest<TFolder> {
	constructor(
		app: App,
		private inputEl: HTMLInputElement,
	) {
		super(app, inputEl);
	}

	getSuggestions(query: string): TFolder[] {
		const q = query.toLowerCase();
		return this.app.vault
			.getAllLoadedFiles()
			.filter((f): f is TFolder => f instanceof TFolder && !f.isRoot() && f.path.toLowerCase().includes(q));
	}

	renderSuggestion(folder: TFolder, el: HTMLElement) {
		el.setText(folder.path);
	}

	selectSuggestion(folder: TFolder) {
		this.setValue(folder.path);
		this.inputEl.dispatchEvent(new Event("input"));
		this.close();
	}
}

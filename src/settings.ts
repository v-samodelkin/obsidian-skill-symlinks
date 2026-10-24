import { AbstractInputSuggest, App, Modal, PluginSettingTab, Setting, TFolder, normalizePath } from "obsidian";
import type SkillSymlinksPlugin from "./main.ts";
import { unlinkedClaudeConfigs } from "./discover.ts";
import {
	type Routing,
	type Target,
	type TargetKind,
	SHARED_AGENTS_PATH,
	claudeLabel,
	defaultTargets,
	forgetTarget,
	resolveTarget,
	routes,
	setMode,
	setRoute,
	targetFor,
} from "./model.ts";
import { folderKey, literalPath, resolvePath, tildify } from "./paths.ts";
import { effectiveRouting, heldSkills, listSkills } from "./sync.ts";

export type { Settings } from "./data.ts";

const folderPath = (value: string) => (value.trim() ? normalizePath(value.trim()) : "");

const KIND_NAMES: Record<TargetKind, string> = {
	claude: "Claude profile",
	folder: "Skills folder",
};

const MODE_NAMES: Record<Routing["mode"], string> = {
	all: "All folders, including ones added later",
	only: "Only the selected folders",
};

export class SkillSymlinksSettingTab extends PluginSettingTab {
	private plugin: SkillSymlinksPlugin;

	constructor(app: App, plugin: SkillSymlinksPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	private get settings() {
		return this.plugin.settings;
	}

	private get ctx() {
		return this.plugin.ctx;
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
			.setDesc(
				"Keep links to your skills in the agent folders below. Turning sync on shows every change first. Edits below are applied without a preview when you close the settings, so use preview to check them.",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.settings.enabled).onChange((on) => {
					if (!on) {
						this.settings.enabled = false;
						return void this.save();
					}
					this.plugin.preview(() => this.display());
				}),
			)
			.addButton((button) =>
				button
					.setButtonText("Preview")
					.setTooltip("Show what a sync would change without changing anything")
					.onClick(() => this.plugin.preview(() => this.display())),
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
		this.displaySuggestions(containerEl);
		this.displayGroups(containerEl);
		this.displaySkills(containerEl);
	}

	private displayTargets(containerEl: HTMLElement) {
		new Setting(containerEl)
			.setName("Agent folders")
			.setDesc(
				"Where links are created. For a Claude profile, choose its config folder, and links go into its skills subfolder. Paths may start with ~ and use environment variables. Missing folders are skipped until they exist. An agent that reads two linked folders lists each skill twice.",
			)
			.setHeading();

		const { fs, env } = this.ctx;
		const seen: { target: Target; key: string }[] = [];
		for (const target of this.settings.targets) {
			const resolved = resolveTarget(target, env);
			const notes: string[] = [];
			let canCreate = false;
			if (resolved.error !== undefined) notes.push(`Skipped: ${resolved.error}.`);
			else {
				// Folders reached through a symlink count as the same folder and share one set of links.
				const key = folderKey(fs, resolved.path);
				const same = seen.find((s) => s.key === key);
				if (same) notes.push(`Same folder as ${same.target.label}.`);
				seen.push({ target, key });
				if (!fs.isDir(resolved.path)) {
					const config = target.kind === "claude" ? resolvePath(target.path, env).path : undefined;
					canCreate = !!config && fs.isDir(config);
					notes.push(canCreate ? "No skills folder yet." : "Not found, skipped.");
				}
			}
			const where = tildify(resolved.path ?? target.path, env.home);
			const setting = new Setting(containerEl)
				.setName(target.label)
				.setDesc([`${KIND_NAMES[target.kind]}: ${where}`, ...notes].join(" · "));
			if (canCreate)
				setting.addButton((button) =>
					button.setButtonText("Create skills folder").onClick(() => {
						if (this.plugin.createSkillsFolder(target)) this.display();
					}),
				);
			setting
				.addExtraButton((button) =>
					button
						.setIcon("pencil")
						.setTooltip("Edit")
						.onClick(() =>
							new TargetModal(this.app, target, async (edited) => {
								Object.assign(target, edited);
								await this.save(true);
							}).open(),
						),
				)
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
							this.removeTarget(target);
							await this.save(true);
						}),
				);
		}

		new Setting(containerEl).addButton((button) =>
			button.setButtonText("Add folder").onClick(() =>
				new TargetModal(this.app, null, async (added) => {
					this.addTarget(added.path, added.kind, added.label);
					await this.save(true);
				}).open(),
			),
		);
	}

	private removeTarget(target: Target) {
		this.settings.targets.remove(target);
		this.settings.groups.forEach((g) => (g.routing = forgetTarget(g.routing, target.id)));
		for (const [key, routing] of Object.entries(this.settings.skillRouting))
			this.settings.skillRouting[key] = forgetTarget(routing, target.id);
	}

	private addTarget(path: string, kind: TargetKind, label?: string) {
		const target = targetFor(path, kind, this.settings.targets.map((t) => t.id));
		if (label?.trim()) target.label = label.trim();
		this.settings.targets.push(target);
	}

	// Folders found on this computer that are not in the list. Nothing is added until the user asks.
	private displaySuggestions(containerEl: HTMLElement) {
		const { fs, env } = this.ctx;
		// A found folder is stored as a literal path, so a "$" in its name is not read as a variable.
		const suggestions: (Pick<Target, "label" | "path" | "kind"> & { where: string })[] = unlinkedClaudeConfigs(
			this.ctx,
			this.settings.targets,
		).map((dir) => ({ label: claudeLabel(dir), path: literalPath(tildify(dir, env.home)), where: tildify(dir, env.home), kind: "claude" }));
		const shared = defaultTargets().find((t) => t.path === SHARED_AGENTS_PATH)!;
		const sharedDir = resolveTarget(shared, env).path;
		const listed = new Set(this.settings.targets.flatMap((t) => resolveTarget(t, env).path ?? []).map((p) => folderKey(fs, p)));
		if (sharedDir && fs.isDir(sharedDir) && !listed.has(folderKey(fs, sharedDir)))
			suggestions.push({ label: shared.label, path: shared.path, where: shared.path, kind: "folder" });
		const hidden = this.settings.hiddenSuggestions;
		const shown = suggestions.filter((s) => !hidden.includes(s.path));
		if (!shown.length && !hidden.length) return;

		const heading = new Setting(containerEl)
			.setName("Suggested folders")
			.setDesc(
				"Found on this computer but not in the list above. Nothing is added unless you add it. An added folder gets every group set to all folders when you close the settings.",
			)
			.setHeading();
		if (hidden.length)
			heading.addExtraButton((button) =>
				button
					.setIcon("eye")
					.setTooltip(`Show ${hidden.length} dismissed`)
					.onClick(async () => {
						this.settings.hiddenSuggestions = [];
						await this.save(true);
					}),
			);
		for (const suggestion of shown)
			new Setting(containerEl)
				.setName(suggestion.label)
				.setDesc(`${KIND_NAMES[suggestion.kind]}: ${suggestion.where}`)
				.addButton((button) =>
					button.setButtonText("Add").onClick(async () => {
						this.addTarget(suggestion.path, suggestion.kind, suggestion.label);
						await this.save(true);
					}),
				)
				.addExtraButton((button) =>
					button
						.setIcon("x")
						.setTooltip("Dismiss")
						.onClick(async () => {
							hidden.push(suggestion.path);
							await this.save(true);
						}),
				);
	}

	private displayGroups(containerEl: HTMLElement) {
		new Setting(containerEl)
			.setName("Groups")
			.setDesc(
				"A group is a folder inside the skills folder whose subfolders are skills; the top level is the skills folder itself. Choose which agent folders get each group's skills.",
			)
			.setHeading();

		for (const group of this.settings.groups) {
			const setting = new Setting(containerEl).setName(group.folder === "" ? "Top level" : "Group folder");
			if (group.folder !== "")
				setting.addText((text) =>
					text.setValue(group.folder).onChange(async (value) => {
						group.folder = folderPath(value);
						await this.save();
					}),
				);
			setting.addDropdown((dropdown) =>
				dropdown
					.addOptions(MODE_NAMES)
					.setValue(group.routing.mode)
					.onChange(async (mode) => {
						group.routing = setMode(group.routing, mode as Routing["mode"], this.targetIds());
						await this.save(true);
					}),
			);
			if (group.folder !== "")
				setting.addExtraButton((button) =>
					button
						.setIcon("trash")
						.setTooltip("Remove group")
						.onClick(async () => {
							this.settings.groups.remove(group);
							await this.save(true);
						}),
				);
			this.targetCheckboxes(setting.descEl, group.routing, (routing) => (group.routing = routing));
		}

		new Setting(containerEl).addButton((button) =>
			button.setButtonText("Add group").onClick(async () => {
				this.settings.groups.push({ folder: "new-group", routing: { mode: "all", except: [] } });
				await this.save(true);
			}),
		);
	}

	private displaySkills(containerEl: HTMLElement) {
		const cfg = this.plugin.config();
		const skills = cfg ? listSkills(cfg, this.ctx.fs) : [];
		const overrides = this.settings.skillRouting;
		const missing = Object.keys(overrides).filter((key) => !skills.some((s) => s.key === key));
		const held = heldSkills(this.settings, skills);
		if (!skills.length && !missing.length) return;

		new Setting(containerEl)
			.setName("Skills")
			.setDesc(
				"Each skill goes where its group goes. Choose custom to pick the folders for one skill. To keep skills out of a folder for good, turn that folder off or use a group set to only the selected folders: a custom choice follows renames made in Obsidian, not those made elsewhere.",
			)
			.setHeading();

		for (const skill of skills) {
			const custom = overrides[skill.key];
			const setting = new Setting(containerEl)
				.setName(skill.name)
				.setDesc(skill.key)
				.addDropdown((dropdown) =>
					dropdown
						.addOptions({ group: "Same as its group", custom: "Custom" })
						.setValue(custom ? "custom" : "group")
						.onChange(async (value) => {
							if (value === "custom") {
								// Start from where the skill goes now; later targets are not added to it.
								const now = effectiveRouting(this.settings, skill);
								overrides[skill.key] = { mode: "only", only: this.targetIds().filter((id) => routes(now, id)) };
							} else delete overrides[skill.key];
							await this.save(true);
						}),
				);
			if (custom) this.targetCheckboxes(setting.descEl, custom, (routing) => (overrides[skill.key] = routing));
		}

		for (const key of missing) {
			const waiting = skills.filter((s) => held.get(s.key) === key);
			const setting = new Setting(containerEl).setName(key).setDesc(
				[
					"Custom folders for a skill that is not found. They apply again if it comes back.",
					...(waiting.length ? [`New skills next to it are not linked until you choose: ${waiting.map((s) => s.name).join(", ")}.`] : []),
				].join(" "),
			);
			// A skill renamed outside Obsidian shows up as a new skill: hand it the choice.
			for (const skill of waiting)
				setting.addButton((button) =>
					button.setButtonText(`Use for ${skill.name}`).onClick(async () => {
						overrides[skill.key] = overrides[key];
						delete overrides[key];
						await this.save(true);
					}),
				);
			setting.addExtraButton((button) =>
				button
					.setIcon("trash")
					.setTooltip("Forget")
					.onClick(async () => {
						delete overrides[key];
						await this.save(true);
					}),
			);
		}
	}

	private targetIds(): string[] {
		return this.settings.targets.map((t) => t.id);
	}

	private targetCheckboxes(el: HTMLElement, routing: Routing, update: (routing: Routing) => void) {
		const list = el.createDiv({ cls: "skill-symlinks-targets" });
		let current = routing;
		for (const target of this.settings.targets) {
			const label = list.createEl("label", { cls: target.enabled ? undefined : "skill-symlinks-off" });
			const checkbox = label.createEl("input", { type: "checkbox" });
			checkbox.checked = routes(current, target.id);
			checkbox.onchange = async () => {
				current = setRoute(current, target.id, checkbox.checked);
				update(current);
				await this.save();
			};
			label.appendText(target.enabled ? target.label : `${target.label} (off)`);
		}
	}
}

/** Adds a target, or edits one; the id never changes so routing keeps working. */
class TargetModal extends Modal {
	private kind: TargetKind;
	private path: string;
	private label: string;
	private target: Target | null;
	private onSave: (target: Pick<Target, "kind" | "path" | "label">) => Promise<void>;

	constructor(app: App, target: Target | null, onSave: (target: Pick<Target, "kind" | "path" | "label">) => Promise<void>) {
		super(app);
		this.target = target;
		this.onSave = onSave;
		this.kind = target?.kind ?? "claude";
		this.path = target?.path ?? "";
		this.label = target?.label ?? "";
	}

	onOpen() {
		this.titleEl.setText(this.target ? "Edit folder" : "Add folder");
		this.render();
	}

	private render() {
		const { contentEl } = this;
		contentEl.empty();
		new Setting(contentEl)
			.setName("Type")
			.setDesc(
				this.kind === "claude"
					? "The folder Claude Code keeps its settings in: ~/.claude, or the folder set with CLAUDE_CONFIG_DIR. Links go into its skills subfolder."
					: "A folder an agent reads skills from directly.",
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOptions(KIND_NAMES)
					.setValue(this.kind)
					.onChange((value) => {
						this.kind = value as TargetKind;
						this.render();
					}),
			);
		new Setting(contentEl)
			.setName("Folder")
			.setDesc("May start with ~ and use environment variables that Obsidian can see. Write $$ for a $ that is part of a folder name.")
			.addText((text) =>
				text
					.setPlaceholder(this.kind === "claude" ? "~/.claude-work" : "~/.my-agent/skills")
					.setValue(this.path)
					.onChange((value) => (this.path = value.trim())),
			);
		new Setting(contentEl)
			.setName("Name")
			.setDesc("Shown in settings and notices.")
			.addText((text) =>
				text
					.setPlaceholder(this.kind === "claude" ? claudeLabel(this.path || "~/.claude") : this.path || "My agent")
					.setValue(this.label)
					.onChange((value) => (this.label = value.trim())),
			);
		new Setting(contentEl)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText(this.target ? "Save" : "Add")
					.setCta()
					.onClick(async () => {
						if (!this.path) return;
						// Normalise the path and default name the same way as targets added from suggestions.
						const shaped = targetFor(this.path, this.kind, []);
						this.close();
						await this.onSave({ kind: shaped.kind, path: shaped.path, label: this.label || shaped.label });
					}),
			);
	}

	onClose() {
		this.contentEl.empty();
	}
}

class FolderSuggest extends AbstractInputSuggest<TFolder> {
	private inputEl: HTMLInputElement;

	constructor(app: App, inputEl: HTMLInputElement) {
		super(app, inputEl);
		this.inputEl = inputEl;
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

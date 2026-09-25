import { FileSystemAdapter, Notice, Plugin, TAbstractFile, debounce } from "obsidian";
import { DEFAULT_SETTINGS, Settings, SkillSymlinksSettingTab } from "./settings";
import { DEFAULT_TARGETS, Op, SyncConfig, Target, apply, plan, planRemoval } from "./sync";

export default class SkillSymlinksPlugin extends Plugin {
	settings: Settings = DEFAULT_SETTINGS;
	private reportedConflicts = new Set<string>();
	requestSync = debounce(() => this.sync(), 500, true);

	async onload() {
		const data = (await this.loadData()) as Partial<Settings> | null;
		this.settings = { ...structuredClone(DEFAULT_SETTINGS), ...data };
		// Nothing is linked until sync is turned on; a missing folder is skipped until it exists.
		if (!data) this.settings.targets = DEFAULT_TARGETS.map((path) => ({ path, enabled: true }));

		this.addSettingTab(new SkillSymlinksSettingTab(this.app, this));
		this.addCommand({ id: "sync-now", name: "Sync now", callback: () => this.sync(true) });
		this.addCommand({
			id: "remove-links",
			name: "Remove all links created by this plugin",
			callback: () => this.removeLinks(),
		});

		const onChange = (file: TAbstractFile, oldPath?: string) => {
			if (this.inSkillsFolder(file.path) || (oldPath && this.inSkillsFolder(oldPath))) this.requestSync();
		};
		this.app.workspace.onLayoutReady(() => {
			this.sync();
			this.registerEvent(this.app.vault.on("create", onChange));
			this.registerEvent(this.app.vault.on("delete", onChange));
			this.registerEvent(this.app.vault.on("rename", onChange));
		});
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	config(): SyncConfig | null {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) return null;
		return { vaultPath: adapter.getBasePath(), ...this.settings };
	}

	plan(): Op[] {
		const cfg = this.config();
		return cfg ? plan(cfg) : [];
	}

	sync(verbose = false) {
		if (!this.settings.enabled) {
			if (verbose) new Notice("Sync is off. Turn it on in the plugin settings.");
			return;
		}
		this.run(this.plan(), verbose);
	}

	removeTarget(target: Target) {
		const cfg = this.config();
		if (cfg && this.settings.enabled) this.run(planRemoval(cfg, [target]), false);
	}

	private removeLinks() {
		const cfg = this.config();
		if (!cfg) return;
		this.settings.enabled = false;
		void this.saveSettings();
		this.run(planRemoval(cfg), true);
	}

	private run(ops: Op[], verbose: boolean) {
		const { done, failed } = apply(ops);
		const conflicts = ops.filter((op) => op.kind === "conflict");
		const fresh = verbose ? conflicts : conflicts.filter((op) => !this.reportedConflicts.has(op.link));
		fresh.forEach((op) => this.reportedConflicts.add(op.link));
		const lines = [
			...done.map((op) => (op.kind === "create" ? `+ ${op.link}` : `− ${op.link}`)),
			...fresh.map((op) => `skipped ${op.link}: ${op.kind === "conflict" ? op.reason : ""}`),
			...failed.map(({ op, error }) => `failed ${op.link}: ${error}`),
		];
		if (lines.length || verbose) new Notice(`Skill Symlinks\n${lines.join("\n") || "Everything is in sync."}`);
	}

	private inSkillsFolder(path: string): boolean {
		const folder = this.settings.skillsFolder;
		return !folder || path === folder || path.startsWith(folder + "/");
	}
}

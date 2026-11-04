import { FileSystemAdapter, Notice, Plugin, TAbstractFile, TFolder, debounce } from "obsidian";
import { openEditor } from "./editor/obsidian.ts";
import { readPreference, setLocalEditorEnabled } from "./editor/local.ts";
import { type Settings, defaultSettings, loadSettings, toData } from "./data.ts";
import { type Target, resolveTarget } from "./model.ts";
import { PreviewModal } from "./preview.ts";
import { affectsConfiguredFolders, followFolderRename } from "./rename.ts";
import { countSummary, noticeLines, previewSections } from "./report.ts";
import { SkillSymlinksSettingTab } from "./settings.ts";
import { type Context, type Op, type SyncConfig, apply, collectManagedLinks, nodeContext, plan, planRemoval } from "./sync.ts";

export default class SkillSymlinksPlugin extends Plugin {
	settings: Settings = defaultSettings();
	ctx: Context = nodeContext();
	editorPaths = new Set<string>();
	private editor: Awaited<ReturnType<typeof openEditor>> = null;
	private saving: Promise<void> = Promise.resolve();
	private settingTab: SkillSymlinksSettingTab | null = null;
	private editorBusy = 0;
	private deferredSync = false;
	private deferredVerbose = false;
	private deferredRemoval = false;
	private editorGeneration = 0;
	private reportedConflicts = new Set<string>();
	requestSync = debounce(() => this.sync(), 500, true);

	async onload() {
		// Settings from 1.0.x are converted in memory and written in the current format only with the
		// first change or sync record, so a device still on 1.0.x is not handed data it cannot read.
		this.settings = loadSettings(await this.loadData()).settings;

		this.settingTab = new SkillSymlinksSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);
		this.addCommand({ id: "sync-now", name: "Sync now", callback: () => this.sync(true) });
		this.addCommand({ id: "preview", name: "Preview changes", callback: () => this.preview() });
		this.addCommand({
			id: "remove-links",
			name: "Remove all links created by this plugin",
			callback: () => this.removeLinks(),
		});

		const onChange = (file: TAbstractFile, oldPath?: string) => {
			if (this.editorPaths.has(file.path) || (oldPath && this.editorPaths.has(oldPath))) return;
			if (oldPath && file instanceof TFolder && followFolderRename(this.settings, oldPath, file.path)) {
				void this.saveSettings();
				this.requestSync();
				return;
			}
			if (this.inSkillsFolder(file.path) || (oldPath && this.inSkillsFolder(oldPath))) this.requestSync();
		};
		this.app.workspace.onLayoutReady(() => {
			this.sync();
			void this.reloadEditor();
			this.registerEvent(this.app.vault.on("create", onChange));
			this.registerEvent(this.app.vault.on("delete", onChange));
			this.registerEvent(this.app.vault.on("rename", onChange));
		});
	}

	async saveSettings() {
		const snapshot = JSON.parse(JSON.stringify(toData(this.settings))) as Record<string, unknown>;
		const next = this.saving.catch(() => undefined).then(() => this.saveData(snapshot));
		this.saving = next;
		await next;
	}

	onunload() { this.editorGeneration++; this.editor?.close(); this.editor = null; }

	settingsChanged() { this.settingTab?.refresh(); }

	async editorOperation<T>(work: () => Promise<T>): Promise<T> {
		this.editorBusy++;
		try { return await work(); }
		finally {
			this.editorBusy--;
			if (!this.editorBusy) {
				try {
					if (this.deferredRemoval) { this.deferredRemoval = false; this.removeLinks(); }
					if (this.deferredSync) { const verbose = this.deferredVerbose; this.deferredSync = this.deferredVerbose = false; this.sync(verbose); }
				} catch { new Notice("Sync could not complete. Check the plugin preview in Obsidian."); }
			}
		}
	}

	localEditorEnabled(): boolean {
		const cfg = this.config();
		return !!cfg && !!readPreference(cfg.vaultPath)?.enabled;
	}

	async setLocalEditor(on: boolean) {
		const cfg = this.config();
		if (!cfg) return;
		this.editor?.close(); this.editor = null;
		setLocalEditorEnabled(cfg.vaultPath, on);
		await this.reloadEditor();
	}

	private async reloadEditor() {
		const generation = ++this.editorGeneration;
		try { this.editor?.close(); this.editor = null; const editor = await openEditor(this); if (generation !== this.editorGeneration) editor?.close(); else this.editor = editor; }
		catch { new Notice("Local editor could not start. Check this machine's local editor configuration."); }
	}

	config(): SyncConfig | null {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) return null;
		return { ...this.settings, vaultPath: adapter.getBasePath(), configDir: this.app.vault.configDir };
	}

	plan(): Op[] {
		const cfg = this.config();
		return cfg ? plan(cfg, this.ctx) : [];
	}

	/** Shows what a sync would change. Confirming applies it, turning sync on first when it is off. */
	preview(onCancel?: () => void) {
		const cfg = this.config();
		if (!cfg) return;
		const ops = plan(cfg, this.ctx);
		const enabling = !this.settings.enabled;
		new PreviewModal(this.app, {
			title: enabling ? "Turn on sync" : "Preview changes",
			summary: countSummary(ops),
			sections: previewSections(ops, this.settings.targets, cfg.vaultPath, this.ctx.env.home),
			confirmText: enabling ? "Turn on" : ops.some((op) => op.kind !== "conflict") ? "Apply" : undefined,
			onConfirm: async () => {
				if (enabling) {
					this.settings.enabled = true;
					await this.saveSettings();
				}
				this.sync(true);
			},
			onCancel,
		}).open();
	}

	sync(verbose = false) {
		if (this.editorBusy) { this.deferredSync = true; this.deferredVerbose ||= verbose; return; }
		if (!this.settings.enabled) {
			if (verbose) new Notice("Sync is off. Turn it on in the plugin settings.");
			return;
		}
		this.run(this.plan(), verbose);
	}

	removeTarget(target: Target) {
		if (this.editorBusy) { this.deferredSync = true; return; }
		const cfg = this.config();
		if (cfg && this.settings.enabled) this.run(planRemoval(cfg, this.ctx, [target.id]), false);
	}

	/** Creates the skills folder inside an existing Claude Code config folder. */
	createSkillsFolder(target: Target): boolean {
		const resolved = resolveTarget(target, this.ctx.env);
		if (resolved.error !== undefined) return false;
		try {
			this.ctx.fs.mkdir(resolved.path);
			return true;
		} catch (e) {
			new Notice(`Skill Symlinks\nCould not create ${resolved.path}: ${e instanceof Error ? e.message : String(e)}`);
			return false;
		}
	}

	private removeLinks() {
		if (this.editorBusy) { this.deferredRemoval = true; return; }
		const cfg = this.config();
		if (!cfg) return;
		this.settings.enabled = false;
		void this.saveSettings();
		this.run(planRemoval(cfg, this.ctx), true);
	}

	private run(ops: Op[], verbose: boolean) {
		const { done, failed } = apply(ops, this.ctx.fs);
		const cfg = this.config();
		if (cfg) {
			const managed = collectManagedLinks(cfg, this.ctx);
			if (JSON.stringify(managed) !== JSON.stringify(this.settings.managedLinks)) {
				this.settings.managedLinks = managed;
				void this.saveSettings();
			}
		}
		const conflicts = ops.filter((op) => op.kind === "conflict");
		const fresh = verbose ? conflicts : conflicts.filter((op) => !this.reportedConflicts.has(op.link));
		fresh.forEach((op) => this.reportedConflicts.add(op.link));
		const lines = noticeLines(done, fresh, failed, this.settings.targets, this.ctx.env.home);
		// Problems stay on screen longer than a plain summary.
		if (lines.length || verbose)
			new Notice(`Skill Symlinks\n${lines.join("\n") || "Everything is in sync."}`, fresh.length || failed.length ? 15000 : undefined);
	}

	private inSkillsFolder(path: string): boolean {
		return affectsConfiguredFolders(this.settings, path);
	}
}

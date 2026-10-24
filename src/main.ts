import { FileSystemAdapter, Notice, Plugin, TAbstractFile, TFolder, debounce } from "obsidian";
import { type Settings, defaultSettings, loadSettings } from "./data.ts";
import { type Target, resolveTarget } from "./model.ts";
import { PreviewModal } from "./preview.ts";
import { affectsConfiguredFolders, followFolderRename } from "./rename.ts";
import { countSummary, noticeLines, previewSections } from "./report.ts";
import { SkillSymlinksSettingTab } from "./settings.ts";
import { type Context, type Op, type SyncConfig, apply, collectManagedLinks, nodeContext, plan, planRemoval } from "./sync.ts";

export default class SkillSymlinksPlugin extends Plugin {
	settings: Settings = defaultSettings();
	ctx: Context = nodeContext();
	private reportedConflicts = new Set<string>();
	requestSync = debounce(() => this.sync(), 500, true);

	async onload() {
		const { settings, changed } = loadSettings(await this.loadData());
		this.settings = settings;
		// Settings from 1.0.x are rewritten in the current format once; nothing on disk changes.
		if (changed) await this.saveSettings();

		this.addSettingTab(new SkillSymlinksSettingTab(this.app, this));
		this.addCommand({ id: "sync-now", name: "Sync now", callback: () => this.sync(true) });
		this.addCommand({ id: "preview", name: "Preview changes", callback: () => this.preview() });
		this.addCommand({
			id: "remove-links",
			name: "Remove all links created by this plugin",
			callback: () => this.removeLinks(),
		});

		const onChange = (file: TAbstractFile, oldPath?: string) => {
			if (oldPath && file instanceof TFolder && followFolderRename(this.settings, oldPath, file.path)) {
				void this.saveSettings();
				this.requestSync();
				return;
			}
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
		if (!this.settings.enabled) {
			if (verbose) new Notice("Sync is off. Turn it on in the plugin settings.");
			return;
		}
		this.run(this.plan(), verbose);
	}

	removeTarget(target: Target) {
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

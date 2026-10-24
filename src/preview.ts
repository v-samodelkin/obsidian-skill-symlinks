import { App, Modal, Setting } from "obsidian";
import type { Section } from "./report.ts";

export interface PreviewOptions {
	title: string;
	summary: string; // "" when nothing would change
	sections: Section[];
	confirmText?: string; // without it the modal only has a close button
	onConfirm?: () => Promise<void> | void;
	onCancel?: () => void;
}

/** Shows planned link changes, grouped by target, before anything is written. */
export class PreviewModal extends Modal {
	private confirmed = false;
	private options: PreviewOptions;

	constructor(app: App, options: PreviewOptions) {
		super(app);
		this.options = options;
	}

	onOpen() {
		const { contentEl } = this;
		const { title, summary, sections, confirmText, onConfirm } = this.options;
		this.titleEl.setText(title);
		contentEl.createEl("p", { text: summary ? `${summary}.` : "Nothing to change right now." });
		for (const section of sections) {
			if (!section.lines.length) continue;
			contentEl.createEl("h4", { text: section.title });
			const list = contentEl.createEl("ul", { cls: "skill-symlinks-preview" });
			for (const line of section.lines) list.createEl("li", { text: line });
		}
		const buttons = new Setting(contentEl).addButton((button) =>
			button.setButtonText(confirmText ? "Cancel" : "Close").onClick(() => this.close()),
		);
		if (confirmText && onConfirm)
			buttons.addButton((button) =>
				button
					.setButtonText(confirmText)
					.setCta()
					.onClick(async () => {
						this.confirmed = true;
						this.close();
						await onConfirm();
					}),
			);
	}

	onClose() {
		this.contentEl.empty();
		if (!this.confirmed) this.options.onCancel?.();
	}
}

// Drives the settings tab of the bundled plugin with a minimal stand-in for Obsidian's Setting API.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { buildSync } from "esbuild";
import type { Settings } from "../src/data.ts";
import type { Context, Op } from "../src/sync.ts";

const require = createRequire(import.meta.url);
const bundle = buildSync({
	entryPoints: ["src/main.ts"], bundle: true, platform: "node", format: "cjs",
	external: ["obsidian"], write: false,
}).outputFiles[0].text;
// Obsidian adds Array.prototype.remove; the bundle runs in its own realm.
const prelude = "Array.prototype.remove = function (x) { const i = this.indexOf(x); if (i >= 0) this.splice(i, 1); };\n";

interface El {
	text: string;
	checked: boolean;
	children: El[];
	onchange: null | (() => unknown);
	empty(): void;
	createDiv(options?: object): El;
	createEl(tag: string, options?: { text?: string }): El;
	appendText(text: string): void;
	setText(text: string): void;
}

const el = (onEmpty?: () => void): El => {
	const add = (options?: { text?: string }) => {
		const child = el();
		child.text = options?.text ?? "";
		node.children.push(child);
		return child;
	};
	const node: El = {
		text: "", checked: false, children: [], onchange: null,
		empty() { node.children.length = 0; onEmpty?.(); },
		createDiv: add,
		createEl: (_tag, options) => add(options),
		appendText(text) { node.text += text; },
		setText(text) { node.text = text; },
	};
	return node;
};

interface Control {
	text?: string;
	icon?: string;
	value?: unknown;
	change?: (value: unknown) => unknown;
	click?: () => unknown;
}

interface Row {
	name: string;
	desc: string;
	heading: boolean;
	controls: Control[];
	descEl: El;
}

async function openSettings(vault: string, home: string, data: object) {
	let saved = JSON.parse(JSON.stringify(data)) as Settings;
	let rows: Row[] = [];
	const control = (row: Row) => {
		const c: Control & Record<string, unknown> = {
			inputEl: el(),
			setValue(v: unknown) { c.value = v; return c; },
			onChange(f: (value: unknown) => unknown) { c.change = f; return c; },
			onClick(f: () => unknown) { c.click = f; return c; },
			setButtonText(t: string) { c.text = t; return c; },
			setIcon(i: string) { c.icon = i; return c; },
			setTooltip() { return c; },
			setCta() { return c; },
			setPlaceholder() { return c; },
			addOptions() { return c; },
		};
		row.controls.push(c);
		return c;
	};
	class Setting {
		row: Row;
		descEl = el();
		constructor() {
			this.row = { name: "", desc: "", heading: false, controls: [], descEl: this.descEl };
			rows.push(this.row);
		}
		setName(name: string) { this.row.name = name; return this; }
		setDesc(desc: string) { this.row.desc = desc; return this; }
		setHeading() { this.row.heading = true; return this; }
		addToggle(cb: (c: unknown) => void) { cb(control(this.row)); return this; }
		addButton(cb: (c: unknown) => void) { cb(control(this.row)); return this; }
		addExtraButton(cb: (c: unknown) => void) { cb(control(this.row)); return this; }
		addSearch(cb: (c: unknown) => void) { cb(control(this.row)); return this; }
		addText(cb: (c: unknown) => void) { cb(control(this.row)); return this; }
		addDropdown(cb: (c: unknown) => void) { cb(control(this.row)); return this; }
	}
	let tab: { display(): void; hide(): void } | undefined;
	class Adapter {
		getBasePath() { return vault; }
	}
	class HostPlugin {
		app = { vault: { adapter: new Adapter(), on: () => undefined }, workspace: { onLayoutReady: (fn: () => void) => fn() } };
		loadData() { return Promise.resolve(saved); }
		saveData(value: Settings) { saved = JSON.parse(JSON.stringify(value)) as Settings; return Promise.resolve(); }
		addSettingTab(value: typeof tab) { tab = value; }
		addCommand() {}
		registerEvent() {}
	}
	class PluginSettingTab {
		containerEl = el(() => (rows = []));
	}
	const host = {
		Plugin: HostPlugin, FileSystemAdapter: Adapter, TFolder: class {}, Setting, PluginSettingTab,
		Notice: class {}, Modal: class {}, AbstractInputSuggest: class {},
		debounce: (fn: () => void) => fn, normalizePath: (p: string) => p,
	};
	const module = { exports: {} as { default: new () => { onload(): Promise<void>; ctx: Context; plan(): Op[] } } };
	runInNewContext(prelude + bundle, {
		module, exports: module.exports, structuredClone, process,
		require: (name: string) => name === "obsidian" ? host : require(name) as unknown,
	});
	const plugin = new module.exports.default();
	await plugin.onload();
	// Never look at the real home folder or environment.
	plugin.ctx = { fs: plugin.ctx.fs, env: { home, vars: {} } };
	tab!.display();
	const row = (name: string) => {
		const found = rows.find((r) => r.name === name);
		assert.ok(found, `no setting named ${name}; have ${rows.map((r) => r.name).join(", ")}`);
		return found;
	};
	const button = (name: string, label: string) => {
		const found = row(name).controls.find((c) => c.text === label || c.icon === label);
		assert.ok(found?.click, `no ${label} on ${name}`);
		return found.click;
	};
	return { plugin, data: () => saved, rows: () => rows, row, button };
}

test("settings add a suggested profile, create its skills folder and route one skill to it", async () => {
	const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "skill-symlinks-settings-")));
	const vault = path.join(tmp, "vault");
	const home = path.join(tmp, "home");
	fs.mkdirSync(path.join(vault, "skills/example"), { recursive: true });
	fs.writeFileSync(path.join(vault, "skills/example/SKILL.md"), "");
	fs.mkdirSync(path.join(home, ".claude/projects"), { recursive: true });
	fs.mkdirSync(path.join(home, ".claude/skills"));
	for (const profile of [".claude-work", ".claude-old"]) {
		fs.mkdirSync(path.join(home, profile));
		fs.writeFileSync(path.join(home, profile, ".claude.json"), "{}");
	}
	// Sync stays off, so nothing is linked while the settings are edited.
	const ui = await openSettings(vault, home, {
		version: 2, enabled: false, skillsFolder: "skills", requireSkillMd: true,
		targets: [{ id: "claude", label: "Claude Code", kind: "claude", path: "~/.claude", enabled: true }],
		groups: [{ folder: "", routing: { mode: "all", except: [] } }],
	});

	assert.match(ui.row("Claude Code").desc, /^Claude profile: ~[\\/]\.claude[\\/]skills$/);
	assert.ok(ui.row("Suggested folders").heading);
	await ui.button("Claude Code (work)", "Add")();
	assert.deepEqual(ui.data().targets.at(-1), {
		id: "claude-work", label: "Claude Code (work)", kind: "claude", path: path.join("~", ".claude-work"), enabled: true,
	});
	assert.match(ui.row("Claude Code (work)").desc, /No skills folder yet/);
	ui.button("Claude Code (work)", "Create skills folder")();
	assert.ok(fs.statSync(path.join(home, ".claude-work/skills")).isDirectory());

	await ui.button("Claude Code (old)", "x")();
	assert.deepEqual(ui.data().hiddenSuggestions, [path.join("~", ".claude-old")]);
	assert.equal(ui.rows().some((r) => r.name === "Claude Code (old)"), false);

	const dropdown = ui.row("example").controls[0];
	assert.equal(dropdown.value, "group");
	await dropdown.change!("custom");
	assert.deepEqual(ui.data().skillRouting, { "skills/example": { mode: "only", only: ["claude", "claude-work"] } });
	const [claude] = ui.row("example").descEl.children[0].children;
	assert.equal(claude.text, "Claude Code");
	claude.children[0].checked = false;
	await claude.children[0].onchange!();
	assert.deepEqual(ui.data().skillRouting["skills/example"], { mode: "only", only: ["claude-work"] });
	// The plan comes from the bundle's realm; compare plain copies.
	assert.deepEqual(
		JSON.parse(JSON.stringify(ui.plugin.plan().map((op) => [op.kind, op.link]))),
		[["create", path.join(home, ".claude-work/skills/example")]],
	);

	await ui.button("Claude Code (work)", "trash")();
	assert.deepEqual(ui.data().targets.map((t) => t.id), ["claude"]);
	assert.deepEqual(ui.data().skillRouting["skills/example"], { mode: "only", only: [] });
	assert.ok(ui.rows().some((r) => r.name === "Claude Code (work)" && r.controls.some((c) => c.text === "Add")));
});

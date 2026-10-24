// Human-readable summaries of planned and applied link changes, grouped by target.
import * as path from "path";
import type { Target } from "./model.ts";
import { tildify, toPosix } from "./paths.ts";
import type { Op } from "./sync.ts";

export interface Section {
	title: string;
	lines: string[];
}

interface Place {
	label: string; // short name for notices
	title: string; // name and folder for the preview
	created: Op[];
	removed: Op[];
}

function byPlace(ops: Op[], targets: Target[], home: string): Place[] {
	const places = new Map<string, Place>();
	for (const op of ops) {
		if (op.kind === "conflict") continue;
		const dir = tildify(path.dirname(op.link), home);
		const target = op.target === null ? undefined : targets.find((t) => t.id === op.target);
		const key = `${target?.id ?? ""}\0${dir}`;
		const place = places.get(key) ?? {
			label: target?.label ?? dir,
			title: target ? `${target.label}: ${dir}` : `${dir} (no longer in the list)`,
			created: [],
			removed: [],
		};
		(op.kind === "create" ? place.created : place.removed).push(op);
		places.set(key, place);
	}
	return [...places.values()];
}

const names = (ops: Op[]) => ops.map((op) => op.name).join(", ");

/** Sections for the preview: one per target, then everything that will be skipped. */
export function previewSections(ops: Op[], targets: Target[], vaultPath: string, home: string): Section[] {
	const sections = byPlace(ops, targets, home).map((place) => ({
		title: place.title,
		lines: [
			...place.created.map((op) => `+ ${op.name} → ${op.kind === "create" ? toPosix(path.relative(vaultPath, op.source)) : ""}`),
			...place.removed.map((op) => `− ${op.name}`),
		],
	}));
	const skipped = ops.filter((op) => op.kind === "conflict");
	if (skipped.length)
		sections.push({
			title: "Skipped",
			lines: skipped.map((op) => `${tildify(op.link, home)}: ${op.kind === "conflict" ? op.reason : ""}`),
		});
	return sections;
}

/** Short lines for a notice after applying changes. */
export function noticeLines(
	done: Op[],
	skipped: Op[],
	failed: { op: Op; error: string }[],
	targets: Target[],
	home: string,
): string[] {
	return [
		...byPlace(done, targets, home).map((place) => {
			const parts: string[] = [];
			if (place.created.length) parts.push(`linked ${names(place.created)}`);
			if (place.removed.length) parts.push(`unlinked ${names(place.removed)}`);
			return `${place.label}: ${parts.join("; ")}`;
		}),
		...skipped.map((op) => `Skipped ${tildify(op.link, home)}: ${op.kind === "conflict" ? op.reason : ""}`),
		...failed.map(({ op, error }) => `Could not ${op.kind === "remove" ? "remove" : "create"} ${tildify(op.link, home)}: ${error}`),
	];
}

/** "2 to link, 1 to unlink, 1 skipped", or "" when nothing would change. */
export function countSummary(ops: Op[]): string {
	const count = (kind: Op["kind"]) => ops.filter((op) => op.kind === kind).length;
	return [
		[count("create"), "to link"],
		[count("remove"), "to unlink"],
		[count("conflict"), "skipped"],
	]
		.filter(([n]) => n)
		.map(([n, what]) => `${n} ${what}`)
		.join(", ");
}

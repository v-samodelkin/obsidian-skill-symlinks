import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout, clearTimeout } from "node:timers";
import type { createEditorCore } from "./core.ts";
import { inside } from "../paths.ts";
import { parseEditorCommand, type EditorCommand } from "./protocol.ts";

export interface LocalEditorPreference { schema: 1; vaultHash: string; enabled: boolean; token: string; port: number | null }
export function vaultHash(vaultPath: string): string { return createHash("sha256").update(fs.realpathSync(vaultPath)).digest("hex"); }
export function preferenceFile(vaultPath: string, home = os.homedir()): string {
	const file = path.join(home, ".config", "skill-symlinks", "editor", vaultHash(vaultPath) + ".json");
	if (inside(fs.realpathSync(vaultPath), path.resolve(file))) throw new Error("Editor credentials must be outside the vault");
	return file;
}
function privateParent(file: string, create: boolean) {
	const directory = path.dirname(file);
	if (create) {
		let ancestor = directory;
		while (!fs.existsSync(ancestor) && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
		if (!fs.lstatSync(ancestor).isDirectory() || fs.realpathSync(ancestor) !== ancestor) throw new Error("Editor configuration is not private");
		fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	}
	const st = fs.lstatSync(directory);
	if (!st.isDirectory() || st.isSymbolicLink() || fs.realpathSync(directory) !== directory || (process.platform !== "win32" && st.uid !== process.getuid?.())) throw new Error("Editor configuration is not private");
	if (process.platform !== "win32" && (st.mode & 0o077)) {
		if (!create) throw new Error("Editor configuration is not private");
		fs.chmodSync(directory, 0o700);
	}
}
export function readPreference(vaultPath: string, home = os.homedir()): LocalEditorPreference | null {
	try {
		const file = preferenceFile(vaultPath, home);
		privateParent(file, false);
		const st = fs.lstatSync(file);
		if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 4096 || (process.platform !== "win32" && ((st.mode & 0o077) || st.uid !== process.getuid?.()))) return null;
		const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<LocalEditorPreference>;
		if (raw.schema !== 1 || raw.vaultHash !== vaultHash(vaultPath) || typeof raw.enabled !== "boolean" || typeof raw.token !== "string" || !/^[a-f0-9]{64}$/.test(raw.token) || !(raw.port === null || (Number.isInteger(raw.port) && raw.port! >= 1024 && raw.port! <= 65535))) return null;
		return raw as LocalEditorPreference;
	} catch { return null; }
}
function writePreference(vaultPath: string, data: LocalEditorPreference, home = os.homedir()) {
	const file = preferenceFile(vaultPath, home);
	privateParent(file, true);
	if (fs.existsSync(file)) {
		const st = fs.lstatSync(file);
		if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1 || (process.platform !== "win32" && st.uid !== process.getuid?.())) throw new Error("Editor configuration is not private");
	}
	const temp = file + ".tmp-" + randomBytes(8).toString("hex");
	fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600, flag: "wx" });
	fs.renameSync(temp, file);
}
/** Explicit per-machine enrollment. No credential is written inside the vault or synced to another device. */
export function setLocalEditorEnabled(vaultPath: string, enabled: boolean, home = os.homedir()): LocalEditorPreference {
	const value: LocalEditorPreference = { schema: 1, vaultHash: vaultHash(vaultPath), token: randomBytes(32).toString("hex"), port: null, enabled };
	writePreference(vaultPath, value, home);
	return value;
}
export async function startLocalEditor(vaultPath: string, core: ReturnType<typeof createEditorCore>, home = os.homedir()) {
	const preference = readPreference(vaultPath, home);
	if (!preference?.enabled) return null;
	const enrolledToken = preference.token;
	preference.token = randomBytes(32).toString("hex");
	let port = 0, active = 0, windowAt = Date.now(), requests = 0;
	const send = (res: ServerResponse, status: number, body: unknown) => {
		if (res.destroyed || res.writableEnded || res.headersSent) return;
		res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
		res.end(JSON.stringify(body));
	};
	async function handle(req: IncomingMessage, res: ServerResponse) {
		if (req.socket.remoteAddress !== "127.0.0.1" || req.headers.host !== `127.0.0.1:${port}` || req.headers.origin !== undefined || req.headers["sec-fetch-site"] !== undefined) return send(res, 403, { error: "Forbidden" });
		const current = readPreference(vaultPath, home);
		if (!current?.enabled || current.token !== preference!.token || current.port !== port) return send(res, 403, { error: "Editor disabled" });
		const supplied = req.headers.authorization?.replace(/^Bearer /, "") ?? "";
		if (!/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(preference!.token))) return send(res, 401, { error: "Unauthorized" });
		if (req.method !== "POST" || req.url !== "/v1/editor") return send(res, 404, { error: "Not found" });
		if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json" || req.headers["content-encoding"] !== undefined) return send(res, 415, { error: "JSON required" });
		if (Date.now() - windowAt >= 60_000) { windowAt = Date.now(); requests = 0; }
		if (++requests > 240 || active >= 8) return send(res, 429, { error: "Editor busy" });
		active++;
		let command: EditorCommand | null = null;
		const cancel = () => { if (command && !res.writableEnded) command.deadline = 0; };
		res.once("close", cancel);
		const timer = setTimeout(() => { cancel(); send(res, 408, { error: "Editor request expired" }); req.destroy(); }, 15_000);
		try {
			const chunks: Buffer[] = []; let size = 0;
			for await (const chunk of req as AsyncIterable<Buffer>) {
				size += chunk.length;
				if (size > 768 * 1024) { send(res, 413, { error: "Request too large" }); req.destroy(); return; }
				chunks.push(chunk);
			}
			try { command = parseEditorCommand(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { return send(res, 400, { error: "Invalid editor command" }); }
			if (command.operationId && (!command.deadline || command.deadline > Date.now() + 30_000)) return send(res, 400, { error: "A bounded deadline is required" });
			const result = await core.run(command);
			send(res, result.status, result.body);
		} catch { send(res, 500, { error: "Editor request failed" }); }
		finally { clearTimeout(timer); active--; res.off("close", cancel); }
	}
	const server = createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => { void handle(req, res); });
	server.headersTimeout = 5000; server.requestTimeout = 10_000; server.keepAliveTimeout = 1000;
	server.maxConnections = 32;
	await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	const address = server.address();
	if (!address || typeof address === "string") { server.close(); throw new Error("Editor failed to start"); }
	port = address.port;
	const current = readPreference(vaultPath, home);
	if (!current?.enabled || current.token !== enrolledToken || current.port !== preference.port) { server.close(); server.closeAllConnections(); return null; }
	try { writePreference(vaultPath, { ...preference, port }, home); } catch { server.close(); server.closeAllConnections(); throw new Error("Editor configuration could not be saved"); }
	return {
		port,
		close() {
			server.close(); server.closeAllConnections();
			const current = readPreference(vaultPath, home);
			if (current?.port === port && current.token === preference.token) writePreference(vaultPath, { ...current, port: null }, home);
		},
	};
}

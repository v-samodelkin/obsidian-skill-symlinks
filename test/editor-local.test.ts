import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { request } from "node:http";
import { test } from "node:test";
import { createEditorCore } from "../src/editor/core.ts";
import { preferenceFile, readPreference, setLocalEditorEnabled, startLocalEditor } from "../src/editor/local.ts";

test("machine-local enrollment is private, opt-in, and rejects linked discovery files", async (t) => {
	const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "skills-local-test-"))), vault = path.join(tmp, "vault"), home = path.join(tmp, "home");
	t.after(() => fs.rmSync(tmp, { recursive: true, force: true })); fs.mkdirSync(vault); fs.mkdirSync(home);
	assert.equal(readPreference(vault, home), null);
	const enrolled = setLocalEditorEnabled(vault, true, home), file = preferenceFile(vault, home);
	assert.equal(enrolled.enabled, true); if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o077, 0); assert.ok(!file.startsWith(vault + path.sep));
	fs.renameSync(file, file + ".original"); fs.symlinkSync(file + ".original", file);
	assert.equal(readPreference(vault, home), null); assert.throws(() => setLocalEditorEnabled(vault, true, home));
});

test("loopback API rejects browser/foreign-host requests, rotates credentials and disables immediately", async (t) => {
	const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "skills-local-http-"))), vault = path.join(tmp, "vault"), home = path.join(tmp, "home");
	t.after(() => fs.rmSync(tmp, { recursive: true, force: true })); fs.mkdirSync(vault); fs.mkdirSync(home);
	const old = setLocalEditorEnabled(vault, true, home); let calls = 0;
	const core = { async run() { calls++; return { status: 200, body: { available: true } }; } } as unknown as ReturnType<typeof createEditorCore>;
	const server = await startLocalEditor(vault, core, home); assert.ok(server); t.after(() => server.close());
	const active = readPreference(vault, home)!; assert.notEqual(active.token, old.token); assert.equal(active.port, server.port);
	const call = (headers: Record<string, string> = {}, body = JSON.stringify({ action: "catalog" }), method = "POST") => new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((resolve, reject) => {
		const req = request({ hostname: "127.0.0.1", port: server.port, method, path: "/v1/editor", headers: { Authorization: `Bearer ${active.token}`, "Content-Type": "application/json", ...headers } }, (res) => {
			let text = ""; res.setEncoding("utf8"); res.on("data", (chunk: string) => { text += chunk; }); res.on("end", () => resolve({ status: res.statusCode!, body: text, headers: res.headers }));
		}); req.once("error", reject); req.end(body);
	});
	assert.equal((await call({ Authorization: `Bearer ${old.token}` })).status, 401);
	assert.equal((await call({ Host: `localhost:${server.port}` })).status, 403);
	assert.equal((await call({ Origin: "https://evil.invalid" })).status, 403);
	assert.equal((await call({ "Sec-Fetch-Site": "same-origin" })).status, 403);
	assert.equal((await call({ "Content-Type": "text/plain" })).status, 415);
	assert.equal((await call({ "Content-Encoding": "gzip" })).status, 415);
	assert.equal((await call({}, "{}", "GET")).status, 404);
	assert.equal((await call({}, JSON.stringify({ action: "catalog", actor: "owner" }))).status, 400);
	const good = await call(); assert.equal(good.status, 200); assert.equal(good.headers["cache-control"], "no-store"); assert.equal(good.headers["access-control-allow-origin"], undefined); assert.equal(calls, 1);
	setLocalEditorEnabled(vault, false, home); assert.equal((await call()).status, 403); assert.equal(calls, 1);
});

test("a concurrent disable cannot be overwritten by an API server still starting", async (t) => {
	const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "skills-local-race-"))), vault = path.join(tmp, "vault"), home = path.join(tmp, "home");
	t.after(() => fs.rmSync(tmp, { recursive: true, force: true })); fs.mkdirSync(vault); fs.mkdirSync(home);
	setLocalEditorEnabled(vault, true, home);
	const core = { async run() { return { status: 200, body: { available: true } }; } } as unknown as ReturnType<typeof createEditorCore>;
	const pending = startLocalEditor(vault, core, home); setLocalEditorEnabled(vault, false, home);
	assert.equal(await pending, null); assert.equal(readPreference(vault, home)!.enabled, false);
});

test("enrollment refuses a credential location inside the selected vault before writing", (t) => {
 const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "skills-local-home-vault-")));
 t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
 assert.throws(() => setLocalEditorEnabled(tmp, true, tmp), /outside the vault/);
 assert.equal(fs.existsSync(path.join(tmp, ".config")), false);
});

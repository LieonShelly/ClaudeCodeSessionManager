import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import {
	OWNER,
	SettingsError,
	ensureHooksInstalled,
	removeInstalledHooks,
	resolveNodeExecutable,
} from "../src/hooksInstall";

const roots: string[] = [];

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csm-hooks-"));
	roots.push(dir);
	return dir;
}

function targets(dir: string) {
	return {
		settingsFile: path.join(dir, "settings.json"),
		hookPath: path.join(dir, "out", "hook", "claude-session-hook.js"),
		mapDir: path.join(dir, "storage", "terminals"),
		configDir: path.join(dir, "claude"),
		nodePath: process.execPath,
	};
}

function read(file: string): any {
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

after(() => {
	for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

test("ensureHooksInstalled creates settings and registers every managed event", () => {
	const dir = tempDir();
	const t = targets(dir);
	const result = ensureHooksInstalled(t);
	assert.equal(result.status, "installed");

	const settings = read(t.settingsFile);
	for (const event of [
		"SessionStart",
		"UserPromptSubmit",
		"PermissionRequest",
		"PreToolUse",
		"PostToolUse",
		"PostToolUseFailure",
		"Notification",
		"Stop",
		"StopFailure",
		"SessionEnd",
	]) {
		assert.ok(Array.isArray(settings.hooks[event]), `${event} missing`);
		assert.ok(JSON.stringify(settings.hooks[event]).includes(t.hookPath));
		assert.ok(JSON.stringify(settings.hooks[event]).includes(OWNER));
	}
	const handler = settings.hooks.Notification[0].hooks[0];
	assert.equal(handler.type, "command");
	assert.equal(handler.command, process.execPath);
	assert.deepEqual(handler.args.slice(0, 2), [t.hookPath, "--map-dir"]);
});

test("ensureHooksInstalled preserves unrelated settings and handlers", () => {
	const dir = tempDir();
	const t = targets(dir);
	const initial = {
		env: { KEEP: "1" },
		permissions: { allow: ["Bash(ls)"] },
		hooks: {
			UserPromptSubmit: [{ hooks: [{ type: "command", command: "codegraph prompt-hook" }] }],
			PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "audit" }] }],
		},
	};
	fs.writeFileSync(t.settingsFile, JSON.stringify(initial, null, 2));

	assert.equal(ensureHooksInstalled(t).status, "installed");
	const settings = read(t.settingsFile);
	assert.deepEqual(settings.env, initial.env);
	assert.deepEqual(settings.permissions, initial.permissions);
	assert.equal(settings.hooks.UserPromptSubmit.length, 2);
	assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].command, "codegraph prompt-hook");
	assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, "audit");
});

test("ensureHooksInstalled is idempotent", () => {
	const dir = tempDir();
	const t = targets(dir);
	fs.writeFileSync(t.settingsFile, JSON.stringify({ env: { KEEP: "1" } }, null, 2));
	assert.equal(ensureHooksInstalled(t).status, "installed");
	const first = fs.readFileSync(t.settingsFile, "utf8");

	assert.equal(ensureHooksInstalled(t).status, "unchanged");
	assert.equal(fs.readFileSync(t.settingsFile, "utf8"), first);
});

test("ensureHooksInstalled replaces a stale managed handler", () => {
	const dir = tempDir();
	const t = targets(dir);
	fs.writeFileSync(
		t.settingsFile,
		JSON.stringify({
			hooks: { Stop: [{ hooks: [{ type: "command", command: "/old/node", args: ["/old/hook.js", "--owner", OWNER] }] }] },
		}),
	);

	assert.equal(ensureHooksInstalled(t).status, "updated");
	const text = fs.readFileSync(t.settingsFile, "utf8");
	assert.ok(!text.includes("/old/node"));
	assert.ok(text.includes(t.hookPath));
	assert.equal(read(t.settingsFile).hooks.Stop.length, 1);
	assert.equal(read(t.settingsFile).hooks.Stop[0].hooks.length, 1);
});

test("removeInstalledHooks removes only managed handlers", () => {
	const dir = tempDir();
	const t = targets(dir);
	fs.writeFileSync(
		t.settingsFile,
		JSON.stringify({
			env: { KEEP: "1" },
			hooks: {
				UserPromptSubmit: [{ hooks: [{ type: "command", command: "codegraph prompt-hook" }] }],
				Stop: [{ hooks: [{ type: "command", command: "other" }] }],
			},
		}),
	);
	ensureHooksInstalled(t);

	assert.equal(removeInstalledHooks(t.settingsFile).status, "removed");
	const settings = read(t.settingsFile);
	assert.deepEqual(settings.env, { KEEP: "1" });
	assert.equal(settings.hooks.UserPromptSubmit.length, 1);
	assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].command, "codegraph prompt-hook");
	assert.equal(settings.hooks.Stop[0].hooks[0].command, "other");
	assert.ok(!fs.readFileSync(t.settingsFile, "utf8").includes(t.hookPath));
});

test("removeInstalledHooks reports absent and unchanged", () => {
	const dir = tempDir();
	const t = targets(dir);
	assert.equal(removeInstalledHooks(t.settingsFile).status, "absent");

	fs.writeFileSync(t.settingsFile, JSON.stringify({ env: { KEEP: "1" } }));
	assert.equal(removeInstalledHooks(t.settingsFile).status, "unchanged");
	assert.deepEqual(read(t.settingsFile), { env: { KEEP: "1" } });
});

test("invalid JSON aborts without touching the file", () => {
	const dir = tempDir();
	const t = targets(dir);
	const raw = '{ "hooks": oops }';
	fs.writeFileSync(t.settingsFile, raw);

	assert.throws(() => ensureHooksInstalled(t), SettingsError);
	assert.equal(fs.readFileSync(t.settingsFile, "utf8"), raw);
});

test("invalid hooks shape aborts without touching the file", () => {
	const dir = tempDir();
	const t = targets(dir);
	const raw = JSON.stringify({ hooks: { Stop: { hooks: [] } } }, null, 2);
	fs.writeFileSync(t.settingsFile, raw);

	assert.throws(() => ensureHooksInstalled(t), SettingsError);
	assert.equal(fs.readFileSync(t.settingsFile, "utf8"), raw);
});

test("ensureHooksInstalled preserves the settings file mode", { skip: process.platform === "win32" }, () => {
	const dir = tempDir();
	const t = targets(dir);
	fs.writeFileSync(t.settingsFile, "{}");
	fs.chmodSync(t.settingsFile, 0o600);

	ensureHooksInstalled(t);
	assert.equal(fs.statSync(t.settingsFile).mode & 0o777, 0o600);
});

test("ensureHooksInstalled follows a symlinked settings file", { skip: process.platform === "win32" }, () => {
	const dir = tempDir();
	const t = targets(dir);
	const real = path.join(dir, "real-settings.json");
	const link = path.join(dir, "settings.json");
	fs.writeFileSync(real, "{}");
	fs.symlinkSync(real, link);
	t.settingsFile = link;

	assert.equal(ensureHooksInstalled(t).status, "installed");
	assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
	assert.ok(JSON.stringify(read(real)).includes(t.hookPath));
});

test("resolveNodeExecutable returns the explicit path and searches PATH", () => {
	assert.equal(resolveNodeExecutable(process.execPath), process.execPath);
	const found = resolveNodeExecutable("node");
	assert.ok(found.endsWith("node") || found.endsWith("node.exe"));
	assert.throws(() => resolveNodeExecutable(path.join(os.tmpdir(), "definitely-not-a-real-node")), SettingsError);
});

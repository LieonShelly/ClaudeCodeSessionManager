import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { expandHome } from "./claudeFs";

/** Marks every hook handler this extension owns, so reinstalling can replace only those. */
export const OWNER = "claude-session-manager";

const LOCK_TIMEOUT_MS = 2000;
const LOCK_STALE_MS = 10_000;
const BACKUP_LIMIT = 5;

export class SettingsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SettingsError";
	}
}

export interface HookTargets {
	settingsFile: string;
	hookPath: string;
	mapDir: string;
	configDir: string;
	/** Absolute Node.js executable. Resolved from PATH when omitted. */
	nodePath?: string;
}

export interface SettingsChange {
	status: "installed" | "updated" | "unchanged" | "removed" | "absent";
	file: string;
}

interface ManagedEvent {
	event: string;
	matcher?: string;
}

// SessionStart keeps a compacted session's state; the rest are point-in-time signals.
const MANAGED_EVENTS: readonly ManagedEvent[] = [
	{ event: "SessionStart", matcher: "startup|resume|clear|compact|fork" },
	{ event: "UserPromptSubmit" },
	{ event: "PermissionRequest" },
	{ event: "PreToolUse", matcher: "AskUserQuestion|ExitPlanMode" },
	{ event: "PostToolUse", matcher: "AskUserQuestion|ExitPlanMode" },
	{ event: "PostToolUseFailure" },
	{ event: "Notification" },
	{ event: "Stop" },
	{ event: "StopFailure" },
	{ event: "SessionEnd" },
];

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExecutable(file: string): boolean {
	try {
		if (!fs.statSync(file).isFile()) return false;
		if (process.platform !== "win32") fs.accessSync(file, fs.constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Finds a real Node.js binary. The extension host's `process.execPath` is Electron and
 * cannot run the hook, so only a `node`-named executable is accepted as a fallback.
 */
function searchPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
	for (const dir of (env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		const candidate = path.join(dir, name);
		if (isExecutable(candidate)) return candidate;
	}
	return undefined;
}

export function resolveNodeExecutable(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
	const configured = explicit?.trim();
	if (configured) {
		const resolved = expandHome(configured);
		if (isExecutable(resolved)) return resolved;
		// A bare name is a PATH lookup, not a file next to the working directory.
		if (!configured.includes("/") && !configured.includes("\\")) {
			const found = searchPath(configured, env);
			if (found) return found;
		}
		throw new SettingsError(`Configured hooks.nodePath is not executable: ${resolved}`);
	}
	for (const name of process.platform === "win32" ? ["node.exe", "node"] : ["node", "node.exe"]) {
		const found = searchPath(name, env);
		if (found) return found;
	}
	const fallback = process.execPath;
	if (/^node(\.exe)?$/i.test(path.basename(fallback)) && isExecutable(fallback)) return fallback;
	throw new SettingsError("Could not find Node.js. Install it or set claudeSession.hooks.nodePath.");
}

function hookHandler(targets: HookTargets, nodePath: string): Record<string, unknown> {
	return {
		type: "command",
		command: nodePath,
		args: [
			targets.hookPath,
			"--map-dir",
			targets.mapDir,
			"--config-dir",
			targets.configDir,
			"--owner",
			OWNER,
		],
		timeout: 10,
	};
}

function isManagedHandler(handler: unknown): boolean {
	if (!isObject(handler)) return false;
	const args = handler.args;
	return Array.isArray(args) && args.includes(OWNER);
}

function stripManagedGroup(group: unknown): unknown {
	if (!isObject(group) || !Array.isArray(group.hooks)) return group;
	const hooks = group.hooks.filter((handler) => !isManagedHandler(handler));
	return hooks.length === group.hooks.length ? group : { ...group, hooks };
}

/** Drops managed handlers from one event's groups, removing a group left with none. */
function stripEventGroups(groups: unknown[]): unknown[] {
	return groups.map(stripManagedGroup).filter((group) => !isObject(group) || !Array.isArray(group.hooks) || group.hooks.length > 0);
}

function hooksObject(settings: Record<string, unknown>): Record<string, unknown> {
	return isObject(settings.hooks) ? settings.hooks : {};
}

export function hasManagedHooks(settings: Record<string, unknown>): boolean {
	const hooks = hooksObject(settings);
	for (const groups of Object.values(hooks)) {
		if (!Array.isArray(groups)) continue;
		for (const group of groups) {
			if (isObject(group) && Array.isArray(group.hooks) && group.hooks.some(isManagedHandler)) return true;
		}
	}
	return false;
}

/** Returns a settings copy with this extension's handlers replaced; unrelated handlers stay. */
export function withManagedHooks(settings: Record<string, unknown>, targets: HookTargets): Record<string, unknown> {
	const nodePath = resolveNodeExecutable(targets.nodePath);
	const hooks: Record<string, unknown> = { ...hooksObject(settings) };
	for (const { event, matcher } of MANAGED_EVENTS) {
		const existing = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
		const groups = stripEventGroups(existing);
		groups.push({ ...(matcher ? { matcher } : {}), hooks: [hookHandler(targets, nodePath)] });
		hooks[event] = groups;
	}
	return { ...settings, hooks };
}

/** Returns a settings copy with every handler this extension owns removed. */
export function withoutManagedHooks(settings: Record<string, unknown>): Record<string, unknown> {
	// Do not introduce an empty `hooks` key when the file never had one.
	if (!isObject(settings.hooks)) return { ...settings };
	const hooks: Record<string, unknown> = { ...settings.hooks };
	for (const [event, groups] of Object.entries(hooks)) {
		if (!Array.isArray(groups)) continue;
		const next = stripEventGroups(groups);
		if (next.length) hooks[event] = next;
		else delete hooks[event];
	}
	const next = { ...settings };
	if (Object.keys(hooks).length) next.hooks = hooks;
	else delete next.hooks;
	return next;
}

function validateSettings(settings: unknown): asserts settings is Record<string, unknown> {
	if (!isObject(settings)) throw new SettingsError("Claude settings must be a JSON object.");
	if (settings.hooks === undefined) return;
	if (!isObject(settings.hooks)) throw new SettingsError("Claude settings `hooks` must be an object.");
	for (const [event, groups] of Object.entries(settings.hooks)) {
		if (!Array.isArray(groups)) throw new SettingsError(`Claude settings hooks.${event} must be an array.`);
		for (const group of groups) {
			if (!isObject(group) || !Array.isArray(group.hooks)) {
				throw new SettingsError(`Claude settings hooks.${event} contains a group without a hooks array.`);
			}
			for (const handler of group.hooks) {
				if (!isObject(handler)) throw new SettingsError(`Claude settings hooks.${event} contains a non-object handler.`);
			}
		}
	}
}

function readSettings(file: string): { settings: Record<string, unknown>; raw: string; existed: boolean } {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { settings: {}, raw: "", existed: false };
		throw err;
	}
	const text = raw.replace(/^﻿/, "");
	if (!text.trim()) return { settings: {}, raw, existed: true };
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new SettingsError(`Cannot parse ${file} as JSON; fix it before installing hooks.`);
	}
	validateSettings(parsed);
	return { settings: parsed, raw, existed: true };
}

function detectIndent(raw: string): string {
	const match = /\n([ \t]+)"/.exec(raw);
	return match?.[1] ?? "  ";
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withLock<T>(file: string, fn: () => T): T {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const lock = `${file}.claude-session-manager.lock`;
	const deadline = Date.now() + LOCK_TIMEOUT_MS;
	let fd: number | undefined;
	while (fd === undefined) {
		try {
			fd = fs.openSync(lock, "wx");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
			try {
				if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
					fs.rmSync(lock, { force: true });
					continue;
				}
			} catch {
				// The owner removed it between open and stat; retry at once.
				continue;
			}
			if (Date.now() > deadline) throw new SettingsError(`Timed out waiting for ${lock}.`);
			sleepSync(50);
		}
	}
	try {
		fs.writeFileSync(fd, String(process.pid));
		fs.fsyncSync(fd);
		return fn();
	} finally {
		try {
			fs.closeSync(fd);
		} catch {
			// already closed
		}
		try {
			fs.rmSync(lock, { force: true });
		} catch {
			// best effort
		}
	}
}

function renameWithRetry(from: string, to: string): void {
	for (let attempt = 0; ; attempt++) {
		try {
			fs.renameSync(from, to);
			return;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (attempt >= 4 || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw err;
			sleepSync(20 * (attempt + 1));
		}
	}
}

function writeAtomic(file: string, text: string, mode: number): void {
	const dir = path.dirname(file);
	fs.mkdirSync(dir, { recursive: true });
	const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
	const fd = fs.openSync(temp, "wx", mode);
	try {
		fs.writeFileSync(fd, text, "utf8");
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	try {
		fs.chmodSync(temp, mode);
	} catch {
		// Windows has no meaningful mode; keep the rename.
	}
	try {
		renameWithRetry(temp, file);
	} catch (err) {
		fs.rmSync(temp, { force: true });
		throw err;
	}
}

/** Timestamped copy before an overwrite; failure never blocks the settings write. */
function backupSettings(file: string, raw: string, mode: number): void {
	if (!raw) return;
	const dir = path.join(path.dirname(file), "backups", "claude-session-manager");
	try {
		fs.mkdirSync(dir, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		fs.writeFileSync(path.join(dir, `settings.${stamp}.json`), raw, { mode });
		const backups = fs
			.readdirSync(dir)
			.filter((name) => /^settings\..*\.json$/.test(name))
			.sort();
		for (const name of backups.slice(0, Math.max(0, backups.length - BACKUP_LIMIT))) {
			fs.rmSync(path.join(dir, name), { force: true });
		}
	} catch {
		// Backups are a convenience, not a precondition.
	}
}

/** The real file to write: a symlinked settings file keeps its link and updates its target. */
function writeTarget(file: string): string {
	try {
		return fs.lstatSync(file).isSymbolicLink() ? fs.realpathSync(file) : file;
	} catch {
		return file;
	}
}

function fileMode(file: string): number {
	try {
		return fs.statSync(file).mode & 0o777;
	} catch {
		return 0o600;
	}
}

function fileStamp(file: string): string {
	try {
		const stat = fs.statSync(file);
		return `${stat.mtimeMs}:${stat.size}`;
	} catch {
		return "absent";
	}
}

/** Refuses to overwrite an edit another process made while this one held the lock. */
function assertUnchanged(file: string, stamp: string): void {
	if (fileStamp(file) !== stamp) throw new SettingsError(`${file} changed while hooks were being installed; try again.`);
}

/** Reads, merges, and atomically writes `~/.claude/settings.json`. */
export function ensureHooksInstalled(targets: HookTargets): SettingsChange {
	const file = writeTarget(targets.settingsFile);
	return withLock(file, () => {
		const stamp = fileStamp(file);
		const { settings, raw, existed } = readSettings(file);
		const wasManaged = hasManagedHooks(settings);
		const next = withManagedHooks(settings, targets);
		if (JSON.stringify(next) === JSON.stringify(settings)) return { status: "unchanged", file: targets.settingsFile };
		assertUnchanged(file, stamp);

		const mode = fileMode(file);
		backupSettings(file, raw, mode);
		const text = `${JSON.stringify(next, null, existed ? detectIndent(raw) : "  ")}\n`;
		writeAtomic(file, text, mode);
		return { status: wasManaged ? "updated" : "installed", file: targets.settingsFile };
	});
}

/** Removes only this extension's handlers; other hooks and settings stay untouched. */
export function removeInstalledHooks(settingsFile: string): SettingsChange {
	if (!fs.existsSync(settingsFile)) return { status: "absent", file: settingsFile };
	const file = writeTarget(settingsFile);
	return withLock(file, () => {
		const stamp = fileStamp(file);
		const { settings, raw, existed } = readSettings(file);
		const next = withoutManagedHooks(settings);
		if (JSON.stringify(next) === JSON.stringify(settings)) return { status: "unchanged", file: settingsFile };
		assertUnchanged(file, stamp);
		const mode = fileMode(file);
		backupSettings(file, raw, mode);
		const text = `${JSON.stringify(next, null, existed ? detectIndent(raw) : "  ")}\n`;
		writeAtomic(file, text, mode);
		return { status: "removed", file: settingsFile };
	});
}

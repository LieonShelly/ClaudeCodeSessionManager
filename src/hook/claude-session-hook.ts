import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { findLiveSessionBySessionId, findTranscriptForSession } from "../claudeFs";
import { parentPid } from "../processTree";

export type HookState = "idle" | "working" | "waiting";

const OWNER = "claude-session-manager";
const ENV_KEY = "CLAUDE_SESSION_MANAGER_TERMINAL";
const TERMINAL_KEY_RE = /^[A-Za-z0-9._-]+$/;
const STATES: readonly string[] = ["idle", "working", "waiting"] satisfies HookState[];

export interface HookInput {
	hook_event_name?: unknown;
	session_id?: unknown;
	transcript_path?: unknown;
	cwd?: unknown;
	source?: unknown;
	reason?: unknown;
	notification_type?: unknown;
	tool_name?: unknown;
	is_interrupt?: unknown;
	stop_hook_active?: unknown;
	background_tasks?: unknown;
	session_crons?: unknown;
	agent_id?: unknown;
	agent_type?: unknown;
	[key: string]: unknown;
}

export interface HookRecord {
	terminalId?: string;
	pid: number;
	shellPid?: number;
	sessionFile?: string;
	sessionId: string;
	cwd: string;
	state: HookState;
	stateAt: number;
	updatedAt: number;
	owner: string;
}

export interface HookContext {
	mapDir: string;
	configDir: string;
	env?: NodeJS.ProcessEnv;
	/** Parent of the hook process, normally the Claude Code pid. */
	ppid?: number;
	parentOf?: (pid: number) => Promise<number | undefined>;
	now?: () => number;
}

export type HookOutcome =
	| { kind: "write"; file: string; record: HookRecord }
	| { kind: "delete"; file: string }
	| { kind: "ignore" };

const WAITING_NOTIFICATIONS = new Set([
	"permission_prompt",
	"worker_permission_prompt",
	"agent_needs_input",
	"elicitation_dialog",
	"computer_use_enter",
]);

function nonEmptyArray(value: unknown): boolean {
	return Array.isArray(value) && value.length > 0;
}

function inputString(input: HookInput, key: string): string | undefined {
	const value = input[key];
	return typeof value === "string" && value ? value : undefined;
}

/**
 * Maps one Claude Code hook event to a session state. `undefined` means the event does
 * not change state; `delete` removes the record after a deliberate exit.
 */
export function mapEvent(input: HookInput, previous?: HookState): HookState | "delete" | undefined {
	// Subagent events describe a sidechain and must not overwrite the main session.
	if (input.agent_id !== undefined || input.agent_type !== undefined) return undefined;
	const event = input.hook_event_name;
	switch (event) {
		case "SessionStart": {
			const source = inputString(input, "source");
			// Compaction happens inside a running turn; the session keeps doing what it was doing.
			return source === "compact" ? (previous ?? "idle") : "idle";
		}
		case "UserPromptSubmit":
			return "working";
		case "PermissionRequest":
			return "waiting";
		case "PreToolUse": {
			const tool = inputString(input, "tool_name");
			return tool === "AskUserQuestion" || tool === "ExitPlanMode" ? "waiting" : undefined;
		}
		case "PostToolUse": {
			const tool = inputString(input, "tool_name");
			return tool === "AskUserQuestion" || tool === "ExitPlanMode" ? "working" : undefined;
		}
		case "PostToolUseFailure":
			return input.is_interrupt === true ? "idle" : undefined;
		case "Notification": {
			const type = inputString(input, "notification_type");
			if (type && WAITING_NOTIFICATIONS.has(type)) return "waiting";
			if (type === "idle_prompt") return "idle";
			return undefined;
		}
		case "Stop":
			// A stop with queued background work continues the turn.
			return input.stop_hook_active === true || nonEmptyArray(input.background_tasks) || nonEmptyArray(input.session_crons)
				? "working"
				: "idle";
		case "StopFailure":
			return "idle";
		case "SessionEnd": {
			const reason = inputString(input, "reason");
			if (reason === "prompt_input_exit" || reason === "clear" || reason === "logout" || reason === "resume") return "delete";
			// `other` covers VS Code closing the window; keeping the record enables restore.
			return undefined;
		}
		default:
			return undefined;
	}
}

function readRecord(file: string): HookRecord | undefined {
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf8"));
		if (typeof raw !== "object" || raw === null) return undefined;
		const rec = raw as Record<string, unknown>;
		if (typeof rec.pid !== "number" || typeof rec.sessionId !== "string") return undefined;
		if (typeof rec.state !== "string" || !STATES.includes(rec.state)) return undefined;
		return rec as unknown as HookRecord;
	} catch {
		return undefined;
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
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
		}
	}
}

function writeRecord(file: string, record: HookRecord): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temp = path.join(
		path.dirname(file),
		`.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`,
	);
	const fd = fs.openSync(temp, "wx", 0o600);
	try {
		fs.writeFileSync(fd, JSON.stringify(record), "utf8");
		fs.fsyncSync(fd);
	} finally {
		fs.closeSync(fd);
	}
	try {
		renameWithRetry(temp, file);
	} catch (err) {
		fs.rmSync(temp, { force: true });
		throw err;
	}
}

interface Identity {
	key: string;
	terminalId?: string;
	pid: number;
	shellPid?: number;
}

async function resolveIdentity(sessionId: string, ctx: HookContext): Promise<Identity> {
	const configured = (ctx.env ?? process.env)[ENV_KEY]?.trim();
	const terminalId = configured && TERMINAL_KEY_RE.test(configured) ? configured : undefined;
	let livePid: number | undefined;
	try {
		livePid = findLiveSessionBySessionId(ctx.configDir, sessionId)?.pid;
	} catch {
		// A missing or unreadable registry falls back to the hook process tree.
	}
	const pid = livePid ?? ctx.ppid ?? process.ppid;
	let shellPid: number | undefined;
	try {
		shellPid = await (ctx.parentOf ?? parentPid)(pid);
	} catch {
		shellPid = undefined;
	}
	return { key: terminalId ?? `pid-${pid}`, terminalId, pid, shellPid };
}

/**
 * Applies one hook event. Callers must treat this as best-effort: the hook runs inside
 * Claude Code and must never surface an error to the agent.
 */
export async function handleHook(input: HookInput, ctx: HookContext): Promise<HookOutcome> {
	if (input.agent_id !== undefined || input.agent_type !== undefined) return { kind: "ignore" };
	const sessionId = inputString(input, "session_id");
	if (!sessionId) return { kind: "ignore" };

	const identity = await resolveIdentity(sessionId, ctx);
	const file = path.join(ctx.mapDir, `${identity.key}.json`);
	const existing = readRecord(file);
	const now = (ctx.now ?? Date.now)();

	// Read the previous state before mapping so `compact` can preserve it.
	const previous = existing?.state;
	const state = mapEvent(input, previous);
	if (state === "delete") {
		fs.rmSync(file, { force: true });
		return { kind: "delete", file };
	}
	if (!state) return { kind: "ignore" };
	// A delayed hook invocation must not roll a newer state back.
	if (existing && typeof existing.stateAt === "number" && existing.stateAt > now) return { kind: "ignore" };

	let sessionFile = inputString(input, "transcript_path");
	if (!sessionFile) {
		try {
			sessionFile = findTranscriptForSession(ctx.configDir, sessionId);
		} catch {
			sessionFile = undefined;
		}
	}
	if (!sessionFile && existing?.sessionId === sessionId) sessionFile = existing.sessionFile;
	const cwd = inputString(input, "cwd") ?? existing?.cwd ?? "";

	const record: HookRecord = {
		pid: identity.pid,
		sessionId,
		cwd,
		state,
		stateAt: now,
		updatedAt: now,
		owner: OWNER,
	};
	if (identity.terminalId) record.terminalId = identity.terminalId;
	if (identity.shellPid !== undefined) record.shellPid = identity.shellPid;
	if (sessionFile) record.sessionFile = sessionFile;
	writeRecord(file, record);
	return { kind: "write", file, record };
}

function parseArgs(argv: string[]): { mapDir?: string; configDir?: string } {
	const out: { mapDir?: string; configDir?: string } = {};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--map-dir") out.mapDir = argv[++i];
		else if (argv[i] === "--config-dir") out.configDir = argv[++i];
	}
	return out;
}

/** Hook entry point. Reads one JSON payload from stdin; never writes stdout or stderr. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
	try {
		const { mapDir, configDir } = parseArgs(argv);
		if (!mapDir || !configDir) return;
		const text = fs.readFileSync(0, "utf8");
		if (!text.trim()) return;
		const input = JSON.parse(text);
		if (typeof input !== "object" || input === null) return;
		await handleHook(input as HookInput, { mapDir, configDir });
	} catch {
		// Hooks must be invisible to Claude Code, including malformed input and I/O failures.
	}
}

if (require.main === module) void main();

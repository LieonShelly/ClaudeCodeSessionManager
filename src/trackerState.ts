import type { LiveSession } from "./claudeFs";

export type SessionState = "idle" | "working" | "waiting";

export const SESSION_STATES: readonly string[] = ["idle", "working", "waiting"] satisfies SessionState[];

/** A validated record from `<mapDir>/<key>.json`, written by the Claude Code hook. */
export interface MapRecord {
	terminalId?: string;
	pid?: number;
	shellPid?: number;
	sessionFile?: string;
	sessionId: string;
	cwd?: string;
	state: SessionState;
	stateAt?: number;
	updatedAt?: number;
	owner?: string;
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Validates a hook record; anything without a session id and a known state is ignored. */
export function parseMapRecord(raw: unknown): MapRecord | undefined {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
	const rec = raw as Record<string, unknown>;
	if (typeof rec.sessionId !== "string" || !rec.sessionId) return undefined;
	if (typeof rec.state !== "string" || !SESSION_STATES.includes(rec.state)) return undefined;
	const pid = optionalNumber(rec.pid);
	if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return undefined;
	const out: MapRecord = { sessionId: rec.sessionId, state: rec.state as SessionState, pid };
	if (typeof rec.terminalId === "string" && rec.terminalId) out.terminalId = rec.terminalId;
	const shellPid = optionalNumber(rec.shellPid);
	if (shellPid !== undefined) out.shellPid = shellPid;
	if (typeof rec.sessionFile === "string" && rec.sessionFile) out.sessionFile = rec.sessionFile;
	if (typeof rec.cwd === "string") out.cwd = rec.cwd;
	const stateAt = optionalNumber(rec.stateAt);
	if (stateAt !== undefined) out.stateAt = stateAt;
	const updatedAt = optionalNumber(rec.updatedAt);
	if (updatedAt !== undefined) out.updatedAt = updatedAt;
	if (typeof rec.owner === "string") out.owner = rec.owner;
	return out;
}

/** A live registry status newer than the hook's last state wins; otherwise the hook state stays. */
export function shouldApplyState(next: number | undefined, current: number | undefined): boolean {
	if (next === undefined) return true;
	if (current === undefined) return true;
	return next >= current;
}

/** Maps `<configDir>/sessions/<pid>.json` to a UI state, or undefined when it says nothing useful. */
export function stateFromLive(live: LiveSession | undefined): SessionState | undefined {
	if (!live) return undefined;
	if (typeof live.waitingFor === "string" && live.waitingFor.trim()) return "waiting";
	switch (live.status?.toLowerCase()) {
		case "busy":
		case "working":
		case "running":
			return "working";
		case "idle":
		case "ready":
			return "idle";
		case "waiting":
			return "waiting";
		default:
			return undefined;
	}
}

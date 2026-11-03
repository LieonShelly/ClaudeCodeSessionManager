import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** A record from `<configDir>/sessions/<pid>.json`, written while a Claude Code process is alive. */
export interface LiveSession {
	pid: number;
	sessionId: string;
	cwd: string;
	name?: string;
	status?: string;
	waitingFor?: string;
	updatedAt?: number;
	statusUpdatedAt?: number;
}

/** Expands a leading `~` only; other tildes belong to the path. */
export function expandHome(value: string, home: string = os.homedir()): string {
	if (value === "~") return home;
	if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(home, value.slice(2));
	return value;
}

/** `CLAUDE_CONFIG_DIR` wins over the default `~/.claude`, matching the Claude Code CLI. */
export function defaultConfigDir(env: NodeJS.ProcessEnv = process.env): string {
	const configured = env.CLAUDE_CONFIG_DIR?.trim();
	return configured ? expandHome(configured) : path.join(os.homedir(), ".claude");
}

export function liveSessionsDir(configDir: string): string {
	return path.join(configDir, "sessions");
}

export function projectsDir(configDir: string): string {
	return path.join(configDir, "projects");
}

export function settingsFile(configDir: string): string {
	return path.join(configDir, "settings.json");
}

/** Parses every `<configDir>/sessions/*.json`; malformed and incomplete files are skipped. */
export function readLiveSessions(configDir: string): LiveSession[] {
	let names: string[];
	try {
		names = fs.readdirSync(liveSessionsDir(configDir));
	} catch {
		return [];
	}
	const out: LiveSession[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		let raw: unknown;
		try {
			raw = JSON.parse(fs.readFileSync(path.join(liveSessionsDir(configDir), name), "utf8"));
		} catch {
			continue;
		}
		if (typeof raw !== "object" || raw === null) continue;
		const rec = raw as Record<string, unknown>;
		if (typeof rec.pid !== "number" || !Number.isInteger(rec.pid) || rec.pid <= 0) continue;
		if (typeof rec.sessionId !== "string" || !rec.sessionId) continue;
		const live: LiveSession = {
			pid: rec.pid,
			sessionId: rec.sessionId,
			cwd: typeof rec.cwd === "string" ? rec.cwd : "",
		};
		if (typeof rec.name === "string") live.name = rec.name;
		if (typeof rec.status === "string") live.status = rec.status;
		if (typeof rec.waitingFor === "string") live.waitingFor = rec.waitingFor;
		if (typeof rec.updatedAt === "number") live.updatedAt = rec.updatedAt;
		if (typeof rec.statusUpdatedAt === "number") live.statusUpdatedAt = rec.statusUpdatedAt;
		out.push(live);
	}
	out.sort((a, b) => a.pid - b.pid);
	return out;
}

export function findLiveSessionByPid(configDir: string, pid: number): LiveSession | undefined {
	return readLiveSessions(configDir).find((session) => session.pid === pid);
}

export function findLiveSessionBySessionId(configDir: string, sessionId: string): LiveSession | undefined {
	return readLiveSessions(configDir).find((session) => session.sessionId === sessionId);
}

/**
 * Finds `<configDir>/projects/<bucket>/<sessionId>.jsonl`. Only the two-level layout
 * counts; subagent transcripts live deeper and belong to their parent session.
 */
export function findTranscriptForSession(configDir: string, sessionId: string): string | undefined {
	let buckets: fs.Dirent[];
	try {
		buckets = fs.readdirSync(projectsDir(configDir), { withFileTypes: true });
	} catch {
		return undefined;
	}
	for (const bucket of buckets) {
		if (!bucket.isDirectory()) continue;
		const file = path.join(projectsDir(configDir), bucket.name, `${sessionId}.jsonl`);
		try {
			if (fs.statSync(file).isFile()) return file;
		} catch {
			// missing in this bucket
		}
	}
	return undefined;
}

export function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM means the process exists but belongs to someone else.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

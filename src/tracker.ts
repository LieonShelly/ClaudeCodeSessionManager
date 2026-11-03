import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import * as vscode from "vscode";
import { findLiveSessionBySessionId, pidAlive, readLiveSessions } from "./claudeFs";
import { claudeExecutable, configDir, normPath } from "./config";
import { isProcessAncestor } from "./processTree";
import { type MapRecord, parseMapRecord, type SessionState, shouldApplyState, stateFromLive } from "./trackerState";

/** Env var the hook reads to tie a session to the terminal that runs it. */
export const TERMINAL_ENV = "CLAUDE_SESSION_MANAGER_TERMINAL";

export type { SessionState } from "./trackerState";

const HOOK_OWNER = "claude-session-manager";
const STATE_KEY = "claudeSession.openSessions";
// Window close can surface as a non-shutdown exit before the extension host stops.
// Removal waits this long so a closing window never forgets its sessions.
const CLOSE_GRACE_MS = 1500;
// Restore waits this long for each terminal's process before opening the next.
const SPAWN_WAIT_MS = 2000;
// Hook events are immediate; the live registry is the fallback when they do not arrive.
const POLL_MS = 3000;
// Claude Code reports its session a second or two after it starts. Silence past this
// means the hooks were not installed or Node is not reachable.
const REPORT_TIMEOUT_MS = 10_000;
// Map files written for Claude Code started by hand in a shell terminal.
const ADOPTED_PREFIX = "pid-";

interface SavedSession {
	sessionId: string;
	sessionFile: string;
	cwd: string;
}

interface Tracked {
	key: string;
	terminal: vscode.Terminal;
	cwd: string;
	sessionId?: string;
	sessionFile?: string;
	state?: SessionState;
	/** Timestamp of the newest state source applied to this entry. */
	stateAt?: number;
	/** The hook or live registry has reported this terminal. */
	reported: boolean;
	/** Launched by this window and not reported within REPORT_TIMEOUT_MS. */
	stalled?: boolean;
	launchedAt?: number;
	/** Timestamp when this terminal entered the working state. */
	workingSince?: number;
}

export interface OpenSession {
	terminal: vscode.Terminal;
	state?: SessionState;
	/** Launched and not yet reported by Claude Code, which takes a few seconds to boot. */
	launching: boolean;
}

export interface StateChange {
	sessionId: string;
	sessionFile?: string;
	terminal: vscode.Terminal;
	previous?: SessionState;
	state: SessionState;
	/** How long the terminal was in the working state, when leaving working. */
	workedMs?: number;
}

export interface LaunchOptions {
	cwd?: string;
	/** Resume this Claude session. A new UUID is generated when both ids are absent. */
	sessionId?: string;
	sessionFile?: string;
	preserveFocus?: boolean;
	/** Overrides the `claudeSession.terminalLocation` setting. */
	location?: "editor" | "panel";
}

function fileExists(file: string): boolean {
	try {
		return fs.statSync(file).isFile();
	} catch {
		return false;
	}
}

function envKey(terminal: vscode.Terminal): string | undefined {
	const opts = terminal.creationOptions;
	const value = "env" in opts ? opts.env?.[TERMINAL_ENV] : undefined;
	return typeof value === "string" && value ? value : undefined;
}

/**
 * Tracks Claude Code terminals in open order and persists them per workspace, so the
 * sessions open when VS Code closed come back in the same order on next start.
 */
export class TerminalTracker implements vscode.Disposable {
	private readonly configDir = configDir();
	private tracked: Tracked[] = [];
	private readonly pids = new Map<vscode.Terminal, number>();
	private readonly pendingClose = new Map<vscode.Terminal, NodeJS.Timeout>();
	private readonly reportTimers = new Set<NodeJS.Timeout>();
	private readonly disposables: vscode.Disposable[] = [];
	private watcher: fs.FSWatcher | undefined;
	private pollTimer: NodeJS.Timeout | undefined;
	/** Launch timings, for diagnosing slow session starts. */
	private readonly log = vscode.window.createOutputChannel("Claude Code Session Manager", { log: true });
	private restoring = false;
	private warnedUnreported = false;
	/**
	 * Saved sessions awaiting an answer to the "ask" restore prompt. save() keeps them in
	 * the saved list, so neither a pending nor a dismissed prompt forgets them.
	 */
	private pendingRestore: SavedSession[] = [];
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;
	private readonly stateChanged = new vscode.EventEmitter<StateChange>();
	readonly onDidChangeState = this.stateChanged.event;

	/** `hookPath`: the bundled hook script; `mapDir`: where the hook writes terminal records. */
	constructor(
		private readonly ctx: vscode.ExtensionContext,
		private readonly hookPath: string,
		private readonly mapDir: string,
	) {}

	async start(): Promise<void> {
		fs.mkdirSync(this.mapDir, { recursive: true });
		this.disposables.push(
			vscode.window.onDidOpenTerminal((t) => void this.notePid(t)),
			vscode.window.onDidCloseTerminal((t) => this.onClose(t)),
		);
		try {
			this.watcher = fs.watch(this.mapDir, (_event, name) => {
				if (name && String(name).endsWith(".json")) void this.applyMapFile(path.join(this.mapDir, String(name))).catch(() => undefined);
			});
			this.watcher.on("error", () => this.watcher?.close());
		} catch {
			// Without a watcher, the live registry poll still updates state.
		}

		// Terminals survive an extension host restart; re-adopt ours before restoring.
		await Promise.all(vscode.window.terminals.map((t) => this.notePid(t)));
		for (const terminal of vscode.window.terminals) {
			const key = envKey(terminal);
			if (key) this.track(terminal, key, "");
		}
		for (const name of fs.readdirSync(this.mapDir)) {
			if (name.endsWith(".json")) await this.applyMapFile(path.join(this.mapDir, name)).catch(() => undefined);
		}
		this.startPolling();

		const saved = this.ctx.workspaceState.get<SavedSession[]>(STATE_KEY) ?? [];
		const open = this.openSessions();
		const toRestore = saved.filter(
			(s) => typeof s?.sessionId === "string" && typeof s?.sessionFile === "string" && fileExists(s.sessionFile) && !open.has(s.sessionId),
		);
		const mode = vscode.workspace.getConfiguration("claudeSession").get<string>("restoreOnStartup", "always");
		if (mode === "always") await this.restore(toRestore);
		else if (mode === "ask" && toRestore.length) this.askRestore(toRestore);
		this.save();
		this.changed.fire();
	}

	/** Claude session id -> terminal and state, for every open Claude terminal. */
	openSessions(): Map<string, OpenSession> {
		const out = new Map<string, OpenSession>();
		for (const t of this.tracked) {
			if (!t.sessionId) continue;
			out.set(t.sessionId, { terminal: t.terminal, state: t.state, launching: !t.reported && !t.stalled });
		}
		return out;
	}

	/**
	 * Focuses the terminal already running this session, or resumes it in a new one.
	 * With `location`, an open terminal also moves there.
	 */
	async open(opts: LaunchOptions): Promise<void> {
		const existing = this.findOpen(opts);
		if (!existing) {
			this.launch(opts);
			return;
		}
		existing.terminal.show(opts.preserveFocus);
		// Both commands act on the active terminal, which show() just set.
		if (opts.location === "panel") await vscode.commands.executeCommand("workbench.action.terminal.moveToTerminalPanel");
		else if (opts.location === "editor") await vscode.commands.executeCommand("workbench.action.terminal.moveToEditor");
	}

	private findOpen(opts: LaunchOptions): OpenSession | undefined {
		const open = this.openSessions();
		if (opts.sessionId) {
			const byId = open.get(opts.sessionId);
			if (byId) return byId;
		}
		if (opts.sessionFile) {
			const wanted = normPath(opts.sessionFile);
			for (const entry of this.tracked) {
				if (entry.sessionFile && normPath(entry.sessionFile) === wanted && entry.sessionId) {
					return open.get(entry.sessionId);
				}
			}
		}
		return undefined;
	}

	/** Starts `claude` for a new session or `claude --resume <id>` for a saved one. */
	private launch(opts: LaunchOptions): vscode.Terminal {
		const launchedAt = Date.now();
		const cfg = vscode.workspace.getConfiguration("claudeSession");
		const key = crypto.randomUUID();
		const sessionId = opts.sessionId ?? (opts.sessionFile ? path.basename(opts.sessionFile, ".jsonl") : crypto.randomUUID());
		const resume = Boolean(opts.sessionId || opts.sessionFile);
		const location = opts.location ?? cfg.get<string>("terminalLocation");
		const inPanel = location === "panel";

		const args: string[] = [];
		for (const arg of cfg.get<unknown[]>("extraArgs", [])) if (typeof arg === "string") args.push(arg);
		if (resume) args.push("--resume", sessionId);
		else args.push("--session-id", sessionId);

		// Merge custom env, but let the terminal key always win.
		const env: Record<string, string> = { [TERMINAL_ENV]: key };
		const customEnv = cfg.get<Record<string, unknown>>("env", {});
		for (const [name, value] of Object.entries(customEnv)) {
			if (typeof value === "string" && name !== TERMINAL_ENV) env[name] = value;
		}

		const iconId = cfg.get<string>("terminalIcon")?.trim() || "sparkle";
		const colorId = cfg.get<string>("terminalColor")?.trim();
		const color = colorId ? new vscode.ThemeColor(colorId) : undefined;

		const terminal = vscode.window.createTerminal({
			// No fixed `name`: the tab follows Claude Code's own title when
			// `terminal.integrated.tabs.title` includes `${sequence}`.
			shellPath: claudeExecutable(),
			shellArgs: args,
			cwd: opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : undefined,
			env,
			iconPath: new vscode.ThemeIcon(iconId, color),
			color,
			// VS Code must not revive these itself; this tracker restores them.
			isTransient: true,
			location: inPanel
				? vscode.TerminalLocation.Panel
				: { viewColumn: vscode.ViewColumn.Active, preserveFocus: opts.preserveFocus },
		});
		if (inPanel) terminal.show(opts.preserveFocus);
		const entry = this.track(terminal, key, opts.cwd ?? "", sessionId, opts.sessionFile);
		entry.launchedAt = launchedAt;
		this.log.info(
			`[${key.slice(0, 8)}] ${resume ? `resume ${sessionId}` : `new session ${sessionId}`} in ${inPanel ? "panel" : "editor"}; terminal created ${this.since(entry)}`,
		);
		void terminal.processId.then((pid) => this.log.info(`[${key.slice(0, 8)}] process ${pid ?? "(none)"} started ${this.since(entry)}`));
		this.watchForReport(entry);
		this.save();
		this.changed.fire();
		return terminal;
	}

	private since(entry: Tracked): string {
		return entry.launchedAt === undefined ? "" : `+${Date.now() - entry.launchedAt}ms`;
	}

	// Launches one at a time: VS Code defers spawning a terminal until its editor is
	// laid out, and a burst of hidden editor terminals at startup can come up blank.
	private async restore(sessions: SavedSession[]): Promise<void> {
		this.restoring = true;
		try {
			for (const s of sessions) {
				if (this.openSessions().has(s.sessionId)) continue;
				// Another VS Code window or a plain terminal may already run this session.
				const live = findLiveSessionBySessionId(this.configDir, s.sessionId);
				if (live && pidAlive(live.pid)) {
					this.log.warn(`Session ${s.sessionId} is already running in pid ${live.pid}; not restoring it here`);
					continue;
				}
				const terminal = this.launch({ cwd: s.cwd, sessionId: s.sessionId, sessionFile: s.sessionFile });
				const spawned = await Promise.race([terminal.processId.then(() => true), sleep(SPAWN_WAIT_MS).then(() => false)]);
				if (!spawned) this.log.warn(`No process ${SPAWN_WAIT_MS}ms after restoring ${s.sessionId}; restoring the next session`);
			}
		} finally {
			this.restoring = false;
		}
	}

	/** Asks without blocking activation. Unanswered sessions stay saved for the next start. */
	private askRestore(sessions: SavedSession[]): void {
		this.pendingRestore = sessions;
		const n = sessions.length;
		const msg = n === 1 ? "Restore 1 Claude Code session?" : `Restore ${n} Claude Code sessions?`;
		void vscode.window.showInformationMessage(msg, "Restore").then(async (choice) => {
			if (choice !== "Restore") return;
			this.pendingRestore = [];
			await this.restore(sessions);
			this.save();
			this.changed.fire();
		});
	}

	/** Warns once per window when a launched Claude Code never reports its session. */
	private watchForReport(entry: Tracked): void {
		const timer = setTimeout(() => {
			this.reportTimers.delete(timer);
			const alive = this.tracked.includes(entry) && entry.terminal.exitStatus === undefined;
			if (!alive || entry.reported) return;
			entry.stalled = true;
			this.changed.fire();
			this.log.warn(`[${entry.key.slice(0, 8)}] Claude Code has not reported ${this.since(entry)}; check the installed hooks`);
			if (this.warnedUnreported) return;
			this.warnedUnreported = true;
			void vscode.window
				.showWarningMessage(
					"Claude Code has not reported its session, so this terminal shows no live status. " +
						"Run \"Claude Session: Install Hooks\" and check that Node.js is on PATH.",
					"Show Log",
				)
				.then((choice) => {
					if (choice) this.log.show();
				});
		}, REPORT_TIMEOUT_MS);
		this.reportTimers.add(timer);
	}

	private track(terminal: vscode.Terminal, key: string, cwd: string, sessionId?: string, sessionFile?: string): Tracked {
		const existing = this.tracked.find((t) => t.terminal === terminal);
		if (existing) {
			if (sessionId) existing.sessionId = sessionId;
			if (sessionFile) existing.sessionFile = sessionFile;
			if (cwd) existing.cwd = cwd;
			return existing;
		}
		const entry: Tracked = { key, terminal, cwd, sessionId, sessionFile, reported: false };
		this.tracked.push(entry);
		return entry;
	}

	private async notePid(terminal: vscode.Terminal): Promise<void> {
		try {
			const pid = await terminal.processId;
			if (pid !== undefined) this.pids.set(terminal, pid);
		} catch {
			// terminal closed before it spawned
		}
	}

	private async pidOf(terminal: vscode.Terminal): Promise<number | undefined> {
		const known = this.pids.get(terminal);
		if (known !== undefined) return known;
		await this.notePid(terminal);
		return this.pids.get(terminal);
	}

	/** Finds the terminal running a manually started Claude Code, by env key or process ancestry. */
	private async adopt(key: string, rec: MapRecord): Promise<Tracked | undefined> {
		for (const terminal of vscode.window.terminals) {
			if (this.tracked.some((t) => t.terminal === terminal)) continue;
			if (key.startsWith(ADOPTED_PREFIX)) {
				const pid = await this.pidOf(terminal);
				if (pid === undefined) continue;
				if (pid !== rec.pid && pid !== rec.shellPid && !(rec.pid !== undefined && (await isProcessAncestor(pid, rec.pid)))) continue;
			} else if (envKey(terminal) !== key) {
				continue;
			}
			const entry = this.track(terminal, key, rec.cwd ?? "", rec.sessionId, rec.sessionFile);
			this.log.info(`[${key.slice(0, 8)}] adopted a terminal started outside the extension`);
			return entry;
		}
		return undefined;
	}

	private async applyMapFile(file: string): Promise<void> {
		const key = path.basename(file, ".json");
		let raw: unknown;
		try {
			raw = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch (err) {
			// A deleted key map means the extension's own terminal exited; a manual terminal
			// may stay open, and then the record is the only thing that goes away.
			const gone = (err as NodeJS.ErrnoException).code === "ENOENT";
			const adopted = this.tracked.find((t) => t.key === key && key.startsWith(ADOPTED_PREFIX));
			if (gone && adopted) this.untrack(adopted);
			return;
		}
		const rec = parseMapRecord(raw);
		if (!rec) return;
		if (rec.owner && rec.owner !== HOOK_OWNER) return;
		if (rec.pid !== undefined && !pidAlive(rec.pid)) {
			// Claude Code is gone (window closed or it crashed); workspace state keeps the session.
			fs.rmSync(file, { force: true });
			return;
		}

		let entry = this.tracked.find((t) => t.key === key);
		if (!entry) entry = await this.adopt(key, rec);
		if (!entry) return;

		const cwd = rec.cwd ?? entry.cwd;
		const moved = entry.sessionId !== rec.sessionId || entry.sessionFile !== rec.sessionFile || (!!rec.cwd && entry.cwd !== cwd);
		const firstReport = !entry.reported;
		entry.reported = true;
		entry.stalled = false;
		if (firstReport && entry.launchedAt !== undefined) this.log.info(`[${key.slice(0, 8)}] reported (${rec.state}) ${this.since(entry)}`);

		if (shouldApplyState(rec.stateAt, entry.stateAt)) {
			entry.sessionId = rec.sessionId;
			if (rec.sessionFile) entry.sessionFile = rec.sessionFile;
			if (rec.cwd) entry.cwd = rec.cwd;
			entry.stateAt = rec.stateAt ?? Date.now();
			this.setState(entry, rec.state);
		}
		if (moved) this.save();
		if (moved || firstReport) this.changed.fire();
	}

	private setState(entry: Tracked, state: SessionState): void {
		const previous = entry.state;
		if (previous === state) return;
		let workedMs: number | undefined;
		if (state === "working") {
			entry.workingSince ??= Date.now();
		} else if (previous === "working" && entry.workingSince !== undefined) {
			workedMs = Date.now() - entry.workingSince;
			entry.workingSince = undefined;
		}
		entry.state = state;
		this.changed.fire();
		if (previous === undefined || !entry.sessionId) return;
		const change: StateChange = { sessionId: entry.sessionId, terminal: entry.terminal, previous, state };
		if (entry.sessionFile) change.sessionFile = entry.sessionFile;
		if (workedMs !== undefined) change.workedMs = workedMs;
		this.stateChanged.fire(change);
	}

	/** Reconciles hook state with `<configDir>/sessions/<pid>.json`; clears waiting after approvals. */
	private startPolling(): void {
		if (this.pollTimer) return;
		this.pollTimer = setInterval(() => this.pollLive(), POLL_MS);
		this.pollTimer.unref?.();
	}

	private pollLive(): void {
		let live;
		try {
			live = readLiveSessions(this.configDir);
		} catch {
			return;
		}
		const byId = new Map(live.map((session) => [session.sessionId, session]));
		for (const entry of [...this.tracked]) {
			if (!entry.sessionId) continue;
			const session = byId.get(entry.sessionId);
			const state = stateFromLive(session);
			if (!session || !state) continue;
			const firstReport = !entry.reported;
			entry.reported = true;
			entry.stalled = false;
			if (session.cwd && !entry.cwd) entry.cwd = session.cwd;
			if (!shouldApplyState(session.statusUpdatedAt, entry.stateAt)) continue;
			entry.stateAt = session.statusUpdatedAt ?? Date.now();
			const before = entry.state;
			this.setState(entry, state);
			if (before !== state || firstReport) this.changed.fire();
		}
	}

	private onClose(terminal: vscode.Terminal): void {
		this.pids.delete(terminal);
		const entry = this.tracked.find((t) => t.terminal === terminal);
		if (!entry || terminal.exitStatus?.reason === vscode.TerminalExitReason.Shutdown) return;
		this.pendingClose.set(
			terminal,
			setTimeout(() => {
				this.pendingClose.delete(terminal);
				this.untrack(entry);
			}, CLOSE_GRACE_MS),
		);
	}

	private untrack(entry: Tracked): void {
		this.tracked = this.tracked.filter((t) => t !== entry);
		fs.rmSync(path.join(this.mapDir, `${entry.key}.json`), { force: true });
		this.save();
		this.changed.fire();
	}

	private save(): void {
		if (this.restoring) return;
		const list: SavedSession[] = [];
		for (const t of this.tracked) {
			if (t.sessionId && t.sessionFile) list.push({ sessionId: t.sessionId, sessionFile: t.sessionFile, cwd: t.cwd });
		}
		// Sessions still awaiting the restore prompt go after the open ones.
		const saved = new Set(list.map((s) => s.sessionId));
		for (const s of this.pendingRestore) if (!saved.has(s.sessionId)) list.push(s);
		void this.ctx.workspaceState.update(STATE_KEY, list);
	}

	dispose(): void {
		// Pending removals are dropped on purpose: disposal means the window is going away.
		for (const timer of this.pendingClose.values()) clearTimeout(timer);
		this.pendingClose.clear();
		for (const timer of this.reportTimers) clearTimeout(timer);
		this.reportTimers.clear();
		if (this.pollTimer) clearInterval(this.pollTimer);
		this.watcher?.close();
		for (const d of this.disposables) d.dispose();
		this.changed.dispose();
		this.stateChanged.dispose();
		this.log.dispose();
	}
}

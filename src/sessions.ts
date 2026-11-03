import * as fs from "node:fs";
import * as path from "node:path";
import { setImmediate } from "node:timers/promises";
import * as vscode from "vscode";
import { normPath, projectsDir } from "./config";

export interface SessionInfo {
	/** The Claude session UUID, from a record or the file name. */
	id: string;
	file: string;
	cwd: string;
	/** Shown in lists; a placeholder when the session is empty. */
	title: string;
	/** No title and no prompt yet. Lists skip these unless `claudeSession.sessions.showEmpty` is on. */
	empty: boolean;
	created: number;
	modified: number;
}

interface CacheEntry {
	mtimeMs: number;
	size: number;
	info: SessionInfo | null;
}

// Titles can land deep in a transcript (`ai-title`), and the first prompt is at the top.
// Reading both ends covers the useful metadata without parsing a multi-megabyte session.
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;
const DEBOUNCE_MS = 1000;
// Files parsed between yields to the event loop during a full scan.
const SCAN_CHUNK = 25;
const EMPTY_TITLE = "(empty session)";
const COMMAND_WRAPPER_RE = /^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr)>/;

function readRange(file: string, start: number, length: number): string {
	if (length <= 0) return "";
	const fd = fs.openSync(file, "r");
	try {
		const buf = Buffer.allocUnsafe(length);
		const n = fs.readSync(fd, buf, 0, length, start);
		return buf.subarray(0, n).toString("utf8");
	} finally {
		fs.closeSync(fd);
	}
}

/** Head lines followed by tail lines. The two may overlap in small files; duplicates are harmless. */
function readLines(file: string): string[] {
	const size = fs.statSync(file).size;
	const head = readRange(file, 0, Math.min(size, HEAD_BYTES));
	if (size <= HEAD_BYTES) return head.split("\n");
	const tail = readRange(file, Math.max(0, size - TAIL_BYTES), Math.min(size, TAIL_BYTES));
	return head.split("\n").concat(tail.split("\n"));
}

function oneLine(text: string, max = 120): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** First human-authored text in a user record, skipping wrappers and tool results. */
function userText(rec: Record<string, unknown>): string | undefined {
	if (rec.isSidechain === true || rec.isMeta === true) return undefined;
	const message = record(rec.message);
	if (!message) return undefined;
	const content = message.content;
	let text = "";
	if (typeof content === "string") text = content;
	else if (Array.isArray(content)) {
		text = content
			.map((part) => {
				const item = record(part);
				return item?.type === "text" && typeof item.text === "string" ? item.text : "";
			})
			.filter(Boolean)
			.join("\n");
	}
	text = text.trim();
	if (!text || COMMAND_WRAPPER_RE.test(text)) return undefined;
	return text;
}

/**
 * Metadata for a Claude transcript. Files with a schema this version does not know still
 * return a listing entry (file name, timestamps) so a Claude update cannot blank the view.
 */
export function parseSession(file: string, mtimeMs: number): SessionInfo | null {
	let lines: string[];
	try {
		lines = readLines(file);
	} catch {
		return null;
	}
	let title = "";
	let firstPrompt = "";
	let lastPrompt = "";
	let cwd = "";
	let sessionId = "";
	let created = NaN;
	for (const line of lines) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		const rec = record(parsed);
		if (!rec) continue;
		if (!cwd && typeof rec.cwd === "string" && rec.cwd) cwd = rec.cwd;
		if (!sessionId && typeof rec.sessionId === "string" && rec.sessionId) sessionId = rec.sessionId;
		if (Number.isNaN(created) && typeof rec.timestamp === "string") {
			const time = Date.parse(rec.timestamp);
			if (Number.isFinite(time)) created = time;
		}
		if (rec.type === "ai-title" && typeof rec.aiTitle === "string" && rec.aiTitle.trim()) {
			// The newest title wins; Claude rewrites it as the conversation evolves.
			title = rec.aiTitle;
		} else if (rec.type === "last-prompt" && typeof rec.lastPrompt === "string" && rec.lastPrompt.trim()) {
			lastPrompt = rec.lastPrompt;
		} else if (!firstPrompt && rec.type === "user") {
			firstPrompt = userText(rec) ?? "";
		}
	}
	const fallback = path.basename(file, ".jsonl");
	const chosen = title.trim() || firstPrompt || lastPrompt.trim();
	return {
		id: sessionId || fallback,
		file,
		cwd,
		title: chosen ? oneLine(chosen) : EMPTY_TITLE,
		empty: !chosen,
		created: Number.isFinite(created) ? created : mtimeMs,
		modified: mtimeMs,
	};
}

export interface SessionIndexOptions {
	root?: string;
	debounceMs?: number;
}

/**
 * Index of top-level Claude sessions (`<root>/<bucket>/*.jsonl`). Subagent transcripts
 * live in `<session-uuid>/subagents/` and are skipped. A transcript may be a symlink,
 * but a bucket that is a symlink is not traversed.
 *
 * `ensure()` scans everything once, in chunks. After that the watcher names each changed
 * file, and only those are re-read. Every running Claude Code appends to its transcript,
 * so a full rescan per change would cost time proportional to the whole history.
 */
export class SessionIndex implements vscode.Disposable {
	private readonly root: string;
	/** `root` with links resolved; set on the first symlinked transcript. */
	private realRoot: string | undefined;
	private readonly debounceMs: number;
	// Keyed by normPath(file).
	private readonly cache = new Map<string, CacheEntry>();
	private sorted: SessionInfo[] | undefined;
	/** The first full scan; set once `ensure()` is called. */
	private scanned: Promise<void> | undefined;
	// Scans and flushes run one at a time, so a rescan never races the first scan.
	private queue: Promise<unknown> = Promise.resolve();
	private readonly pending = new Set<string>();
	private rescan = false;
	private watcher: fs.FSWatcher | undefined;
	private debounce: NodeJS.Timeout | undefined;
	private readonly changed = new vscode.EventEmitter<void>();
	readonly onDidChange = this.changed.event;

	constructor(opts: SessionIndexOptions = {}) {
		this.root = opts.root ?? projectsDir();
		this.debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
		this.watch();
	}

	private watch(): void {
		try {
			this.watcher = fs.watch(this.root, { recursive: true }, (_event, name) => this.onFsEvent(name));
			this.watcher.on("error", () => {
				this.watcher?.close();
				this.watcher = undefined;
			});
		} catch {
			// No projects dir yet; a later rescan starts the watcher once it exists.
		}
	}

	private onFsEvent(name: string | Buffer | null): void {
		if (name === null) {
			this.rescan = true;
		} else {
			const parts = String(name).split(/[\\/]/);
			// A bucket directory itself changed (created, renamed, deleted): its files may go unreported.
			if (parts.length === 1) this.rescan = true;
			else if (parts.length === 2 && parts[1].endsWith(".jsonl")) this.pending.add(path.join(this.root, ...parts));
			else return;
		}
		clearTimeout(this.debounce);
		this.debounce = setTimeout(() => void this.run(() => this.flush()), this.debounceMs);
	}

	private run<T>(job: () => Promise<T>): Promise<T> {
		const next = this.queue.then(job);
		this.queue = next.catch(() => undefined);
		return next;
	}

	private async flush(): Promise<void> {
		const files = [...this.pending];
		this.pending.clear();
		const rescan = this.rescan;
		this.rescan = false;
		// Nothing has been listed yet, so the first scan reads these anyway.
		if (!this.scanned) return;
		let dirty = false;
		if (rescan) dirty = await this.scan();
		else for (const file of files) dirty = this.update(file) || dirty;
		if (!dirty) return;
		this.sorted = undefined;
		this.changed.fire();
	}

	/** Re-reads one session file. Returns whether the listing changed. */
	private update(file: string): boolean {
		const key = normPath(file);
		// Watcher events bypass scan(), so the subagent exclusion lives here too.
		if (path.basename(file).startsWith("agent-")) return this.cache.delete(key);
		let stat: fs.Stats;
		try {
			stat = fs.statSync(file);
			if (!stat.isFile() || this.isAlias(file)) return this.cache.delete(key);
		} catch {
			return this.cache.delete(key);
		}
		const cached = this.cache.get(key);
		if (cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size) return false;
		let info: SessionInfo | null = null;
		try {
			info = parseSession(file, stat.mtimeMs);
		} catch {
			// unreadable; retried on the next change
		}
		this.cache.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, info });
		return !!(info || cached?.info);
	}

	/**
	 * A symlink to a transcript in another bucket, which is listed under its own path.
	 * Claude lists such a pair once. Throws when the link is broken.
	 */
	private isAlias(file: string): boolean {
		if (!fs.lstatSync(file).isSymbolicLink()) return false;
		this.realRoot ??= fs.realpathSync(this.root);
		const rel = path.relative(this.realRoot, fs.realpathSync(file));
		const parts = rel.split(path.sep);
		return parts.length === 2 && parts[0] !== ".." && !path.isAbsolute(rel) && parts[1].endsWith(".jsonl");
	}

	/** Full scan of every bucket, yielding between chunks. Returns whether the listing changed. */
	private async scan(): Promise<boolean> {
		const seen = new Set<string>();
		let dirty = false;
		let parsed = 0;
		let buckets: fs.Dirent[];
		try {
			buckets = fs.readdirSync(this.root, { withFileTypes: true });
		} catch {
			buckets = [];
		}
		for (const bucket of buckets) {
			if (!bucket.isDirectory()) continue;
			const dir = path.join(this.root, bucket.name);
			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of entries) {
				// A symlink's target is checked in update(); subagent transcripts are never top-level.
				if (!(entry.isFile() || entry.isSymbolicLink()) || !entry.name.endsWith(".jsonl")) continue;
				if (entry.name.startsWith("agent-")) continue;
				const file = path.join(dir, entry.name);
				seen.add(normPath(file));
				dirty = this.update(file) || dirty;
				if (++parsed % SCAN_CHUNK === 0) await setImmediate();
			}
		}
		for (const key of this.cache.keys()) {
			if (!seen.has(key)) dirty = this.cache.delete(key) || dirty;
		}
		if (!this.watcher) this.watch();
		return dirty;
	}

	/** Resolves once the first full scan is done; starts it on the first call. */
	ensure(): Promise<void> {
		this.scanned ??= this.run(async () => {
			await this.scan();
			this.sorted = undefined;
		});
		return this.scanned;
	}

	/** Every session scanned so far, empty ones included, most recently modified first. Await `ensure()` first. */
	list(): SessionInfo[] {
		if (!this.sorted) {
			this.sorted = [];
			for (const { info } of this.cache.values()) if (info) this.sorted.push(info);
			this.sorted.sort((a, b) => b.modified - a.modified);
		}
		return this.sorted;
	}

	/** Metadata for one session file; parses it when it is not indexed (e.g. never listed). */
	find(file: string): SessionInfo | undefined {
		const cached = this.cache.get(normPath(file));
		if (cached) return cached.info ?? undefined;
		try {
			return parseSession(file, fs.statSync(file).mtimeMs) ?? undefined;
		} catch {
			return undefined;
		}
	}

	/** The session whose Claude UUID matches, once `ensure()` has run. */
	findBySessionId(id: string): SessionInfo | undefined {
		return this.list().find((session) => session.id === id);
	}

	dispose(): void {
		clearTimeout(this.debounce);
		this.watcher?.close();
		this.changed.dispose();
	}
}

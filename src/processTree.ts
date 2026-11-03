import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 2000;
const CACHE_MS = 5000;

// Pids keep their parent for their lifetime; a short cache keeps an ancestry walk cheap
// when several terminals are reconciled in the same polling tick.
const cache = new Map<number, { value: number | undefined; at: number }>();

async function readParent(pid: number): Promise<number | undefined> {
	if (process.platform === "linux") {
		const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		// Format: pid (comm) state ppid ...; comm may contain spaces and parentheses.
		const after = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
		const ppid = Number.parseInt(after[1] ?? "", 10);
		return Number.isInteger(ppid) && ppid > 0 ? ppid : undefined;
	}
	if (process.platform === "win32") {
		const { stdout } = await execFileAsync(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`],
			{ timeout: TIMEOUT_MS, windowsHide: true },
		);
		const ppid = Number.parseInt(stdout.trim(), 10);
		return Number.isInteger(ppid) && ppid > 0 ? ppid : undefined;
	}
	const { stdout } = await execFileAsync("ps", ["-o", "ppid=", "-p", String(pid)], { timeout: TIMEOUT_MS });
	const ppid = Number.parseInt(stdout.trim(), 10);
	return Number.isInteger(ppid) && ppid > 0 ? ppid : undefined;
}

/** Parent pid, or undefined when the process is gone or the platform call fails. */
export async function parentPid(pid: number): Promise<number | undefined> {
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	const hit = cache.get(pid);
	if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
	let value: number | undefined;
	try {
		value = await readParent(pid);
	} catch {
		value = undefined;
	}
	cache.set(pid, { value, at: Date.now() });
	return value;
}

/** Whether `ancestor` is `descendant` or one of its parents, up to `maxDepth` hops. */
export async function isProcessAncestor(ancestor: number, descendant: number, maxDepth = 16): Promise<boolean> {
	if (ancestor === descendant) return true;
	let current = descendant;
	for (let i = 0; i < maxDepth; i++) {
		const parent = await parentPid(current);
		if (parent === undefined) return false;
		if (parent === ancestor) return true;
		current = parent;
	}
	return false;
}

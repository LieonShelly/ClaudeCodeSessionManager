import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import {
	defaultConfigDir,
	expandHome,
	findLiveSessionByPid,
	findLiveSessionBySessionId,
	findTranscriptForSession,
	pidAlive,
	readLiveSessions,
} from "../src/claudeFs";

const roots: string[] = [];

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csm-live-"));
	roots.push(dir);
	return dir;
}

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value));
}

after(() => {
	for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

test("readLiveSessions parses registry files and ignores malformed ones", () => {
	const dir = tempDir();
	writeJson(path.join(dir, "sessions", "123.json"), {
		pid: 123,
		sessionId: "abc",
		cwd: "/work/a",
		status: "busy",
		statusUpdatedAt: 10,
	});
	writeJson(path.join(dir, "sessions", "456.json"), { pid: "456", sessionId: "def" });
	fs.writeFileSync(path.join(dir, "sessions", "broken.json"), "{oops");

	const sessions = readLiveSessions(dir);
	assert.deepEqual(sessions, [{ pid: 123, sessionId: "abc", cwd: "/work/a", status: "busy", statusUpdatedAt: 10 }]);
});

test("findLiveSessionByPid and findLiveSessionBySessionId locate live records", () => {
	const dir = tempDir();
	writeJson(path.join(dir, "sessions", "123.json"), {
		pid: 123,
		sessionId: "abc",
		cwd: "/work/a",
		status: "waiting",
		waitingFor: "permission prompt",
	});

	assert.equal(findLiveSessionByPid(dir, 123)?.sessionId, "abc");
	assert.equal(findLiveSessionBySessionId(dir, "abc")?.pid, 123);
	assert.equal(findLiveSessionByPid(dir, 999), undefined);
});

test("findTranscriptForSession searches the two-level projects layout", () => {
	const dir = tempDir();
	const file = path.join(dir, "projects", "-work-a", "abc.jsonl");
	writeJson(file, { type: "user" });

	assert.equal(findTranscriptForSession(dir, "abc"), file);
	assert.equal(findTranscriptForSession(dir, "missing"), undefined);
});

test("defaultConfigDir prefers CLAUDE_CONFIG_DIR", () => {
	assert.equal(defaultConfigDir({ CLAUDE_CONFIG_DIR: "/custom/claude" }), "/custom/claude");
	assert.equal(defaultConfigDir({}), path.join(os.homedir(), ".claude"));
});

test("expandHome expands only a leading tilde", () => {
	assert.equal(expandHome("~/x", "/home/u"), path.join("/home/u", "x"));
	assert.equal(expandHome("/a/~/x", "/home/u"), "/a/~/x");
});

test("pidAlive accepts the current process and rejects an unused pid", () => {
	assert.equal(pidAlive(process.pid), true);
	assert.equal(pidAlive(2 ** 30), false);
});

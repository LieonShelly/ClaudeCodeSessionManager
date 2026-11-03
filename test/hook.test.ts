import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { type HookContext, handleHook, mapEvent } from "../src/hook/claude-session-hook";

const roots: string[] = [];

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csm-hook-"));
	roots.push(dir);
	return dir;
}

function context(overrides: Partial<HookContext> = {}): HookContext {
	const dir = tempDir();
	return {
		mapDir: path.join(dir, "terminals"),
		configDir: path.join(dir, "claude"),
		env: {},
		ppid: 4321,
		parentOf: async () => 1200,
		now: () => 1000,
		...overrides,
	};
}

function recordFile(ctx: HookContext, key: string): string {
	return path.join(ctx.mapDir, `${key}.json`);
}

function readRecord(file: string): any {
	return JSON.parse(fs.readFileSync(file, "utf8"));
}

after(() => {
	for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

test("mapEvent follows the state matrix", () => {
	const base = { hook_event_name: "UserPromptSubmit" };
	assert.equal(mapEvent(base), "working");
	assert.equal(mapEvent({ hook_event_name: "PermissionRequest" }), "waiting");
	assert.equal(mapEvent({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" }), "waiting");
	assert.equal(mapEvent({ hook_event_name: "PreToolUse", tool_name: "ExitPlanMode" }), "waiting");
	assert.equal(mapEvent({ hook_event_name: "PreToolUse", tool_name: "Bash" }), undefined);
	assert.equal(mapEvent({ hook_event_name: "PostToolUse", tool_name: "AskUserQuestion" }), "working");
	assert.equal(mapEvent({ hook_event_name: "PostToolUseFailure", is_interrupt: true }), "idle");
	assert.equal(mapEvent({ hook_event_name: "PostToolUseFailure" }), undefined);
	assert.equal(mapEvent({ hook_event_name: "Notification", notification_type: "permission_prompt" }), "waiting");
	assert.equal(mapEvent({ hook_event_name: "Notification", notification_type: "agent_needs_input" }), "waiting");
	assert.equal(mapEvent({ hook_event_name: "Notification", notification_type: "idle_prompt" }), "idle");
	assert.equal(mapEvent({ hook_event_name: "Notification", notification_type: "agent_completed" }), undefined);
	assert.equal(mapEvent({ hook_event_name: "Stop", stop_hook_active: true }), "working");
	assert.equal(mapEvent({ hook_event_name: "Stop", background_tasks: [{}] }), "working");
	assert.equal(mapEvent({ hook_event_name: "Stop" }), "idle");
	assert.equal(mapEvent({ hook_event_name: "StopFailure" }), "idle");
	assert.equal(mapEvent({ hook_event_name: "SubagentStop", agent_id: "a1" }), undefined);
});

test("mapEvent keeps state on compact and deletes on deliberate SessionEnd", () => {
	assert.equal(mapEvent({ hook_event_name: "SessionStart", source: "compact" }, "waiting"), "waiting");
	assert.equal(mapEvent({ hook_event_name: "SessionStart", source: "resume" }, "waiting"), "idle");
	assert.equal(mapEvent({ hook_event_name: "SessionEnd", reason: "prompt_input_exit" }), "delete");
	assert.equal(mapEvent({ hook_event_name: "SessionEnd", reason: "clear" }), "delete");
	assert.equal(mapEvent({ hook_event_name: "SessionEnd", reason: "resume" }), "delete");
	assert.equal(mapEvent({ hook_event_name: "SessionEnd", reason: "other" }), undefined);
});

test("handleHook writes a record under the env terminal key", async () => {
	const ctx = context({ env: { CLAUDE_SESSION_MANAGER_TERMINAL: "term-1" } });
	const transcript = path.join(ctx.configDir, "projects", "-work", "sess-1.jsonl");
	fs.mkdirSync(path.dirname(transcript), { recursive: true });
	fs.writeFileSync(transcript, "{}\n");

	const outcome = await handleHook(
		{
			hook_event_name: "SessionStart",
			session_id: "sess-1",
			transcript_path: transcript,
			cwd: "/work",
		},
		ctx,
	);
	assert.equal(outcome.kind, "write");
	const file = recordFile(ctx, "term-1");
	assert.deepEqual(readRecord(file), {
		terminalId: "term-1",
		pid: 4321,
		shellPid: 1200,
		sessionFile: transcript,
		sessionId: "sess-1",
		cwd: "/work",
		state: "idle",
		stateAt: 1000,
		updatedAt: 1000,
		owner: "claude-session-manager",
	});
});

test("handleHook falls back to a pid key and finds the claude pid from the live registry", async () => {
	const ctx = context();
	const registry = path.join(ctx.configDir, "sessions", "999.json");
	fs.mkdirSync(path.dirname(registry), { recursive: true });
	fs.writeFileSync(registry, JSON.stringify({ pid: 999, sessionId: "sess-9", cwd: "/work" }));

	const outcome = await handleHook(
		{ hook_event_name: "UserPromptSubmit", session_id: "sess-9", transcript_path: "/t.jsonl", cwd: "/work" },
		ctx,
	);
	assert.equal(outcome.kind, "write");
	assert.equal(outcome.kind === "write" ? outcome.record.pid : undefined, 999);
	assert.equal(outcome.kind === "write" ? outcome.record.shellPid : undefined, 1200);
	assert.ok(fs.existsSync(recordFile(ctx, "pid-999")));
});

test("handleHook preserves state on compact", async () => {
	const ctx = context({ env: { CLAUDE_SESSION_MANAGER_TERMINAL: "term-2" } });
	fs.mkdirSync(ctx.mapDir, { recursive: true });
	fs.writeFileSync(
		recordFile(ctx, "term-2"),
		JSON.stringify({ pid: 1, terminalId: "term-2", sessionId: "s", sessionFile: "/t.jsonl", cwd: "/w", state: "waiting", stateAt: 5 }),
	);

	const outcome = await handleHook(
		{ hook_event_name: "SessionStart", source: "compact", session_id: "s", transcript_path: "/t.jsonl", cwd: "/w" },
		ctx,
	);
	assert.equal(outcome.kind, "write");
	assert.equal(outcome.kind === "write" ? outcome.record.state : undefined, "waiting");
	assert.equal(outcome.kind === "write" ? outcome.record.stateAt : undefined, 1000);
});

test("handleHook deletes on deliberate exit and keeps the record otherwise", async () => {
	const ctx = context({ env: { CLAUDE_SESSION_MANAGER_TERMINAL: "term-3" } });
	fs.mkdirSync(ctx.mapDir, { recursive: true });
	const file = recordFile(ctx, "term-3");
	fs.writeFileSync(file, JSON.stringify({ terminalId: "term-3", sessionId: "s", sessionFile: "/t.jsonl", cwd: "/w", state: "idle" }));

	const kept = await handleHook(
		{ hook_event_name: "SessionEnd", reason: "other", session_id: "s", transcript_path: "/t.jsonl", cwd: "/w" },
		ctx,
	);
	assert.equal(kept.kind, "ignore");
	assert.equal(fs.existsSync(file), true);

	const gone = await handleHook(
		{ hook_event_name: "SessionEnd", reason: "prompt_input_exit", session_id: "s", transcript_path: "/t.jsonl", cwd: "/w" },
		ctx,
	);
	assert.equal(gone.kind, "delete");
	assert.equal(fs.existsSync(file), false);
});

test("handleHook ignores subagent payloads", async () => {
	const ctx = context({ env: { CLAUDE_SESSION_MANAGER_TERMINAL: "term-4" } });
	const outcome = await handleHook(
		{ hook_event_name: "UserPromptSubmit", session_id: "s", agent_id: "a1", agent_type: "explore", cwd: "/w" },
		ctx,
	);
	assert.equal(outcome.kind, "ignore");
	assert.equal(fs.existsSync(recordFile(ctx, "term-4")), false);
});

test("the hook CLI is silent and exits 0 on bad input", () => {
	const cli = path.join(__dirname, "..", "src", "hook", "claude-session-hook.js");
	const ctx = context();
	const result = spawnSync(process.execPath, [cli, "--map-dir", ctx.mapDir, "--config-dir", ctx.configDir], {
		input: "{not json",
		encoding: "utf8",
	});
	assert.equal(result.status, 0);
	assert.equal(result.stdout, "");
	assert.equal(result.stderr, "");
});

test("the hook CLI writes a record from stdin", () => {
	const cli = path.join(__dirname, "..", "src", "hook", "claude-session-hook.js");
	const dir = tempDir();
	const mapDir = path.join(dir, "terminals");
	const configDir = path.join(dir, "claude");
	const result = spawnSync(
		process.execPath,
		[cli, "--map-dir", mapDir, "--config-dir", configDir],
		{
			input: JSON.stringify({
				hook_event_name: "UserPromptSubmit",
				session_id: "cli-session",
				transcript_path: path.join(dir, "t.jsonl"),
				cwd: "/work",
			}),
			encoding: "utf8",
			env: { ...process.env, CLAUDE_SESSION_MANAGER_TERMINAL: "cli-key" },
		},
	);
	assert.equal(result.status, 0);
	assert.equal(result.stdout, "");
	assert.equal(result.stderr, "");
	const record = readRecord(path.join(mapDir, "cli-key.json"));
	assert.equal(record.state, "working");
	assert.equal(record.sessionId, "cli-session");
});

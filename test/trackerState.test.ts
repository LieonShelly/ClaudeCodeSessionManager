import * as assert from "node:assert/strict";
import { test } from "node:test";
import { parseMapRecord, shouldApplyState, stateFromLive } from "../src/trackerState";

test("stateFromLive maps the live registry status", () => {
	assert.equal(stateFromLive({ pid: 1, sessionId: "s", cwd: "/w", status: "busy" }), "working");
	assert.equal(stateFromLive({ pid: 1, sessionId: "s", cwd: "/w", status: "working" }), "working");
	assert.equal(stateFromLive({ pid: 1, sessionId: "s", cwd: "/w", status: "idle" }), "idle");
	assert.equal(stateFromLive({ pid: 1, sessionId: "s", cwd: "/w", status: "waiting" }), "waiting");
	assert.equal(stateFromLive({ pid: 1, sessionId: "s", cwd: "/w", status: "unknown" }), undefined);
});

test("stateFromLive treats waitingFor as waiting even while the process is busy", () => {
	assert.equal(stateFromLive({ pid: 1, sessionId: "s", cwd: "/w", status: "busy", waitingFor: "permission prompt" }), "waiting");
	assert.equal(stateFromLive({ pid: 1, sessionId: "s", cwd: "/w", status: "busy", waitingFor: "" }), "working");
});

test("shouldApplyState only moves forward in time", () => {
	assert.equal(shouldApplyState(10, undefined), true);
	assert.equal(shouldApplyState(10, 5), true);
	assert.equal(shouldApplyState(10, 10), true);
	assert.equal(shouldApplyState(5, 10), false);
	assert.equal(shouldApplyState(undefined, 10), true);
});

test("parseMapRecord accepts hook records and rejects incomplete ones", () => {
	const record = parseMapRecord({
		pid: 123,
		shellPid: 100,
		sessionId: "sess-1",
		sessionFile: "/p/sess-1.jsonl",
		cwd: "/work",
		state: "waiting",
		stateAt: 20,
		owner: "claude-session-manager",
	});
	assert.deepEqual(record, {
		pid: 123,
		shellPid: 100,
		sessionId: "sess-1",
		sessionFile: "/p/sess-1.jsonl",
		cwd: "/work",
		state: "waiting",
		stateAt: 20,
		owner: "claude-session-manager",
	});

	assert.equal(parseMapRecord({ sessionId: "s", state: "idle" }), undefined);
	assert.equal(parseMapRecord({ pid: 1, state: "idle" }), undefined);
	assert.equal(parseMapRecord({ pid: 1, sessionId: "s", state: "busy" }), undefined);
	assert.equal(parseMapRecord(null), undefined);
});

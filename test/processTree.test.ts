import * as assert from "node:assert/strict";
import { test } from "node:test";
import { isProcessAncestor, parentPid } from "../src/processTree";

test("parentPid finds the parent of the current process", async () => {
	assert.equal(await parentPid(process.pid), process.ppid);
	assert.equal(await parentPid(2 ** 30), undefined);
});

test("isProcessAncestor treats a process as its own ancestor", async () => {
	assert.equal(await isProcessAncestor(process.pid, process.pid), true);
});

test("isProcessAncestor recognises the current parent and rejects unrelated pids", async () => {
	assert.equal(await isProcessAncestor(process.ppid, process.pid), true);
	assert.equal(await isProcessAncestor(2 ** 30, process.pid), false);
});

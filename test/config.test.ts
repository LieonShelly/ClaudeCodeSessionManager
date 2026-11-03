import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { claudeExecutable, configDir, isWithin, liveSessionsDir, projectsDir } from "../src/config";

const roots: string[] = [];

function tempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csm-config-"));
	roots.push(dir);
	return dir;
}

after(() => {
	for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

test("configDir honours CLAUDE_CONFIG_DIR and expands a leading tilde", () => {
	const previous = process.env.CLAUDE_CONFIG_DIR;
	try {
		process.env.CLAUDE_CONFIG_DIR = "~/custom-claude";
		assert.equal(configDir(), path.join(os.homedir(), "custom-claude"));
		assert.equal(projectsDir(), path.join(os.homedir(), "custom-claude", "projects"));
		assert.equal(liveSessionsDir(), path.join(os.homedir(), "custom-claude", "sessions"));
	} finally {
		if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
		else process.env.CLAUDE_CONFIG_DIR = previous;
	}
});

test("claudeExecutable resolves a bare command on PATH", { skip: process.platform === "win32" }, () => {
	const dir = tempDir();
	const executable = path.join(dir, "claude");
	fs.writeFileSync(executable, "#!/bin/sh\n");
	fs.chmodSync(executable, 0o755);
	const previous = process.env.PATH;
	try {
		process.env.PATH = dir;
		assert.equal(claudeExecutable(), executable);
	} finally {
		process.env.PATH = previous;
	}
});

test("isWithin is separator-aware and normalizes paths", () => {
	assert.equal(isWithin("/work/proj/sub", "/work/proj"), true);
	assert.equal(isWithin("/work/proj", "/work/proj"), true);
	assert.equal(isWithin("/work/project", "/work/proj"), false);
});

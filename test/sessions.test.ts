import assert = require("node:assert/strict");
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { parseSession, SessionIndex } from "../src/sessions";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "csm-sessions-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

let n = 0;

function lines(...records: unknown[]): string {
	return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function userLine(text: string, extra: Record<string, unknown> = {}): string {
	return JSON.stringify({
		type: "user",
		sessionId: "sess-default",
		cwd: "/work/proj",
		timestamp: "2026-09-23T01:18:39.373Z",
		...extra,
		message: { role: "user", content: text },
	});
}

function writeFile(file: string, content: string): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	return file;
}

function parse(content: string, name = `${++n}.jsonl`) {
	return parseSession(writeFile(path.join(tmp, "parse", name), content), 1000);
}

test("parseSession prefers the newest ai-title over prompts", () => {
	const file = parse(
		lines(
			JSON.parse(userLine("first prompt")),
			{ type: "last-prompt", lastPrompt: "last prompt" },
			{ type: "ai-title", aiTitle: "Older title" },
			{ type: "ai-title", aiTitle: "Newest title" },
		),
	);
	assert.equal(file?.title, "Newest title");
	assert.equal(file?.empty, false);
});

test("parseSession falls back to the first prompt, then last-prompt", () => {
	assert.equal(parse(lines(JSON.parse(userLine("first prompt")), { type: "last-prompt", lastPrompt: "later" }))?.title, "first prompt");
	assert.equal(parse(lines({ type: "last-prompt", lastPrompt: "later" }))?.title, "later");
});

test("parseSession reads array content and skips sidechains, meta, tool results, and command wrappers", () => {
	const file = parse(
		lines(
			JSON.parse(
				JSON.stringify({
					type: "user",
					sessionId: "sess-1",
					cwd: "/work/proj",
					message: { role: "user", content: [{ type: "text", text: "sidechain" }] },
					isSidechain: true,
				}),
			),
			JSON.parse(JSON.stringify({ type: "user", message: { role: "user", content: "meta" }, isMeta: true })),
			{
				type: "user",
				message: { role: "user", content: [{ type: "tool_result", content: "tool output" }] },
			},
			{ type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } },
			{
				type: "user",
				message: { role: "user", content: [{ type: "text", text: "real first prompt" }] },
			},
		),
	);
	assert.equal(file?.title, "real first prompt");
});

test("parseSession reads id, cwd, and creation time", () => {
	const info = parse(lines(JSON.parse(userLine("hello", { sessionId: "abc-123", cwd: "/work/other" }))))!;
	assert.equal(info.id, "abc-123");
	assert.equal(info.cwd, "/work/other");
	assert.equal(info.created, Date.parse("2026-09-23T01:18:39.373Z"));
	assert.equal(info.modified, 1000);
});

test("parseSession falls back to the file name when records carry no sessionId", () => {
	const info = parse(lines({ type: "file-history-snapshot", cwd: "/w" }), "from-name.jsonl");
	assert.equal(info?.id, "from-name");
	assert.equal(info?.cwd, "/w");
});

test("parseSession lists unknown records as an empty session instead of hiding them", () => {
	const info = parse('{"type":"something-new"}\n');
	assert.ok(info);
	assert.equal(info?.empty, true);
	assert.equal(info?.title, "(empty session)");
});

test("parseSession flattens and truncates prompts", () => {
	assert.equal(parse(lines(JSON.parse(userLine('say "hi"\n  twice'))))?.title, 'say "hi" twice');
	const long = "x".repeat(200);
	const title = parse(lines(JSON.parse(userLine(long))))?.title ?? "";
	assert.equal(title.length, 120);
	assert.ok(title.endsWith("…"));
});

test("parseSession finds an ai-title beyond the head window", () => {
	const filler = Array.from({ length: 200 }, () => JSON.stringify({ type: "file-history-snapshot", data: "x".repeat(500) }));
	const content = lines(JSON.parse(userLine("prompt at the top")), ...filler.map((line) => JSON.parse(line)), {
		type: "ai-title",
		aiTitle: "Title from the tail",
	});
	assert.equal(parse(content)?.title, "Title from the tail");
});

test("parseSession uses the file name for id when a record has none", () => {
	const info = parse(`${JSON.stringify({ type: "ai-title", aiTitle: "T" })}\n`, "session-uuid.jsonl");
	assert.equal(info?.id, "session-uuid");
});

function nextChange(index: SessionIndex): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("no change event within 5s")), 5000);
		const sub = index.onDidChange(() => {
			clearTimeout(timer);
			sub.dispose();
			resolve();
		});
	});
}

function titled(title: string, sessionId?: string): string {
	return lines({ type: "ai-title", aiTitle: title, ...(sessionId ? { sessionId } : {}) });
}

test("SessionIndex follows adds, edits, and deletes, ignoring agent transcripts", async () => {
	const root = path.join(tmp, "index");
	const bucket = path.join(root, "-work-proj");
	const a = writeFile(path.join(bucket, "a.jsonl"), titled("A", "sess-a"));
	const index = new SessionIndex({ root, debounceMs: 50 });
	try {
		await index.ensure();
		assert.deepEqual(
			index.list().map((s) => s.title),
			["A"],
		);

		let change = nextChange(index);
		writeFile(path.join(bucket, "a", "subagents", "agent-1.jsonl"), titled("Subagent"));
		writeFile(path.join(bucket, "agent-top.jsonl"), titled("Top-level agent"));
		const b = writeFile(path.join(bucket, "b.jsonl"), titled("B", "sess-b"));
		fs.utimesSync(b, new Date(), new Date(Date.now() + 60_000));
		await change;
		assert.deepEqual(
			index.list().map((s) => s.title),
			["B", "A"],
		);
		assert.equal(index.findBySessionId("sess-b")?.file, b);

		change = nextChange(index);
		fs.writeFileSync(a, titled("A renamed", "sess-a"));
		fs.utimesSync(a, new Date(), new Date(Date.now() + 120_000));
		await change;
		assert.deepEqual(
			index.list().map((s) => s.title),
			["A renamed", "B"],
		);

		change = nextChange(index);
		fs.rmSync(b);
		await change;
		assert.deepEqual(
			index.list().map((s) => s.title),
			["A renamed"],
		);
		assert.equal(index.find(b), undefined);
		assert.equal(index.findBySessionId("sess-b"), undefined);
	} finally {
		index.dispose();
	}
});

test("SessionIndex.find parses a file it has not listed without adding it to the list", async () => {
	const root = path.join(tmp, "find");
	const listed = writeFile(path.join(root, "bucket", "listed.jsonl"), titled("Listed", "sess-listed"));
	const index = new SessionIndex({ root, debounceMs: 50 });
	try {
		await index.ensure();
		assert.equal(index.list().length, 1);
		const outside = writeFile(path.join(tmp, "elsewhere", "x.jsonl"), titled("Elsewhere", "sess-outside"));
		assert.equal(index.find(outside)?.title, "Elsewhere");
		assert.equal(index.find(listed)?.title, "Listed");
		assert.deepEqual(
			index.list().map((s) => s.title),
			["Listed"],
		);
	} finally {
		index.dispose();
	}
});

test("SessionIndex lists symlinked transcripts once and skips symlinked buckets", async (t) => {
	const root = path.join(tmp, "links");
	const elsewhere = writeFile(path.join(tmp, "links-target", "moved.jsonl"), titled("Linked", "sess-linked"));
	const own = writeFile(path.join(root, "a", "own.jsonl"), titled("Own", "sess-own"));
	try {
		fs.symlinkSync(elsewhere, path.join(root, "a", "linked.jsonl"), "file");
	} catch (err) {
		// Windows needs Developer Mode or admin rights for symlinks.
		if ((err as NodeJS.ErrnoException).code === "EPERM") return t.skip("symlinks not permitted");
		throw err;
	}
	fs.mkdirSync(path.join(root, "b"));
	fs.symlinkSync(own, path.join(root, "b", "alias.jsonl"), "file");
	fs.symlinkSync(path.dirname(elsewhere), path.join(root, "linked-bucket"), "junction");
	fs.symlinkSync(path.join(tmp, "missing.jsonl"), path.join(root, "b", "broken.jsonl"), "file");
	const index = new SessionIndex({ root, debounceMs: 50 });
	try {
		await index.ensure();
		assert.deepEqual(index.list().map((s) => s.title).sort(), ["Linked", "Own"]);
	} finally {
		index.dispose();
	}
});

import * as path from "node:path";
import * as vscode from "vscode";
import { findLiveSessionBySessionId, pidAlive } from "./claudeFs";
import { claudeSettingsPath, configDir } from "./config";
import { ensureHooksInstalled, removeInstalledHooks, SettingsError } from "./hooksInstall";
import { SessionIndex, type SessionInfo } from "./sessions";
import { systemNotify } from "./systemNotify";
import { type StateChange, TerminalTracker } from "./tracker";
import { ClaudeViewProvider, workspaceSessions } from "./views";

/** What `data-vscode-context` on a session row passes to its context menu commands. */
interface SessionContext {
	file?: unknown;
	id?: unknown;
}

const HOOK_NOTICE_KEY = "claudeSession.hooksNotified";

function sessionFileOf(arg: SessionContext | undefined): string | undefined {
	return typeof arg?.file === "string" ? arg.file : undefined;
}

function sessionIdOf(arg: SessionContext | undefined): string | undefined {
	return typeof arg?.id === "string" ? arg.id : undefined;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const index = new SessionIndex();
	const mapDir = path.join(context.globalStorageUri.fsPath, "terminals");
	const hookPath = context.asAbsolutePath("out/hook/claude-session-hook.js");
	const tracker = new TerminalTracker(context, hookPath, mapDir);

	// Hooks live in the user settings file; installing them is idempotent and preserves every
	// unrelated setting. A failure must not stop the sidebar from listing and resuming sessions.
	const hooksTargets = () => ({
		settingsFile: claudeSettingsPath(),
		hookPath,
		mapDir,
		configDir: configDir(),
		nodePath: vscode.workspace.getConfiguration("claudeSession").get<string>("hooks.nodePath")?.trim() || undefined,
	});
	const explainHookError = (err: unknown) => {
		const detail = err instanceof SettingsError ? err.message : err instanceof Error ? err.message : String(err);
		void vscode.window
			.showWarningMessage(`Could not update Claude Code hooks: ${detail}`, "Open Settings")
			.then((choice) => {
				if (choice) void vscode.commands.executeCommand("workbench.action.openSettings", "claudeSession.hooks.nodePath");
			});
	};
	const installHooks = (interactive: boolean) => {
		try {
			const result = ensureHooksInstalled(hooksTargets());
			if (interactive) {
				const text =
					result.status === "unchanged"
						? "Claude Code hooks are already installed."
						: `Claude Code hooks ${result.status === "updated" ? "updated" : "installed"} in ${result.file}.`;
				void vscode.window.showInformationMessage(text);
			} else if ((result.status === "installed" || result.status === "updated") && !context.globalState.get<boolean>(HOOK_NOTICE_KEY)) {
				void context.globalState.update(HOOK_NOTICE_KEY, true);
				void vscode.window.showInformationMessage(
					`Claude Code Session Manager ${result.status === "updated" ? "updated" : "installed"} its status hooks in ${result.file}.`,
				);
			}
		} catch (err) {
			explainHookError(err);
		}
	};
	const removeHooks = (interactive: boolean) => {
		try {
			const result = removeInstalledHooks(claudeSettingsPath());
			if (interactive || result.status === "removed") {
				const text =
					result.status === "absent"
						? "No Claude Code settings file found."
						: result.status === "unchanged"
							? "No Claude Code Session Manager hooks were installed."
							: "Claude Code Session Manager hooks removed.";
				void vscode.window.showInformationMessage(text);
			}
		} catch (err) {
			explainHookError(err);
		}
	};

	installHooks(false);

	const newSession = async () => {
		const config = vscode.workspace.getConfiguration("claudeSession");
		const mode = config.get<string>("newSessionCwd", "workspaceRoot");
		const folders = vscode.workspace.workspaceFolders ?? [];
		if (mode === "ask") {
			const picked = await vscode.window.showOpenDialog({
				canSelectFiles: false,
				canSelectFolders: true,
				defaultUri: folders[0]?.uri,
				openLabel: "Start Claude Code here",
			});
			if (picked?.[0]) await tracker.open({ cwd: picked[0].fsPath });
			return;
		}
		const doc = vscode.window.activeTextEditor?.document;
		if (mode === "activeFileFolder" && doc?.uri.scheme === "file") {
			await tracker.open({ cwd: path.dirname(doc.uri.fsPath) });
			return;
		}
		if (folders.length <= 1) {
			await tracker.open({ cwd: folders[0]?.uri.fsPath });
			return;
		}
		const picked = await vscode.window.showWorkspaceFolderPick({ placeHolder: "Start Claude Code in which folder?" });
		if (picked) await tracker.open({ cwd: picked.uri.fsPath });
	};

	const openIn = (location: "editor" | "panel") => (arg: SessionContext | undefined) => {
		const file = sessionFileOf(arg);
		const id = sessionIdOf(arg);
		const info = (file ? index.find(file) : undefined) ?? (id ? index.findBySessionId(id) : undefined);
		if (id || file) return tracker.open({ sessionId: id ?? info?.id, sessionFile: file ?? info?.file, cwd: info?.cwd, location });
	};

	// A session that stops working in a terminal you are not looking at gets a notification.
	// `activeTerminal` outlives focus moving to a file, so a terminal tab must also be showing.
	// A panel terminal has no tab and counts as not looked at. A question also notifies from
	// idle: Claude Code ends the turn before it opens a plan review.
	const notify = ({ sessionId, sessionFile, terminal, previous, state, workedMs }: StateChange) => {
		if (previous === undefined || state === "working" || (state === "idle" && previous !== "working")) return;
		const config = vscode.workspace.getConfiguration("claudeSession");
		if (state === "waiting" ? !config.get<boolean>("notify.onInput", true) : !config.get<boolean>("notify.onFinish", true)) return;
		// Questions always notify; a quick reply finishing does not.
		const minMs = Math.max(0, config.get<number>("notify.minWorkSeconds", 10)) * 1000;
		if (state === "idle" && workedMs !== undefined && workedMs < minMs) return;
		const focused = vscode.window.state.focused;
		const terminalTabShown = vscode.window.tabGroups.all.some((g) => g.activeTab?.input instanceof vscode.TabInputTerminal);
		if (focused && vscode.window.activeTerminal === terminal && terminalTabShown) return;

		const info = (sessionFile ? index.find(sessionFile) : undefined) ?? index.findBySessionId(sessionId);
		const title = info?.title ?? "Claude Code session";
		const text = state === "waiting" ? `"${title}" needs input` : `"${title}" finished`;
		const showInVsCode = () =>
			void vscode.window.showInformationMessage(text, "Show").then((choice) => {
				if (choice) terminal.show();
			});
		const style = config.get<string>("notify.style", "vscode");
		// A system notification is for when VS Code is in the background; a focused window gets its own.
		if (style === "vscode" || focused) {
			showInVsCode();
			return;
		}
		if (style === "both") showInVsCode();
		void systemNotify(vscode.env.appName, state === "waiting" ? "Claude Code needs input" : "Claude Code finished", title).then((shown) => {
			if (!shown && style === "system") showInVsCode();
		});
	};

	// Cycles through waiting sessions in tab order, starting after the active terminal.
	const focusNextWaiting = () => {
		const open = [...tracker.openSessions().values()];
		const active = open.findIndex((s) => s.terminal === vscode.window.activeTerminal);
		const next = open.find((s, i) => i > active && s.state === "waiting") ?? open.find((s) => s.state === "waiting");
		if (next) next.terminal.show();
		else void vscode.window.showInformationMessage("No Claude Code session needs input.");
	};

	const view = new ClaudeViewProvider(index, tracker, (cwd) => void (cwd ? tracker.open({ cwd }) : newSession()));

	context.subscriptions.push(
		index,
		tracker,
		view,
		tracker.onDidChangeState(notify),
		vscode.commands.registerCommand("claudeSession.focusNextWaiting", focusNextWaiting),
		vscode.window.registerWebviewViewProvider("claudeSession.main", view),
		vscode.commands.registerCommand("claudeSession.newSession", newSession),
		// The same command with the Claude icon, for the editor tab bar.
		vscode.commands.registerCommand("claudeSession.newSessionFromEditorTitle", newSession),
		vscode.commands.registerCommand("claudeSession.refresh", () => view.refreshSessions(true)),
		vscode.commands.registerCommand("claudeSession.hooks.install", () => installHooks(true)),
		vscode.commands.registerCommand("claudeSession.hooks.remove", () => removeHooks(true)),
		vscode.commands.registerCommand("claudeSession.resumeSession", async () => {
			const sortByCreated = vscode.workspace.getConfiguration("claudeSession").get<string>("sessions.sortBy") === "created";
			// The picker opens at once and shows a busy bar until the first scan finishes.
			const picked = await vscode.window.showQuickPick<vscode.QuickPickItem & { session: SessionInfo }>(
				index.ensure().then(() =>
					workspaceSessions(index).map((s) => ({
						label: s.title,
						description: new Date(sortByCreated ? s.created : s.modified).toLocaleString(),
						detail: s.cwd,
						session: s,
					})),
				),
				{ placeHolder: "Resume a Claude Code session", matchOnDetail: true },
			);
			if (picked) await tracker.open({ sessionId: picked.session.id, sessionFile: picked.session.file, cwd: picked.session.cwd });
		}),
		vscode.commands.registerCommand("claudeSession.session.openInEditor", openIn("editor")),
		vscode.commands.registerCommand("claudeSession.session.openInPanel", openIn("panel")),
		vscode.commands.registerCommand("claudeSession.session.copyId", (arg?: SessionContext) => {
			const id = sessionIdOf(arg);
			if (id) return vscode.env.clipboard.writeText(id);
		}),
		vscode.commands.registerCommand("claudeSession.session.copyPath", (arg?: SessionContext) => {
			const file = sessionFileOf(arg);
			if (file) return vscode.env.clipboard.writeText(file);
		}),
		vscode.commands.registerCommand("claudeSession.session.reveal", (arg?: SessionContext) => {
			const file = sessionFileOf(arg);
			if (file) return vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(file));
		}),
		vscode.commands.registerCommand("claudeSession.session.delete", async (arg?: SessionContext) => {
			const file = sessionFileOf(arg);
			const id = sessionIdOf(arg);
			if (!file) return;
			const running = id ? findLiveSessionBySessionId(configDir(), id) : undefined;
			if ((id && tracker.openSessions().has(id)) || (running && pidAlive(running.pid))) {
				void vscode.window.showWarningMessage("Stop this Claude Code session before deleting it.");
				return;
			}
			const title = index.find(file)?.title ?? file;
			const ok = await vscode.window.showWarningMessage(
				`Delete "${title}"?`,
				{ modal: true, detail: "The transcript and its subagent transcripts move to the trash." },
				"Delete",
			);
			if (ok !== "Delete") return;
			// Subagent transcripts live in a sibling directory named like the file without `.jsonl`.
			const dir = file.replace(/\.jsonl$/, "");
			for (const target of [file, dir]) {
				try {
					await vscode.workspace.fs.delete(vscode.Uri.file(target), { recursive: true, useTrash: true });
				} catch (err) {
					if (!(err instanceof vscode.FileSystemError && err.code === "FileNotFound")) throw err;
				}
			}
		}),
	);

	await tracker.start();

	if (vscode.workspace.getConfiguration("claudeSession").get<boolean>("focusOnStartup", true)) {
		void vscode.commands.executeCommand("workbench.view.extension.claudeSession");
	}
}

export function deactivate(): void {
	// Disposables registered in context.subscriptions handle shutdown.
}

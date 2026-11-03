# Claude Code Session Manager

A VS Code sidebar for [Claude Code](https://claude.com/claude-code): browse your session history, resume any session in an editor terminal tab, watch live status, and get the same tabs back after a restart.

- **Session history.** Lists your Claude Code sessions for the current workspace, or all of them, grouped by date or folder. Groups collapse, and a folder group's `+` starts a new session there. Click a session to resume it in a terminal.
- **Live status.** Each open session shows whether it is idle, working, or waiting on your answer. Notifies you, in VS Code or through the OS, when a background session finishes or asks a question.
- **Restore on startup.** Reopens the Claude Code sessions that were open when VS Code closed, in the same tab order. Can ask first.
- **Context menu.** Open in editor or panel, copy the session id or file path, reveal the session file, delete a closed session.

## Requirements

- VS Code 1.90 or later.
- `claude` on your `PATH`, or its absolute path in `claudeSession.executable`.
- Node.js on your `PATH` for the status hooks, or its absolute path in `claudeSession.hooks.nodePath`.

## Install

Install the `.vsix` from a [GitHub release](https://github.com/MYSTRAVIL/vscode-claude-session-manager/releases):

```sh
code --install-extension claude-session-manager-<version>.vsix
```

The first activation adds its hooks to your user-level Claude Code settings (`~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json`) and tells you once. The merge is idempotent and keeps every unrelated setting and hook. Run **Claude Code: Install Hooks** to reinstall them, or **Claude Code: Remove Hooks** before uninstalling the extension.

If the settings file is not valid JSON, the extension changes nothing and shows a warning. Fix the file, then run **Install Hooks** again.

## How it works

New and resumed sessions run `claude` in a VS Code terminal: `claude --session-id <uuid>` for a new one, `claude --resume <session-id>` for an existing one. The terminal's environment carries a random `CLAUDE_SESSION_MANAGER_TERMINAL` id that ties it to the session.

The installed Claude Code hooks run `out/hook/claude-session-hook.js` on session, prompt, permission, tool, notification, and stop events. The hook writes a small record under the extension's global storage, and the sidebar watches that directory to map terminals to sessions and show status. It never writes to stdout or stderr, so it cannot disturb a turn.

Claude Code also maintains `<configDir>/sessions/<pid>.json` for every live process; the extension polls it every few seconds as a fallback. This clears a stale "waiting" state after a permission prompt is approved and picks up status for sessions started by hand in a VS Code terminal.

Session rows come from `<configDir>/projects/<encoded-cwd>/<session-uuid>.jsonl`. The extension reads the first 64 KB and the last 256 KB for the title, working directory, and timestamps. Titles prefer Claude Code's own generated title, then the first real prompt, then the latest prompt.

The `Claude Code Session Manager` output channel logs each launch with timings: terminal created, process started, and the first hook record. Check it when a session is slow to open or stays on "starting".

## Keybindings

| Keys | Command |
| --- | --- |
| `Ctrl+Alt+C` `N` | New Session |
| `Ctrl+Alt+C` `R` | Resume Session |
| `Ctrl+Alt+C` `W` | Focus Next Session Needing Input |

On macOS, use `Cmd` instead of `Ctrl`.

## Settings

### Launch

| Setting | Default | Description |
| --- | --- | --- |
| `claudeSession.executable` | `claude` | Claude Code executable name or absolute path. |
| `claudeSession.configDir` | empty | Claude Code configuration directory. Empty uses `CLAUDE_CONFIG_DIR`, then `~/.claude`. |
| `claudeSession.extraArgs` | `[]` | Extra arguments for every Claude Code session the extension launches, for example `["--model", "sonnet"]`. |
| `claudeSession.env` | `{}` | Extra environment variables for every Claude Code session the extension launches. |
| `claudeSession.newSessionCwd` | `workspaceRoot` | Where New Session starts: `workspaceRoot`, `activeFileFolder`, or `ask`. |
| `claudeSession.terminalLocation` | `editor` | Open sessions in the `editor` area or the `panel`. VS Code starts an editor terminal only once its tab is laid out, so it can appear a moment later than a panel one, and restored sessions open one after another. |
| `claudeSession.terminalIcon` | `sparkle` | Codicon id for Claude Code terminal tabs. |
| `claudeSession.terminalColor` | empty | Theme color id for Claude Code terminal tabs, for example `terminal.ansiMagenta`. |
| `claudeSession.restoreOnStartup` | `always` | Reopen the sessions that were open when VS Code closed: `always`, `ask`, or `never`. Restored sessions use `--resume`, so a turn interrupted by the shutdown is not continued. |
| `claudeSession.focusOnStartup` | `true` | Open the Claude Code sidebar at startup instead of the last active view, such as Explorer. |

### Sessions

| Setting | Default | Description |
| --- | --- | --- |
| `claudeSession.sessions.scope` | `workspace` | List sessions from the open workspace, or `all`. The workspace includes the same folders in other git worktrees of their repositories, as Claude Code's resume picker does. All sessions when no folder is open. |
| `claudeSession.sessions.maxShown` | `300` | Most sessions listed. Open sessions always show. |
| `claudeSession.sessions.showEmpty` | `false` | List sessions that have no prompt yet. |
| `claudeSession.sessions.sortBy` | `modified` | Sort newest first by `modified` or `created`. |
| `claudeSession.sessions.groupBy` | `date` | Group the list by `date`, by `folder`, or not at all (`none`). Open sessions always come first. |

### Notifications

These are VS Code notifications from this extension, separate from Claude Code's own.

| Setting | Default | Description |
| --- | --- | --- |
| `claudeSession.notify.onFinish` | `true` | Notify when a session finishes while its tab is not in view. |
| `claudeSession.notify.onInput` | `true` | Notify when a session asks a question while its tab is not in view. |
| `claudeSession.notify.minWorkSeconds` | `10` | Skip the finish notification for runs shorter than this. Questions always notify. |
| `claudeSession.notify.style` | `vscode` | `vscode`, `system` (OS notification with sound while VS Code is in the background), or `both`. |

### Hooks

| Setting | Default | Description |
| --- | --- | --- |
| `claudeSession.hooks.nodePath` | empty | Absolute path to the Node.js executable used by the installed hooks. Empty searches `PATH`. The extension host's own executable is Electron and is not used. |

## Development

```sh
npm install
npm run watch   # compile on change; press F5 in VS Code to launch an Extension Development Host
npm test        # unit tests with a vscode stub
```

## Releasing

1. Add a `## <version>` section to `CHANGELOG.md`.
2. Run `npm version patch` (or `minor`, `major`). It bumps `package.json`, commits, and tags `v<version>`.
3. Run `git push --follow-tags`. The Release workflow tests, packages, and publishes a GitHub release with the `.vsix` and the changelog section as notes.
4. Download the `.vsix` from the release and upload it to the Marketplace publisher page.

## License

[MIT](LICENSE)

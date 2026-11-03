<!-- claude-code-update-check: through v2.1.308 -->
# Claude Code update todos

Background for each file this extension reads, the events it consumes, and what to re-check when updating Claude Code.

## v2.1.308 baseline (checked 2026-11-03)

- [x] **Adopt** CLI contract: `claude` starts an interactive session, `claude --resume <session-id>` resumes one, and `claude --session-id <uuid>` starts a new one with a chosen id. There is no `--restore` equivalent, so startup restore always resumes without continuing an interrupted turn. Evidence: `src/tracker.ts` `launch()` pushes `--resume` / `--session-id`; `src/config.ts` resolves the executable.
  - Done: resume and new-session launches verified against the local CLI; restore reuses `--resume`; unit coverage is in `test/trackerState.test.ts` and `test/config.test.ts`.

- [x] **Adopt** session layout: transcripts live at `<configDir>/projects/<encoded-cwd>/<session-uuid>.jsonl` (exactly two levels). Subagent transcripts live under `<session-uuid>/subagents/agent-*.jsonl`, which the index skips. Evidence: `src/sessions.ts` scan and `update()` skip `agent-*`; `test/sessions.test.ts` "ignoring agent transcripts".
  - Done: head 64KB + tail 256KB parsing, newest `ai-title.aiTitle` wins, fallback to first prompt then `last-prompt.lastPrompt`, permissive entry for unknown schemas, mtime+size cache.

- [x] **Adopt** transcript records: `type` values seen include `user`, `assistant`, `system`, `attachment`, `ai-title`, `last-prompt`, `queue-operation`, `file-history-*`; useful fields include `sessionId`, `cwd`, `timestamp`, `isSidechain`, `isMeta`, `message.content`. Records without any recognized shape still list by file name.
  - Done: parser ignores sidechains, meta records, tool results, and command wrappers; array and string content both read.

- [x] **Adopt** hook contract: settings use strict JSON under `hooks`; an event maps to groups `{matcher?, hooks: [{type:"command", command, args?, timeout?}]}`. Common stdin fields are `session_id`, `transcript_path`, `cwd`, `hook_event_name`; subagent payloads add `agent_id` / `agent_type`.
  - Done: `src/hooksInstall.ts` emits exec-form handlers with `--map-dir`, `--config-dir`, and the `claude-session-manager` owner marker; `src/hook/claude-session-hook.ts` ignores subagent payloads so a subagent cannot overwrite the main session state.

- [x] **Adopt** hook events: `SessionStart`, `UserPromptSubmit`, `PermissionRequest`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `Stop`, `StopFailure`, `SessionEnd`. `SessionStart` sources are `startup|resume|clear|compact|fork`; compact preserves the previous state. `Stop` keeps `working` when `stop_hook_active` or background tasks/crons remain. `Notification` types include `permission_prompt`, `idle_prompt`, `agent_needs_input`, `agent_completed`, `elicitation_dialog`. `SessionEnd.reason` is one of `clear`, `resume`, `logout`, `prompt_input_exit`, `other`.
  - Done: full mapping in `src/hook/claude-session-hook.ts`; state matrix covered by `test/hook.test.ts`. Records are kept for `other`/unknown reasons so a VS Code shutdown can still be restored.

- [x] **Adopt** live process registry: `<configDir>/sessions/<pid>.json` carries `pid`, `sessionId`, `cwd`, `name`, `status`, `updatedAt`, `statusUpdatedAt`, and sometimes `waitingFor`. It provides a fallback when hooks are missing and clears `waiting` after a permission approval, which has no dedicated hook. Evidence: `src/claudeFs.ts` `readLiveSessions`; `src/tracker.ts` `pollLive`; `test/liveSessions.test.ts`.
  - Done: polled every 3 seconds; only a newer `statusUpdatedAt` overrides hook state; dead-pid records are removed.

## Update checklist

1. Run `claude --help` and confirm `--resume` / `--session-id` behavior and any new flags.
2. Inspect a fresh transcript's record types and title fields; update `src/sessions.ts` and `test/sessions.test.ts`.
3. Inspect `<configDir>/sessions/<pid>.json` while a session is idle, working, and waiting; update `stateFromLive` in `src/trackerState.ts`.
4. Confirm the managed hook events and stdin payloads against Claude Code's hook documentation; update `MANAGED_EVENTS` in `src/hooksInstall.ts` and `mapEvent` in the hook.
5. Run `npm run compile && npm test`, then the manual checklist in the release notes.

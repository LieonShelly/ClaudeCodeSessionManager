# AGENTS.md

本文件为在此仓库中工作的 AI 编码代理提供指引。

## 项目概述

Claude Code Session Manager 是一个 VS Code 扩展（`claude-session-manager`），为 [Claude Code](https://claude.com/claude-code) 提供侧边栏：

- 会话历史列表，支持按日期/目录分组和搜索。
- 在编辑器标签（或面板）中新建、恢复会话。
- 打开会话的实时状态（`idle` / `working` / `waiting`）。
- VS Code 重启后按标签顺序恢复会话。
- 会话右键菜单、完成/需要输入通知。

扩展本身不实现代理逻辑；它启动 `claude`，通过写入用户级 Claude Code 设置的状态钩子接收事件，并读取 Claude Code 的会话文件与实时进程登记。

## 常用命令

```sh
npm install          # 安装依赖
npm run compile      # tsc 编译 src -> out
npm run watch        # 监听编译；在 VS Code 中按 F5 启动 Extension Development Host
npm test             # 清理 out-test，编译 src+test，再用 node:test 运行全部测试
npm run package      # 打包 .vsix（vsce package --no-dependencies）
```

运行单个测试文件（先编译测试产物）：

```sh
npx tsc -p tsconfig.test.json
node --test --require ./out-test/test/setup.js out-test/test/sessions.test.js
```

测试使用 `node:test` + `node:assert/strict`。`test/setup.ts` 通过拦截 `Module._load` 为 `vscode` 模块提供桩，因此只有依赖少量 VS Code API 的模块（`claudeFs`、`sessions`、`trackerState`、`hooksInstall`、`hook`、`worktrees`）有单元测试。涉及终端、Webview、命令注册的模块不在测试覆盖范围内。

CI（`.github/workflows/ci.yml`）在推送到 `main` 及所有 PR 上执行 `npm ci`、`npm run compile`、`npm test`。发布工作流由 `v*` 标签触发。

## 架构

### 运行链路

1. `TerminalTracker.launch()`（`src/tracker.ts`）创建终端：`shellPath` 为解析后的 `claude`，参数为 `claudeSession.extraArgs`，再加 `--session-id <uuid>`（新会话）或 `--resume <sessionId>`（恢复）。环境变量 `CLAUDE_SESSION_MANAGER_TERMINAL` 设为随机 UUID，作为终端与会话的关联键。终端设置为 `isTransient`，不由 VS Code 自行恢复。
2. 首次激活时 `ensureHooksInstalled()`（`src/hooksInstall.ts`）把本扩展的 handler 幂等合并进用户级 Claude Code 设置（`<configDir>/settings.json`）。handler 用 exec form 调用 `node out/hook/claude-session-hook.js`，并传入 `--map-dir`、`--config-dir`、`--owner`。
3. Claude Code 触发 hook 时，`src/hook/claude-session-hook.ts` 把记录写入 `<globalStorage>/terminals/<key>.json`。
4. `TerminalTracker` 用 `fs.watch` 监听该目录，把记录映射到终端与会话，并触发 `onDidChange` / `onDidChangeState`。
5. 每 3 秒轮询 `<configDir>/sessions/<pid>.json`（Claude Code 的实时进程登记），按 `statusUpdatedAt` 校准状态，并在权限批准后清除 `waiting`。
6. `SessionIndex`（`src/sessions.ts`）递归监听 `<configDir>/projects`，只索引 `<bucket>/<file>.jsonl`，读取头部 64KB 与尾部 256KB 得到标题、cwd、创建时间与首个提示词。
7. `ClaudeViewProvider`（`src/views.ts`）把会话数据推送到 Webview；`src/extension.ts` 注册命令、上下文菜单与通知逻辑。

`configDir` 的优先级：`claudeSession.configDir` 设置 > 环境变量 `CLAUDE_CONFIG_DIR` > `~/.claude`（`src/config.ts`）。

### 模块职责

| 文件 | 职责 |
| --- | --- |
| `src/extension.ts` | 激活入口；命令注册、通知判断、启动时聚焦侧边栏、hooks 安装/移除 |
| `src/config.ts` | 路径解析（configDir/projectsDir/liveSessionsDir/settings）、`claude` 可执行文件查找、`normPath` / `isWithin` |
| `src/claudeFs.ts` | 读取实时进程登记、按 pid/sessionId 查找、定位 transcript、`pidAlive` |
| `src/processTree.ts` | 跨平台父进程/祖先判断，用于接管手动启动的终端 |
| `src/hooksInstall.ts` | 合并/移除 `~/.claude/settings.json` 中的本扩展 handler；锁、原子写、备份 |
| `src/sessions.ts` | `SessionIndex`：会话扫描、解析、缓存、文件监听、符号链接去重 |
| `src/trackerState.ts` | 纯函数：记录解析、状态时间比较、实时登记状态映射 |
| `src/tracker.ts` | `TerminalTracker`：启动/恢复终端、读取 hook 记录、状态机、持久化排序 |
| `src/views.ts` | 侧边栏 Webview（内联 HTML/CSS/JS）、会话过滤与分组 |
| `src/worktrees.ts` | 通过读取 git 元数据，把工作区目录扩展到仓库的其他 worktree |
| `src/systemNotify.ts` | Windows/macOS/Linux 系统通知 |
| `src/hook/claude-session-hook.ts` | 运行在 Claude Code 内的事件 hook，写终端会话记录 |

### 关键数据契约

**终端记录**（`<globalStorage>/terminals/<key>.json`，由 hook 写入）：

```json
{
  "terminalId": "<CLAUDE_SESSION_MANAGER_TERMINAL>",
  "pid": 123,
  "shellPid": 456,
  "sessionFile": "<configDir>/projects/<bucket>/<uuid>.jsonl",
  "sessionId": "<uuid>",
  "cwd": "/path",
  "state": "idle | working | waiting",
  "stateAt": 0,
  "updatedAt": 0,
  "owner": "claude-session-manager"
}
```

- `pid` 是 Claude Code 进程；`shellPid` 是它的父进程（通常是 VS Code 终端 shell）。`shellPid` 可能缺失。
- 键通常来自 `CLAUDE_SESSION_MANAGER_TERMINAL`。手动在 VS Code shell 终端启动的 claude 没有该变量，键为 `pid-<pid>`；`TerminalTracker` 通过 pid/ppid 与进程祖先匹配并接管对应终端。
- 记录是实时状态的唯一来源（hook 优先，实时登记兜底）。没有记录时，终端显示“starting”，10 秒后告警并记录到 `Claude Code Session Manager` 输出通道。
- hook 删除记录的条件：`SessionEnd` 的 reason 为 `prompt_input_exit` / `clear` / `logout` / `resume`。`other` 与未知保留记录，供 VS Code 关闭后恢复。

**实时进程登记**（`<configDir>/sessions/<pid>.json`，由 Claude Code 写入）：

- 字段：`pid`、`sessionId`、`cwd`、`name`、`status`（`busy` 等）、`updatedAt`、`statusUpdatedAt`，可能有 `waitingFor`。
- 映射：非空 `waitingFor` -> `waiting`；`busy`/`working`/`running` -> `working`；`idle`/`ready` -> `idle`；`waiting` -> `waiting`。
- 只有 `statusUpdatedAt >= 已应用的 stateAt` 时才覆盖 hook 状态。

**会话状态语义**：

- `idle`：等待输入。
- `working`：代理循环运行中。`Stop` 时若 `background_tasks`/`session_crons` 非空或 `stop_hook_active`，仍为 `working`。
- `waiting`：阻塞在权限请求、`AskUserQuestion`、`ExitPlanMode` 或交互式通知上。`SessionStart(compact)` 保持原状态。

**会话文件**：

- 只有 `<configDir>/projects/<bucket>/*.jsonl` 顶层会话被索引；子代理记录位于 `<session-uuid>/subagents/agent-*.jsonl`，会被跳过。
- 指向文件的符号链接会被收录；指向目录（bucket）的符号链接不遍历；同一真实文件只列一次。
- 空会话（无标题且无首个提示词）默认隐藏，除非 `claudeSession.sessions.showEmpty`。
- 工作区范围还会包含同一仓库其他 git worktree 中的对应目录（与 Claude Code 的 resume picker 一致）。

### 重要实现约束

- **Hook 写用户全局设置**：安装必须先严格解析 JSON；解析失败或结构异常时不改文件并报错。合并只替换 `args` 中含 `claude-session-manager` 的 handler，保留所有其他键与 handler。写入使用锁文件、读取后二次 stat、临时文件 + fsync + rename，保留文件权限，跟随符号链接目标，并在写入前备份到 `<settings 目录>/backups/claude-session-manager/`。
- **Node 路径**：扩展宿主的 `process.execPath` 是 Electron，不能执行 hook。必须使用 `claudeSession.hooks.nodePath` 或 PATH 中的 `node`。
- **钩子绝不能向 Claude Code 抛异常或输出**：所有事件处理都经异常包裹；绝不写 stdout/stderr（`UserPromptSubmit` 的 stdout 会进入模型上下文）；写入采用临时文件 + 重命名，Windows 下 `EPERM`/`EACCES`/`EBUSY` 重试。
- **编辑器终端需按顺序恢复**：VS Code 在编辑器标签布局完成前不会启动进程，因此 `restore()` 逐个启动并等待 `processId`（最多 2 秒），避免启动时一批空白终端。恢复顺序保存在 `workspaceState` 的 `claudeSession.openSessions` 键中，按窗口隔离。
- **恢复不续跑被中断的回合**：启动恢复与手动打开都用 `--resume`。
- **平台差异**：路径比较统一使用 `normPath`（Windows 大小写不敏感）；符号链接测试在无权限的 Windows 上会跳过；系统通知按平台分别使用 PowerShell、`osascript`、`notify-send`。
- **Webview 与扩展主进程存在重复逻辑**：Webview 无法 `import` 扩展模块，`src/views.ts` 内联脚本中的时间/分组逻辑改动时要与主进程保持一致。

## 开发约定

- TypeScript `strict`，CommonJS，目标 ES2022，使用制表符缩进、双引号、分号。代码注释解释“为什么”，而不是复述代码。
- 新增用户可见的命令、设置或行为时：
  1. 在 `package.json` 的 `contributes` 中声明（命令、菜单、配置项）；
  2. 更新 `README.md` 中对应的设置/行为说明（README 的表格是用户文档的事实来源）；
  3. 在 `CHANGELOG.md` 当前版本下添加条目。
- `docs/claude-code-update-todos.md` 记录 Claude Code 行为变更的跟踪与采纳。采纳新的事件、设置或文件格式时，在该文件追加检查记录、证据位置与对应 commit。
- 测试产物在 `out-test/`，编译产物在 `out/`，二者均被 git 忽略。hook 源码在 `src/hook/`，编译到 `out/hook/claude-session-hook.js`。
- `.vscodeignore` 决定发布内容：只包含 `out/`、`media/`、`package*.json`、`README.md`、`CHANGELOG.md`、`LICENSE` 等。新增运行时必须的文件时要检查该文件；维护者文档（`src/`、`test/`、`docs/`、`CLAUDE.md`、本文件）不会进入 `.vsix`。

## 发布流程

1. 在 `CHANGELOG.md` 添加 `## <version>` 小节（该小节会成为 GitHub Release 说明）。
2. `npm version patch|minor|major`：更新版本、提交并打 `v<version>` 标签。
3. `git push --follow-tags`：Release 工作流校验标签与 `package.json` 版本一致，运行编译与测试，打包 `.vsix` 并创建 GitHub Release。
4. Marketplace 上传仍是手动步骤（见 `README.md`）。

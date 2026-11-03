import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
	defaultConfigDir,
	expandHome,
	liveSessionsDir as claudeLiveSessionsDir,
	projectsDir as claudeProjectsDir,
	settingsFile as claudeSettingsFile,
} from "./claudeFs";

/** Trimmed string from the `claudeSession` section; empty when unset. */
export function setting(key: string): string {
	return vscode.workspace.getConfiguration("claudeSession").get<string>(key)?.trim() ?? "";
}

/** `claudeSession.configDir` > `CLAUDE_CONFIG_DIR` > `~/.claude`. */
export function configDir(): string {
	const configured = setting("configDir");
	return configured ? expandHome(configured) : defaultConfigDir();
}

export function projectsDir(): string {
	return claudeProjectsDir(configDir());
}

export function liveSessionsDir(): string {
	return claudeLiveSessionsDir(configDir());
}

export function claudeSettingsPath(): string {
	return claudeSettingsFile(configDir());
}

/** Resolves the Claude Code executable against PATH so it can be the terminal's process. */
export function claudeExecutable(): string {
	const configured = expandHome(setting("executable") || "claude");
	if (path.isAbsolute(configured) || configured.includes("/") || configured.includes("\\")) return configured;
	const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		if (!dir) continue;
		for (const ext of exts) {
			const candidate = path.join(dir, configured + ext.toLowerCase());
			try {
				if (fs.statSync(candidate).isFile()) return candidate;
			} catch {
				// not here
			}
		}
	}
	return configured;
}

/** Case-insensitive on Windows, normalized separators. */
export function normPath(p: string): string {
	const resolved = path.resolve(p);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isWithin(child: string, parent: string): boolean {
	const c = normPath(child);
	const p = normPath(parent);
	return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

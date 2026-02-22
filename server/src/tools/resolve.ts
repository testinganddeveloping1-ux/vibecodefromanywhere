import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function toRealpathSafe(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function isProbablyAbsolute(p: string): boolean {
  if (!p) return false;
  if (path.isAbsolute(p)) return true;
  // Windows drive letter absolute path.
  return /^[a-zA-Z]:[\\/]/.test(p);
}

function hasPathSeparator(cmd: string): boolean {
  return cmd.includes("/") || cmd.includes("\\");
}

function pathExtCandidates(name: string, env: NodeJS.ProcessEnv): string[] {
  if (os.platform() !== "win32") return [name];
  const ext = String(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean);
  const lower = name.toLowerCase();
  const hasKnownExt = ext.some((x) => lower.endsWith(x.toLowerCase()));
  if (hasKnownExt) return [name];
  return [name, ...ext.map((x) => `${name}${x}`)];
}

function isExecutableFile(p: string): boolean {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (os.platform() === "win32") return true;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function splitPathEnv(env: NodeJS.ProcessEnv): string[] {
  const raw = String(env.PATH ?? "").trim();
  if (!raw) return [];
  return raw.split(path.delimiter).map((p) => p.trim()).filter(Boolean);
}

function uniqStable(items: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    if (!it) continue;
    const key = toRealpathSafe(it);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

function resolveCommandCandidates(cmd: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const c = String(cmd ?? "").trim();
  if (!c) return [];

  if (hasPathSeparator(c) || isProbablyAbsolute(c)) {
    const abs = path.isAbsolute(c) ? c : path.resolve(c);
    return isExecutableFile(abs) ? [abs] : [];
  }

  const dirs = splitPathEnv(env);
  const names = pathExtCandidates(c, env);
  const out: string[] = [];
  for (const d of dirs) {
    for (const n of names) {
      const cand = path.join(d, n);
      if (isExecutableFile(cand)) out.push(cand);
    }
  }
  return uniqStable(out);
}

function readFileHead(filePath: string, maxBytes = 8192): Buffer | null {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.allocUnsafe(maxBytes);
      const read = fs.readSync(fd, buf, 0, maxBytes, 0);
      return buf.subarray(0, Math.max(0, read));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function isTextFileHead(buf: Buffer): boolean {
  if (!buf || buf.length === 0) return false;
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 0) return false;
  }
  return true;
}

function looksLikeAntigravityWrapper(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  if (base.includes("antigravity")) return true;
  const realBase = path.basename(toRealpathSafe(filePath)).toLowerCase();
  if (realBase.includes("antigravity")) return true;

  const head = readFileHead(filePath);
  if (!head || !isTextFileHead(head)) return false;
  const text = head.toString("utf8").toLowerCase();
  if (text.includes("antigravity")) return true;
  if (text.includes("claude-antigravity")) return true;
  if (text.includes("antigravity-claude")) return true;
  return false;
}

function canonicalClaudeFallback(
  env: NodeJS.ProcessEnv,
  excludedRealPaths: Set<string>,
): string | null {
  // Prefer the standard command name; if PATH contains multiple, pick first non-wrapper.
  const names = ["claude", "claude-code", "claudecode"];
  for (const name of names) {
    const cands = resolveCommandCandidates(name, env);
    for (const cand of cands) {
      const rp = toRealpathSafe(cand);
      if (excludedRealPaths.has(rp)) continue;
      if (looksLikeAntigravityWrapper(cand)) continue;
      return cand;
    }
  }
  return null;
}

export function resolveBinary(cmd: string): string | null {
  return resolveCommandCandidates(cmd, process.env)[0] ?? null;
}

export function sanitizeClaudeCommand(
  input: { command: string; args: string[] },
  opts?: { allowWrapper?: boolean; env?: NodeJS.ProcessEnv },
): { command: string; args: string[]; changed: boolean; warnings: string[] } {
  const env = opts?.env ?? process.env;
  const allowWrapper = opts?.allowWrapper === true;
  const command = String(input?.command ?? "").trim() || "claude";
  const args = Array.isArray(input?.args) ? input.args.map((x) => String(x)) : [];
  if (allowWrapper) return { command, args, changed: false, warnings: [] };

  const warnings: string[] = [];
  const joined = `${command} ${args.join(" ")}`.toLowerCase();
  const explicitAntigravity = joined.includes("antigravity");
  const candidates = resolveCommandCandidates(command, env);
  const primary = candidates[0] ?? null;
  const primaryIsWrapper = primary ? looksLikeAntigravityWrapper(primary) : false;
  const commandLooksWrapper =
    explicitAntigravity ||
    primaryIsWrapper ||
    path.basename(command).toLowerCase().includes("antigravity");

  // Non-wrapper command: pin to resolved absolute path when available.
  if (!commandLooksWrapper) {
    if (primary && primary !== command) return { command: primary, args, changed: true, warnings };
    return { command, args, changed: false, warnings };
  }

  const excluded = new Set<string>();
  if (primary) excluded.add(toRealpathSafe(primary));
  if (path.isAbsolute(command)) excluded.add(toRealpathSafe(command));

  const fallback = canonicalClaudeFallback(env, excluded);
  if (fallback) {
    warnings.push(`Detected Claude wrapper command; using canonical Claude binary at ${fallback}.`);
    const nextArgs = explicitAntigravity ? [] : args;
    return {
      command: fallback,
      args: nextArgs,
      changed: fallback !== command || nextArgs.length !== args.length,
      warnings,
    };
  }

  // Last-resort fallback keeps standard command name and strips wrapper-specific hints.
  warnings.push("Detected Claude wrapper command, but no clean fallback binary was found in PATH. Falling back to plain `claude`.");
  const safeCommand = "claude";
  const safeArgs = explicitAntigravity ? [] : args;
  return {
    command: safeCommand,
    args: safeArgs,
    changed: safeCommand !== command || safeArgs.length !== args.length,
    warnings,
  };
}

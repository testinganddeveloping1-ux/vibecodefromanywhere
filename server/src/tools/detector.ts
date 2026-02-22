import { execCapture } from "./exec.js";
import type { ToolCaps, CodexCaps, ClaudeCaps, OpenCodeCaps } from "./types.js";
import { resolveBinary } from "./resolve.js";

function parseFirstMatch(text: string, re: RegExp): string | undefined {
  const m = text.match(re);
  return m?.[1];
}

function parsePossibleValuesBlock(help: string, label: string): string[] {
  // Supports both:
  // "Possible values:\n  - a\n  - b"
  // and "[possible values: a, b, c]"
  const out: string[] = [];
  // Accept either "--flag ... [possible values: ...]" or the next line containing it.
  const bracket = new RegExp(`${label}[\\s\\S]{0,240}?\\[possible values:\\s*([^\\]]+)\\]`, "i");
  const b = help.match(bracket);
  if (b?.[1]) {
    for (const v of b[1].split(",").map((s) => s.trim()).filter(Boolean)) out.push(v);
    return out;
  }

  const choices = new RegExp(`${label}[\\s\\S]{0,240}?\\(choices:\\s*([^\\)]+)\\)`, "i");
  const c = help.match(choices);
  if (c?.[1]) {
    // e.g. `"acceptEdits", "bypassPermissions", "default"`
    const vs = c[1]
      .split(",")
      .map((s) => s.trim())
      .map((s) => s.replace(/^"|"$/g, ""))
      .filter(Boolean);
    out.push(...vs);
    return out;
  }

  const idx = help.toLowerCase().indexOf(label.toLowerCase());
  if (idx < 0) return out;
  const slice = help.slice(idx, idx + 2400);
  const pv = slice.match(/Possible values:\s*([\s\S]*?)(\n\s*\n|$)/i);
  if (!pv?.[1]) return out;
  const lines = pv[1].split("\n");
  for (const ln of lines) {
    const m = ln.match(/^\s*-\s*([a-zA-Z0-9_-]+)\b/);
    if (m?.[1]) out.push(m[1]);
  }
  return out;
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasFlag(help: string, flag: string): boolean {
  const re = new RegExp(`(^|\\n)\\s*${escapeRe(flag)}(\\s|$)`, "m");
  return re.test(help);
}

async function detectCodex(cmd: string, args: string[]): Promise<CodexCaps> {
  const rPath = resolveBinary(cmd);
  if (!rPath) return {
    installed: false,
      sandboxModes: [],
      approvalPolicies: [],
      supports: {
        cd: false,
        model: false,
        addDir: false,
        search: false,
        fullAuto: false,
        bypassApprovalsSandbox: false,
        configOverride: false,
      noAltScreen: false,
    },
  };

  const version = (await execCapture(cmd, ["--version"], { timeoutMs: 1500 })).stdout.trim() || undefined;
  const help = (await execCapture(cmd, [...args, "--help"], { timeoutMs: 2000 })).stdout;
  const configPath = parseFirstMatch(help, /loaded from `([^`]+)`/);
  const sandboxModes = parsePossibleValuesBlock(help, "--sandbox");
  const approvalPolicies = parsePossibleValuesBlock(help, "--ask-for-approval");

  return {
    installed: true,
    path: rPath,
    version,
    configPath,
    sandboxModes,
    approvalPolicies,
    supports: {
      cd: hasFlag(help, "--cd") || hasFlag(help, "-C, --cd"),
      model: hasFlag(help, "--model") || hasFlag(help, "-m, --model"),
      addDir: hasFlag(help, "--add-dir"),
      search: hasFlag(help, "--search"),
      fullAuto: hasFlag(help, "--full-auto"),
      bypassApprovalsSandbox: hasFlag(help, "--dangerously-bypass-approvals-and-sandbox"),
      configOverride: hasFlag(help, "--config") || hasFlag(help, "-c, --config"),
      noAltScreen: hasFlag(help, "--no-alt-screen"),
    },
  };
}

async function detectClaude(cmd: string, args: string[]): Promise<ClaudeCaps> {
  const rPath = resolveBinary(cmd);
  if (!rPath) return {
    installed: false,
    permissionModes: [],
    supports: { permissionMode: false, dangerouslySkipPermissions: false, model: false, addDir: false, settings: false },
  };

  const version = (await execCapture(cmd, ["--version"], { timeoutMs: 1500 })).stdout.trim() || undefined;
  const help = (await execCapture(cmd, [...args, "--help"], { timeoutMs: 2000 })).stdout;
  const permissionModes = parsePossibleValuesBlock(help, "--permission-mode");
  return {
    installed: true,
    path: rPath,
    version,
    permissionModes,
    supports: {
      permissionMode: hasFlag(help, "--permission-mode"),
      dangerouslySkipPermissions: hasFlag(help, "--dangerously-skip-permissions"),
      model: hasFlag(help, "--model") || hasFlag(help, "-m, --model"),
      addDir: hasFlag(help, "--add-dir"),
      settings: hasFlag(help, "--settings"),
    },
  };
}

async function detectOpenCode(cmd: string, args: string[]): Promise<OpenCodeCaps> {
  const rPath = resolveBinary(cmd);
  if (!rPath) return {
    installed: false,
    supports: { model: false, agent: false, serve: false, web: false, attach: false, hostnamePort: false },
  };

  const version = (await execCapture(cmd, ["--version"], { timeoutMs: 1500 })).stdout.trim() || undefined;
  const help = (await execCapture(cmd, [...args, "--help"], { timeoutMs: 2200 })).stdout;
  return {
    installed: true,
    path: rPath,
    version,
    supports: {
      model: hasFlag(help, "--model") || hasFlag(help, "-m, --model"),
      agent: hasFlag(help, "--agent"),
      serve: help.includes(" opencode serve"),
      web: help.includes(" opencode web"),
      attach: help.includes(" opencode attach"),
      hostnamePort: hasFlag(help, "--hostname") && hasFlag(help, "--port"),
    },
  };
}

export class ToolDetector {
  private cache: ToolCaps | null = null;
  private scanning: Promise<ToolCaps> | null = null;

  constructor(private readonly tools: { codex: { command: string; args: string[] }; claude: { command: string; args: string[] }; opencode: { command: string; args: string[] } }) {}

  async get(opts?: { maxAgeMs?: number }): Promise<ToolCaps> {
    const maxAgeMs = opts?.maxAgeMs ?? 5 * 60 * 1000;
    if (this.cache && Date.now() - this.cache.scannedAt < maxAgeMs) return this.cache;
    return await this.scan();
  }

  async scan(): Promise<ToolCaps> {
    if (this.scanning) return await this.scanning;
    this.scanning = (async () => {
      const [codex, claude, opencode] = await Promise.all([
        detectCodex(this.tools.codex.command, this.tools.codex.args),
        detectClaude(this.tools.claude.command, this.tools.claude.args),
        detectOpenCode(this.tools.opencode.command, this.tools.opencode.args),
      ]);
      const next: ToolCaps = { codex, claude, opencode, scannedAt: Date.now() };
      this.cache = next;
      this.scanning = null;
      return next;
    })();
    return await this.scanning;
  }
}

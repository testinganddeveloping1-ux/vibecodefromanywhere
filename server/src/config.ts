import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nanoid } from "nanoid";
import * as TOML from "@iarna/toml";

export type Config = {
  server: { bind: string; port: number };
  auth: { token: string };
  workspaces: {
    roots: string[];
  };
  tools: {
    codex: { command: string; args: string[] };
    claude: { command: string; args: string[] };
    opencode: { command: string; args: string[] };
  };
  profiles: Record<
    string,
    {
      tool: "codex" | "claude" | "opencode";
      title: string;
      toolArgs?: string[];
      env?: Record<string, string>;
      // Tool-native settings (preferred over brittle macros).
      codex?: {
        sandbox?: "read-only" | "workspace-write" | "danger-full-access";
        // Codex CLI `--ask-for-approval` values. `on-failure` is deprecated but kept for back-compat.
        askForApproval?: "untrusted" | "on-request" | "never" | "on-failure";
        model?: string;
        fullAuto?: boolean;
        bypassApprovalsAndSandbox?: boolean;
        search?: boolean;
        noAltScreen?: boolean;
        addDir?: string[];
      };
      claude?: {
        // Claude Code `--permission-mode` values.
        permissionMode?: "default" | "acceptEdits" | "plan" | "bypassPermissions" | "delegate" | "dontAsk";
        dangerouslySkipPermissions?: boolean;
        model?: string;
        addDir?: string[];
        // Auth mode:
        // - subscription: prefer Claude Pro/Max account auth (default).
        // - api: use API key-based auth if configured.
        authMode?: "subscription" | "api";
      };
      opencode?: {
        // In OpenCode, models are specified as "provider/model".
        // Example: "opencode/kimi-k2.5-free"
        model?: string;
        agent?: string;
        prompt?: string;
        continue?: boolean;
        session?: string;
        fork?: boolean;
        hostname?: string;
        port?: number;
      };
      startup: Array<{ type: "text"; text: string } | { type: "keys"; keys: string[] }>;
      sendSuffix: string;
    }
  >;
};

export function configDir(): string {
  return path.join(os.homedir(), ".fromyourphone");
}

export function configPath(): string {
  return path.join(configDir(), "config.toml");
}

export function defaultConfig(): Config {
  return {
    // Secure-by-default: bind locally. Use `fromyourphone start --lan` (or edit config.toml)
    // to expose on your LAN, or use Tailscale/Cloudflared for encrypted access.
    server: { bind: "127.0.0.1", port: 7337 },
    auth: { token: nanoid(48) },
    workspaces: { roots: [os.homedir()] },
    tools: {
      codex: { command: "codex", args: [] },
      claude: { command: "claude", args: [] },
      opencode: { command: "opencode", args: [] },
    },
    profiles: {
      "codex.default": {
        tool: "codex",
        title: "Codex: Default",
        codex: { sandbox: "read-only", askForApproval: "on-request", noAltScreen: true },
        startup: [],
        sendSuffix: "\r",
      },
      "codex.plan": {
        tool: "codex",
        title: "Codex: Plan",
        codex: { sandbox: "read-only", askForApproval: "on-request", noAltScreen: true },
        startup: [{ type: "text", text: "/plan\r" }],
        sendSuffix: "\r",
      },
      "codex.full_auto": {
        tool: "codex",
        title: "Codex: Full Auto (Workspace)",
        codex: { sandbox: "workspace-write", fullAuto: true, noAltScreen: true },
        startup: [],
        sendSuffix: "\r",
      },
      "codex.danger": {
        tool: "codex",
        title: "Codex: Danger (Bypass Approvals + No Sandbox)",
        codex: { bypassApprovalsAndSandbox: true, noAltScreen: true },
        startup: [],
        sendSuffix: "\r",
      },
      "claude.default": {
        tool: "claude",
        title: "Claude: Default",
        claude: { authMode: "subscription" },
        startup: [],
        sendSuffix: "\r",
      },
      "claude.plan": {
        tool: "claude",
        title: "Claude: Plan (Permission Mode)",
        claude: { permissionMode: "plan", authMode: "subscription" },
        startup: [],
        sendSuffix: "\r",
      },
      "claude.accept_edits": {
        tool: "claude",
        title: "Claude: Accept Edits (Permission Mode)",
        claude: { permissionMode: "acceptEdits", authMode: "subscription" },
        startup: [],
        sendSuffix: "\r",
      },
      "claude.bypass_plan": {
        tool: "claude",
        title: "Claude: Bypass Permissions + Plan",
        claude: { dangerouslySkipPermissions: true, permissionMode: "plan", authMode: "subscription" },
        startup: [],
        sendSuffix: "\r",
      },
      "opencode.default": {
        tool: "opencode",
        title: "OpenCode: Default",
        startup: [],
        sendSuffix: "\r",
      },
      "opencode.plan_build": {
        tool: "opencode",
        title: "OpenCode: Plan + Build",
        opencode: { agent: "plan" },
        startup: [],
        sendSuffix: "\r",
      },
      "opencode.kimi_free": {
        tool: "opencode",
        title: "OpenCode: Kimi K2.5 (Free)",
        opencode: { model: "opencode/kimi-k2.5-free" },
        startup: [],
        sendSuffix: "\r",
      },
      "opencode.minimax_free": {
        tool: "opencode",
        title: "OpenCode: Minimax M2.5 (Free)",
        opencode: { model: "opencode/minimax-m2.5-free" },
        startup: [],
        sendSuffix: "\r",
      },
    },
  };
}

export function parseConfigToml(raw: string): Config {
  return TOML.parse(raw) as any as Config;
}

export function stringifyConfigToml(cfg: Config): string {
  return TOML.stringify(cfg as any);
}

export async function loadOrCreateConfig(): Promise<Config> {
  const p = configPath();
  let cfg: Config;
  if (!fs.existsSync(p)) {
    fs.mkdirSync(configDir(), { recursive: true });
    cfg = defaultConfig();
    fs.writeFileSync(p, stringifyConfigToml(cfg), "utf8");
  } else {
    const raw = fs.readFileSync(p, "utf8");
    cfg = parseConfigToml(raw);
  }

  // Runtime-only overrides (do not mutate config.toml).
  // Useful for `fromyourphone start --lan` without weakening the default config.
  const bindOverride = typeof process.env.FYP_BIND === "string" ? process.env.FYP_BIND.trim() : "";
  if (bindOverride) cfg.server.bind = bindOverride;

  const portOverride = typeof process.env.FYP_PORT === "string" ? process.env.FYP_PORT.trim() : "";
  if (portOverride) {
    const n = Number(portOverride);
    if (Number.isFinite(n) && n > 0 && n < 65536) cfg.server.port = Math.floor(n);
  }

  return cfg;
}

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
        askForApproval?: "untrusted" | "on-failure" | "on-request" | "never";
        fullAuto?: boolean;
        bypassApprovalsAndSandbox?: boolean;
        search?: boolean;
        noAltScreen?: boolean;
        addDir?: string[];
      };
      claude?: {
        permissionMode?:
          | "acceptEdits"
          | "bypassPermissions"
          | "default"
          | "delegate"
          | "dontAsk"
          | "plan";
        dangerouslySkipPermissions?: boolean;
        addDir?: string[];
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
    server: { bind: "0.0.0.0", port: 7337 },
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
        codex: { noAltScreen: true },
        startup: [],
        sendSuffix: "\r",
      },
      "codex.plan": {
        tool: "codex",
        title: "Codex: Plan",
        codex: { noAltScreen: true },
        startup: [{ type: "text", text: "/plan\r" }],
        sendSuffix: "\r",
      },
      "codex.full_auto": {
        tool: "codex",
        title: "Codex: Full Auto (Workspace)",
        codex: { fullAuto: true, noAltScreen: true },
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
        startup: [],
        sendSuffix: "\r",
      },
      "claude.plan": {
        tool: "claude",
        title: "Claude: Plan (Permission Mode)",
        claude: { permissionMode: "plan" },
        startup: [],
        sendSuffix: "\r",
      },
      "claude.accept_edits": {
        tool: "claude",
        title: "Claude: Accept Edits (Permission Mode)",
        claude: { permissionMode: "acceptEdits" },
        startup: [],
        sendSuffix: "\r",
      },
      "claude.bypass_plan": {
        tool: "claude",
        title: "Claude: Bypass Permissions + Plan",
        claude: { dangerouslySkipPermissions: true, permissionMode: "plan" },
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
  if (!fs.existsSync(p)) {
    fs.mkdirSync(configDir(), { recursive: true });
    const cfg = defaultConfig();
    fs.writeFileSync(p, stringifyConfigToml(cfg), "utf8");
    return cfg;
  }
  const raw = fs.readFileSync(p, "utf8");
  return parseConfigToml(raw);
}

import type { Config } from "../config.js";
import type { ToolId } from "../sessions/session_manager.js";

export function buildArgsForSession(input: {
  tool: ToolId;
  baseArgs: string[];
  profile?: Config["profiles"][string] | null;
  cwd?: string;
}): { args: string[]; notes: string[] } {
  const notes: string[] = [];
  const args = [...input.baseArgs];
  const p = input.profile ?? null;

  if (input.tool === "codex") {
    if (input.cwd) args.push("--cd", input.cwd);

    const c = p?.codex;
    if (c?.sandbox) args.push("--sandbox", c.sandbox);
    if (c?.askForApproval) {
      // `on-failure` is deprecated in newer Codex CLI builds. Map it to `on-request`
      // for compatibility rather than failing session spawn.
      const v = c.askForApproval === ("on-failure" as any) ? "on-request" : c.askForApproval;
      args.push("--ask-for-approval", v);
      if (c.askForApproval === ("on-failure" as any)) notes.push("codex.askForApproval on-failure deprecated; using on-request");
    }
    if (c?.fullAuto) args.push("--full-auto");
    if (c?.bypassApprovalsAndSandbox) args.push("--dangerously-bypass-approvals-and-sandbox");
    if (c?.search) args.push("--search");
    if (c?.noAltScreen) args.push("--no-alt-screen");
    for (const d of c?.addDir ?? []) args.push("--add-dir", d);
  }

  if (input.tool === "claude") {
    const c = p?.claude;
    if (c?.permissionMode) {
      const allowed = new Set(["default", "acceptEdits", "plan", "bypassPermissions", "delegate", "dontAsk"]);
      if (allowed.has(c.permissionMode)) args.push("--permission-mode", c.permissionMode);
      else notes.push(`claude.permissionMode ignored (unsupported): ${c.permissionMode}`);
    }
    if (c?.dangerouslySkipPermissions) args.push("--dangerously-skip-permissions");
    for (const d of c?.addDir ?? []) args.push("--add-dir", d);
  }

  if (input.tool === "opencode") {
    const o = p?.opencode;
    if (o?.model) args.push("--model", o.model);
    if (o?.agent) args.push("--agent", o.agent);
    if (o?.prompt) args.push("--prompt", o.prompt);
    if (o?.continue) args.push("--continue");
    if (o?.session) args.push("--session", o.session);
    if (o?.fork) args.push("--fork");
    if (o?.hostname) args.push("--hostname", o.hostname);
    if (typeof o?.port === "number") args.push("--port", String(o.port));
  }

  // Back-compat escape hatch
  if (p?.toolArgs?.length) {
    args.push(...p.toolArgs);
    notes.push("profile.toolArgs appended");
  }

  return { args, notes };
}

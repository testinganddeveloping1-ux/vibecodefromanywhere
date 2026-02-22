import Fastify from "fastify";
import helmet from "@fastify/helmet";
import compress from "@fastify/compress";
import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import cookie from "@fastify/cookie";
import staticPlugin from "@fastify/static";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { addAuthGuard } from "./auth.js";
import { SessionManager, type ToolCommand, type ToolId } from "./sessions/session_manager.js";
import { createStore, type Store } from "./store.js";
import { configDir, configPath, defaultConfig, parseConfigToml, type Config } from "./config.js";
import { mergeRedactedTomlSecrets, redactTomlSecrets } from "./config_secrets.js";
import { macroToWrites } from "./macros/macro_engine.js";
import { createDir, isUnderRoot, listDir, normalizeRoots, validateCwd } from "./workspaces.js";
import { ToolDetector } from "./tools/detector.js";
import { buildArgsForSession } from "./tools/arg_builders.js";
import { execCapture, execCaptureViaFile } from "./tools/exec.js";
import { sanitizeClaudeCommand } from "./tools/resolve.js";
import { PairingManager } from "./pairing.js";
import { resolveGitForPath, listGitWorktrees, createGitWorktree, removeGitWorktree } from "./git.js";
import { nanoid } from "nanoid";
import { createHash, randomUUID } from "node:crypto";
import { ToolSessionIndex, parseOpenCodeExport, parseOpenCodeSessionList, type ToolSessionSummary } from "./tool_sessions.js";
import { CodexAppServer } from "./codex_app_server.js";
import { buildOrchestrationDigest as buildOrchestrationDigestModel, type OrchestrationWorkerSnapshot } from "./orchestration_digest.js";
import {
  buildMasterSystemPromptLibrary,
  buildCreatorSystemPrompt,
  buildGenericKnowledgePrompt,
  buildImproverSystemPrompt,
  buildHarnessSotaAudit,
  buildOrchestratorSystemPrompt,
  buildWorkerSystemPrompt,
  defaultCommandCatalog,
  type AgentCommandDef,
  inferWorkerRole,
  recommendHarnessPlan,
  type HarnessCreatorPrefs,
  type WorkspaceScanSummary,
  type WorkerRoleKey,
} from "./harness.js";
import {
  persistRuntimeBootstrapDocs,
  scaffoldOrchestrationDocs,
} from "./orchestration_docs.js";
import {
  parseForceInterruptFlag,
  parseOrchestratorControlDirectives,
  type ParsedDispatchDirective,
  type ParsedQuestionAnswerDirective,
} from "./orchestration_control.js";
import {
  ensureWorkerTaskIncludesObjective,
  normalizeOrchestrationObjective,
} from "./orchestration_objective.js";
import {
  buildHarnessCommandPayloadSchema,
  validateHarnessCommandPayloadBySchema,
} from "./harness_command_schema.js";
import {
  buildHarnessCommandPolicyMeta,
  evaluateHarnessCommandPolicy,
} from "./harness_command_policy.js";

export type AppConfig = {
  token: string;
  tools?: Record<ToolId, ToolCommand>;
  dataDir?: string;
  profiles?: Config["profiles"];
  workspaces?: Config["workspaces"];
  hookBaseUrl?: string;
};

export async function buildApp(cfg: AppConfig): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 10 * 1024 * 1024,
  });

  const disableHelmet = process.env.FYP_DISABLE_HELMET === "1" || process.env.FYP_DISABLE_HELMET === "true";
  const disableCompress = process.env.FYP_DISABLE_COMPRESS === "1" || process.env.FYP_DISABLE_COMPRESS === "true";

  if (!disableHelmet) await app.register(helmet, { contentSecurityPolicy: false });
  if (!disableCompress) await app.register(compress);
  await app.register(websocket);
  await app.register(cookie);

  // Protect API + websocket only; UI assets can load and show the unlock screen.
  addAuthGuard(app, cfg.token, { onlyPrefixes: ["/api", "/ws"], exceptPrefixes: ["/api/auth/pair/claim", "/api/auth/logout"] });

  const baseDir = cfg.dataDir ?? configDir();
  const hookBaseUrl = cfg.hookBaseUrl ?? `http://127.0.0.1:7337`;
  const allowClaudeWrapper =
    process.env.FYP_ALLOW_CLAUDE_WRAPPER === "1" || process.env.FYP_ALLOW_CLAUDE_WRAPPER === "true";
  const tools = structuredClone(cfg.tools ?? defaultConfig().tools);
  {
    const claudeCommand = String((tools as any)?.claude?.command ?? "claude");
    const claudeArgs = Array.isArray((tools as any)?.claude?.args)
      ? (tools as any).claude.args.map((x: any) => String(x))
      : [];
    const resolved = sanitizeClaudeCommand(
      { command: claudeCommand, args: claudeArgs },
      { allowWrapper: allowClaudeWrapper, env: process.env },
    );
    (tools as any).claude = { command: resolved.command, args: resolved.args };
    if (resolved.warnings.length > 0) {
      for (const w of resolved.warnings) {
        try {
          console.warn(`[fyp] ${w}`);
        } catch {
          // ignore
        }
      }
    }
  }
  let profiles = cfg.profiles ?? defaultConfig().profiles;
  const roots = normalizeRoots(cfg.workspaces?.roots ?? defaultConfig().workspaces.roots);
  const store = createStore(baseDir);
  const toolIndex = new ToolSessionIndex({ roots });
  const sessions = new SessionManager({ token: cfg.token, tools });
  const detector = new ToolDetector(tools);
  const pairing = new PairingManager();
  const claudeHooksEnabled = !(process.env.FYP_DISABLE_CLAUDE_HOOKS === "1" || process.env.FYP_DISABLE_CLAUDE_HOOKS === "true");

  // Claude Code PermissionRequest hook bridge:
  // - Hook script (runs locally) POSTs PermissionRequest details here.
  // - We surface it as an Inbox item with touch-friendly options.
  // - The hook script polls for the chosen decision and prints it to Claude.
  const claudeHookSessions = new Map<string, { key: string }>(); // sessionId -> key
  const claudeHookRequests = new Map<
    string,
    { sessionId: string; attentionId: number; createdAt: number; decision: any | null; deliveredAt: number | null }
  >(); // signature -> record

  function ensureClaudePermissionHookScript(): string | null {
    const hooksDir = path.join(baseDir, "hooks");
    const hookPath = path.join(hooksDir, "claude_permission_hook.mjs");
    const expected = `#!/usr/bin/env node
// Generated by FromYourPhone. Bridges Claude Code PermissionRequest hooks into FYP Inbox.
// If this script fails or times out, Claude falls back to its normal permission UI.

import { setTimeout as sleep } from "node:timers/promises";

function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(buf);
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (buf += d));
    process.stdin.on("end", finish);
    process.stdin.on("close", finish);
    // Safety: don't hang forever if stdin never closes. This should be plenty for the small JSON payload.
    setTimeout(finish, 2000).unref?.();
  });
}

async function main() {
  const baseUrl = process.env.FYP_HOOK_BASE_URL || "";
  const key = process.env.FYP_HOOK_KEY || "";
  const sessionId = process.env.FYP_SESSION_ID || "";
  const timeoutMs = Number(process.env.FYP_HOOK_TIMEOUT_MS || "540000"); // 9m
  if (!baseUrl || !key || !sessionId || !Number.isFinite(timeoutMs) || timeoutMs < 10_000) return;

  const raw = String(await readStdin());
  let payload = null;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  if (!payload || typeof payload !== "object") return;

  let signature = "";
  try {
    const r = await fetch(baseUrl.replace(/\\/$/, "") + "/hooks/claude/permission-request", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-fyp-hook-key": key,
      },
      body: JSON.stringify({ sessionId, payload }),
    });
    if (!r.ok) return;
    const j = await r.json();
    signature = typeof j?.signature === "string" ? j.signature : "";
    if (!signature) return;
  } catch {
    return;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const u =
        baseUrl.replace(/\\/$/, "") +
        "/hooks/claude/permission-decision?sessionId=" +
        encodeURIComponent(sessionId) +
        "&signature=" +
        encodeURIComponent(signature);
      const r = await fetch(u, { headers: { "x-fyp-hook-key": key } });
      if (r.status === 404) return;
      if (r.ok) {
        const j = await r.json();
        const decision = j?.decision ?? null;
        if (decision && typeof decision === "object") {
          const out = {
            hookSpecificOutput: {
              hookEventName: "PermissionRequest",
              decision,
            },
          };
          process.stdout.write(JSON.stringify(out) + "\\n");
          return;
        }
      }
    } catch {
      // ignore
    }
    await sleep(350);
  }
}

main().catch(() => {});
`;

    try {
      fs.mkdirSync(hooksDir, { recursive: true });
      const cur = fs.existsSync(hookPath) ? fs.readFileSync(hookPath, "utf8") : "";
      if (cur !== expected) fs.writeFileSync(hookPath, expected, { encoding: "utf8", mode: 0o755 });
      try {
        fs.chmodSync(hookPath, 0o755);
      } catch {
        // ignore
      }
    } catch {
      // ignore
    }
    return fs.existsSync(hookPath) ? hookPath : null;
  }

  function shQuote(s: string): string {
    // POSIX single-quote safe. We don't target Windows here.
    return `'${String(s).replace(/'/g, `'\\''`)}'`;
  }

  function claudePermissionSignature(sessionId: string, toolName: string, toolInput: any): string {
    const h = createHash("sha256").update(JSON.stringify({ toolName, toolInput })).digest("hex").slice(0, 16);
    return `${sessionId}|claude.permission|${toolName}|${h}`;
  }

  function summarizeClaudePermission(toolName: string, toolInput: any): { severity: "info" | "warn" | "danger"; title: string; body: string } {
    const t = String(toolName || "Tool");
    const lower = t.toLowerCase();
    const severity: "info" | "warn" | "danger" =
      lower.includes("bash") || lower.includes("shell") || lower.includes("command") ? "danger" : lower.includes("write") || lower.includes("edit") ? "warn" : "info";

    let body = "";
    try {
      if (lower === "bash" || lower.includes("bash")) {
        const cmd = typeof toolInput?.command === "string" ? toolInput.command : "";
        body = cmd ? `$ ${cmd}` : "Claude wants to run a shell command.";
      } else if (lower.includes("write") || lower.includes("edit")) {
        const fp = typeof toolInput?.file_path === "string" ? toolInput.file_path : typeof toolInput?.path === "string" ? toolInput.path : "";
        body = fp ? fp : "Claude wants to write/edit files.";
      } else if (lower.includes("read")) {
        const fp = typeof toolInput?.file_path === "string" ? toolInput.file_path : typeof toolInput?.path === "string" ? toolInput.path : "";
        body = fp ? fp : "Claude wants to read files.";
      } else {
        body = JSON.stringify(toolInput ?? {}).slice(0, 520);
      }
    } catch {
      body = "Claude is requesting permission.";
    }
    const title = `Claude permission: ${t}`;
    return { severity, title, body };
  }

  function hasBearerAuth(req: any): boolean {
    const auth = String(req?.headers?.authorization ?? "");
    if (!auth.toLowerCase().startsWith("bearer ")) return false;
    const tok = auth.slice("bearer ".length).trim();
    return Boolean(tok) && tok === cfg.token;
  }

  function hasClaudeHookKey(req: any, sessionId: string): boolean {
    const raw = (req?.headers as any)?.["x-fyp-hook-key"];
    const key = typeof raw === "string" ? raw : Array.isArray(raw) ? String(raw[0] ?? "") : "";
    if (!key) return false;
    const rec = claudeHookSessions.get(sessionId);
    return Boolean(rec && rec.key === key);
  }

  function authHook(req: any, sessionId: string): boolean {
    return hasBearerAuth(req) || hasClaudeHookKey(req, sessionId);
  }

  // Cleanup: avoid unbounded growth if something goes wrong.
  setInterval(() => {
    const now = Date.now();
    for (const [sig, r] of claudeHookRequests.entries()) {
      if (now - r.createdAt > 30 * 60 * 1000) claudeHookRequests.delete(sig);
      else if (r.deliveredAt && now - r.deliveredAt > 20_000) claudeHookRequests.delete(sig);
    }
  }, 60_000).unref?.();

  app.post("/hooks/claude/permission-request", async (req, reply) => {
    const body = (req.body ?? {}) as any;
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
    const payload = body?.payload ?? null;
    if (!sessionId || !payload) return reply.code(400).send({ ok: false, reason: "bad_request" });
    if (!authHook(req, sessionId)) return reply.code(401).send({ ok: false, reason: "unauthorized" });
    const sess = store.getSession(sessionId);
    if (!sess || sess.tool !== "claude") return reply.code(404).send({ ok: false, reason: "session_not_found" });

    const toolName = typeof (payload as any)?.tool_name === "string" ? (payload as any).tool_name : "Tool";
    const toolInput = (payload as any)?.tool_input ?? {};
    const suggestions = Array.isArray((payload as any)?.permission_suggestions) ? (payload as any).permission_suggestions : [];

    const signature = claudePermissionSignature(sessionId, toolName, toolInput);
    const summary = summarizeClaudePermission(toolName, toolInput);

    const options: any[] = [
      { id: "y", label: "Allow once", decision: { behavior: "allow" } },
    ];
    // Surface suggestions as separate "Always allow" buttons.
    for (let i = 0; i < suggestions.length; i++) {
      const s = suggestions[i];
      const type = typeof s?.type === "string" ? s.type : "suggestion";
      const tool = typeof s?.tool === "string" ? s.tool : toolName;
      const label =
        type === "toolAlwaysAllow"
          ? `Always allow ${tool}`
          : `Always allow (${type})`;
      options.push({ id: `a${i + 1}`, label, decision: { behavior: "allow", updatedPermissions: [s] } });
    }
    options.push({ id: "n", label: "Deny", decision: { behavior: "deny" } });

    const created = store.createAttentionItem({
      sessionId,
      kind: "claude.permission",
      severity: summary.severity,
      title: summary.title,
      body: summary.body,
      signature,
      options,
    });
    const attentionId = created.ok ? created.id : created.existingId ?? -1;
    if (attentionId !== -1) queueAttentionForOrchestrator(sessionId, attentionId, "claude.permission");

    // Track for polling.
    claudeHookRequests.set(signature, {
      sessionId,
      attentionId,
      createdAt: Date.now(),
      decision: null,
      deliveredAt: null,
    });

    log("claude hook PermissionRequest", { sessionId, toolName, attentionId });
    broadcastGlobal({ type: "inbox.changed", sessionId });
    return { ok: true, signature, attentionId };
  });

  app.get("/hooks/claude/permission-decision", async (req, reply) => {
    const q = req.query as any;
    const sessionId = typeof q?.sessionId === "string" ? q.sessionId : "";
    const signature = typeof q?.signature === "string" ? q.signature : "";
    if (!sessionId || !signature) return reply.code(400).send({ ok: false, reason: "bad_request" });
    if (!authHook(req, sessionId)) return reply.code(401).send({ ok: false, reason: "unauthorized" });
    const rec = claudeHookRequests.get(signature);
    if (!rec || rec.sessionId !== sessionId) return reply.code(404).send({ ok: false, reason: "unknown_signature" });
    if (rec.decision) {
      rec.deliveredAt = Date.now();
      return { ok: true, decision: rec.decision };
    }
    return { ok: true, decision: null };
  });

  // Serve UI assets from dist no matter what directory the server is launched from.
  // When compiled, this file lives at `dist/server/app.js`, so `../web` is `dist/web`.
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const appRoot = path.resolve(moduleDir, "..", "..");
  let appPkg: any = null;
  try {
    appPkg = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8"));
  } catch {
    appPkg = null;
  }
  const webRootCandidates = [
    path.join(moduleDir, "..", "web"),
    path.join(process.cwd(), "dist", "web"),
  ];
  const webRoot = webRootCandidates.find((p) => fs.existsSync(p)) ?? webRootCandidates[1]!;
  if (fs.existsSync(webRoot)) {
    await app.register(staticPlugin, {
      root: webRoot,
      prefix: "/",
      decorateReply: false,
      // We set Cache-Control manually in `setHeaders` so `index.html` can't go stale
      // and "blank screen after update" is avoided. fastify-static otherwise sets
      // cache-control after `setHeaders`, overwriting our values.
      cacheControl: false,
      setHeaders: (res, filePath) => {
        try {
          const pRaw = String(filePath ?? "");
          const p = pRaw.replaceAll("\\", "/");
          // Default: behave like fastify-static's maxAge=0.
          res.setHeader("cache-control", "public, max-age=0");
          // Avoid "blank screen after update" due to stale cached index.html pointing to old hashed assets.
          // fastify-static may provide either absolute or relative paths here, so match both.
          if (p === "index.html" || p.endsWith("/index.html")) {
            res.setHeader("cache-control", "no-store");
            return;
          }
          // Cache Vite-hashed assets aggressively.
          if (p.startsWith("assets/") || p.includes("/assets/")) {
            res.setHeader("cache-control", "public, max-age=31536000, immutable");
            return;
          }
        } catch {
          // ignore
        }
      },
    });
    app.setNotFoundHandler(async (_req, reply) => {
      const indexPath = path.join(webRoot, "index.html");
      // Same cache policy as static handler: always fetch the latest index.html so hashed assets stay in sync.
      reply.header("cache-control", "no-store").type("text/html").send(fs.readFileSync(indexPath, "utf8"));
    });
  }

  // Broadcast: sessionId -> sockets
  const sockets = new Map<string, Set<WebSocket>>();
  const globalSockets = new Set<WebSocket>();

  // Plaintext buffers (for lightweight prompt detection, especially for Codex when --no-alt-screen is enabled).
  const textBuf = new Map<string, string>();
  const lastPreview = new Map<string, { ts: number; line: string }>();
  const lastPreviewBroadcast = new Map<string, number>();
  const lastInboxBroadcast = new Map<string, number>();
  // If orchestration bootstrap is sent too early for a given CLI startup sequence,
  // we can inject it once on the first user message as a recovery path.
  const firstUserBootstrapFallback = new Map<
    string,
    { text: string; queuedAt: number; forceOnFirstInput?: boolean; kickoffLabel?: string; autoRetries?: number }
  >();
  // Track orchestrator inline dispatch parsing state per session.
  const orchestratorDispatchDirectiveRecent = new Map<string, Map<string, number>>();
  const orchestratorDispatchDirectiveCarry = new Map<string, string>();
  const ORCH_DIRECTIVE_DEDUPE_WINDOW_MS = 5 * 60 * 1000;
  // L1 hot cache; canonical idempotency replay storage lives in SQLite via store.*
  const harnessCommandExecutionCache = new Map<
    string,
    { ts: number; response: Record<string, any> }
  >();
  const HARNESS_COMMAND_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
  const bootstrapRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const assistState = new Map<string, { sig: string; assist: any | null }>();
  const worktreeCache = new Map<string, { ts: number; items: any[]; root: string }>();
  const debugWs = process.env.FYP_DEBUG_WS === "1" || process.env.FYP_DEBUG_WS === "true";
  const wsLog = (...args: any[]) => {
    if (debugWs) console.log("[fyp/ws]", ...args);
  };
  const verboseLog = process.env.FYP_LOG === "1" || process.env.FYP_LOG === "true";
  const log = (...args: any[]) => {
    if (!verboseLog) return;
    try {
      console.log("[fyp]", ...args);
    } catch {
      // ignore
    }
  };
  const terminalModeEnv = String(process.env.FYP_ENABLE_TERMINAL_MODE ?? "").trim().toLowerCase();
  const terminalModeEnabled =
    terminalModeEnv === ""
      ? true
      : terminalModeEnv === "1" || terminalModeEnv === "true" || terminalModeEnv === "yes";

  // Codex App Server (structured protocol) for "Native" Codex sessions.
  // We start it on-demand when the first native session is created.
  const codexApp = new CodexAppServer({
    codexCommand: tools.codex.command,
    codexArgs: tools.codex.args,
    log: (msg, data) => log(msg, data),
  });
  const codexNativeThreadToSession = new Map<string, string>(); // threadId -> FYP sessionId
  const codexNativeThreadRun = new Map<string, { running: boolean; turnId: string | null }>(); // threadId -> status
  const codexNativeThreadMeta = new Map<string, { model: string; modelProvider: string; reasoningEffort: string | null }>(); // threadId -> meta
  const codexNativeRpcByAttentionId = new Map<number, { requestId: any; method: string }>(); // attentionId -> rpc
  const codexNativeUserInputByAttentionId = new Map<
    number,
    { requestId: any; threadId: string; questions: any[]; idx: number; answers: Record<string, string[]> }
  >();
  const closingSessions = new Set<string>();

  // Restore thread->session mapping after a server restart so native sessions keep working.
  try {
    for (const s of store.listSessions()) {
      const transport = String((s as any).transport ?? "pty");
      if (s.tool === "codex" && transport === "codex-app-server" && s.toolSessionId) {
        codexNativeThreadToSession.set(String(s.toolSessionId), s.id);
      }
    }
  } catch {
    // ignore
  }

  // Buffer DB writes for output chunks so heavy terminal output doesn't stall the UI.
  const outputBuf = new Map<string, { chunks: string[]; bytes: number; timer: any }>();
  function flushOutput(sessionId: string) {
    const rec = outputBuf.get(sessionId);
    if (!rec || rec.chunks.length === 0) return;
    if (rec.timer) {
      clearTimeout(rec.timer);
      rec.timer = null;
    }
    const joined = rec.chunks.join("");
    rec.chunks = [];
    rec.bytes = 0;
    try {
      store.appendOutput(sessionId, joined);
    } catch {
      // ignore
    }
  }
  function queueOutput(sessionId: string, chunk: string) {
    const rec = outputBuf.get(sessionId) ?? { chunks: [], bytes: 0, timer: null };
    rec.chunks.push(chunk);
    rec.bytes += chunk.length;
    outputBuf.set(sessionId, rec);
    if (rec.bytes > 96_000 || rec.chunks.length > 120) {
      flushOutput(sessionId);
      return;
    }
    if (!rec.timer) {
      rec.timer = setTimeout(() => flushOutput(sessionId), 90);
    }
  }

  function sessionTransport(s: any): string {
    return String((s as any)?.transport ?? "pty");
  }

  function isStoreSessionRunning(s: any): boolean {
    const transport = sessionTransport(s);
    if (transport === "pty") return sessions.getStatus(String(s.id))?.running ?? false;
    if (transport === "codex-app-server" && String(s?.tool ?? "") === "codex") {
      const threadId = typeof s?.toolSessionId === "string" ? String(s.toolSessionId) : "";
      if (!threadId) return false;
      return codexNativeThreadRun.get(threadId)?.running ?? false;
    }
    return false;
  }

  async function interruptCodexNativeThread(threadId: string, opts?: { forceClearRunState?: boolean }) {
    if (!threadId) return;
    const turnId = codexNativeThreadRun.get(threadId)?.turnId ?? null;
    if (turnId) {
      try {
        await codexApp.ensureStarted();
        await codexApp.call("turn/interrupt", { threadId, turnId });
      } catch {
        // ignore
      }
    }
    if (opts?.forceClearRunState) codexNativeThreadRun.set(threadId, { running: false, turnId: null });
  }

  function notifySessionSockets(sessionId: string, payload: unknown) {
    try {
      const set = sockets.get(sessionId);
      if (!set) return;
      for (const sock of set) {
        wsSend(sock, payload);
      }
    } catch {
      // ignore
    }
  }

  function closeSessionSockets(sessionId: string) {
    try {
      const set = sockets.get(sessionId);
      if (!set) return;
      for (const sock of set) {
        try {
          wsSend(sock, { type: "session.closed", ts: Date.now() });
          sock.close();
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    } finally {
      sockets.delete(sessionId);
    }
  }

  function cleanupSessionTransientState(sessionId: string) {
    outputBuf.delete(sessionId);
    textBuf.delete(sessionId);
    assistState.delete(sessionId);
    lastPreview.delete(sessionId);
    lastPreviewBroadcast.delete(sessionId);
    lastInboxBroadcast.delete(sessionId);
    orchestratorDispatchDirectiveRecent.delete(sessionId);
    orchestratorDispatchDirectiveCarry.delete(sessionId);
    clearBootstrapRetry(sessionId);
    firstUserBootstrapFallback.delete(sessionId);
    codexLinkExcludedIds.delete(sessionId);
    opencodeLinkExcludedIds.delete(sessionId);
    claudeHookSessions.delete(sessionId);
    for (const [sig, r] of claudeHookRequests.entries()) {
      if (r.sessionId === sessionId) claudeHookRequests.delete(sig);
    }
  }

  async function closeSessionLifecycle(input: {
    sessionId: string;
    storeSession: any;
    force: boolean;
    deleteRecord: boolean;
  }): Promise<{ ok: true; wasRunning: boolean }> {
    const { sessionId, storeSession, force, deleteRecord } = input;
    const transport = sessionTransport(storeSession);
    const wasRunning = isStoreSessionRunning(storeSession);

    if (transport === "pty") {
      if (force) {
        await sessions.close(sessionId, { force: true, graceMs: 1400 });
      } else {
        sessions.forget(sessionId);
      }
    } else if (transport === "codex-app-server" && storeSession.tool === "codex" && storeSession.toolSessionId) {
      if (force && wasRunning) {
        await interruptCodexNativeThread(String(storeSession.toolSessionId), { forceClearRunState: true });
      }
    }

    flushOutput(sessionId);
    closeSessionSockets(sessionId);

    if (deleteRecord) store.deleteSession(sessionId);

    cleanupSessionTransientState(sessionId);

    if (storeSession.tool === "codex" && transport === "codex-app-server" && storeSession.toolSessionId) {
      const threadId = String(storeSession.toolSessionId);
      codexNativeThreadToSession.delete(threadId);
      codexNativeThreadRun.delete(threadId);
      codexNativeThreadMeta.delete(threadId);
    }

    return { ok: true, wasRunning };
  }

  function stripAnsi(s: string): string {
    // Minimal ANSI stripper: good enough for prompt detection. We keep it dependency-free.
    // Also strip 8-bit C1 control sequences (e.g. CSI = 0x9B) which some terminals emit.
    // eslint-disable-next-line no-control-regex
    return s
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
      .replace(/\u009b[0-9;?]*[ -/]*[@-~]/g, "")
      // OSC (ESC ]) can be terminated by BEL (\u0007) or ST (ESC \\).
      .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, "")
      // OSC (C1) can be terminated by BEL (\u0007) or ST (\u009c).
      .replace(/\u009d[\s\S]*?(?:\u0007|\u009c)/g, "")
      // DCS (ESC P) uses ST (ESC \\) terminator.
      .replace(/\u001bP[\s\S]*?\u001b\\/g, "");
  }

  function collapseBackspaces(s: string): string {
    let out = "";
    for (const ch of s) {
      if (ch === "\b" || ch === "\u007f") {
        out = out.slice(0, -1);
        continue;
      }
      out += ch;
    }
    return out;
  }

  function updatePlainBuffer(sessionId: string, chunk: string): string {
    const prev = textBuf.get(sessionId) ?? "";
    const next = (prev + stripAnsi(chunk)).slice(-80_000);
    textBuf.set(sessionId, next);
    return next;
  }

  function updateLastLine(sessionId: string, chunk: string) {
    // Treat CR as a line boundary for previews. Many TUIs redraw the same line with `\r`,
    // and naive removal produces unreadable concatenated fragments like "StartStartiStarting...".
    const plain = collapseBackspaces(stripAnsi(chunk)).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const parts = plain.split("\n");
    for (let i = parts.length - 1; i >= 0; i--) {
      const ln = parts[i]!
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
        .replace(/\b\d{1,3}(?:;\d{1,3})+[A-Za-z]\b/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim();
      if (!ln) continue;
      lastPreview.set(sessionId, { ts: Date.now(), line: ln.slice(0, 220) });
      return;
    }
  }

  function wsSend(s: WebSocket, payload: unknown) {
    try {
      s.send(JSON.stringify(payload));
    } catch {
      // ignore
    }
  }

  function broadcastSession(sessionId: string, payload: unknown) {
    const set = sockets.get(sessionId);
    if (!set) return;
    for (const sock of set) wsSend(sock, payload);
  }

  function codexNativeSessionIdForThread(threadId: string): string | null {
    return codexNativeThreadToSession.get(threadId) ?? null;
  }

  function touchCodexNativePreview(sessionId: string, chunk: string) {
    try {
      updateLastLine(sessionId, chunk);
    } catch {
      // ignore
    }
  }

  codexApp.on("notification", (n: any) => {
    const method = typeof n?.method === "string" ? n.method : "";
    const p = (n?.params ?? null) as any;

    // Most Codex notifications include threadId. Some include a nested thread object.
    const threadId =
      typeof p?.threadId === "string"
        ? p.threadId
        : typeof p?.thread?.id === "string"
          ? p.thread.id
          : "";
    if (!threadId) return;
    const sessionId = codexNativeSessionIdForThread(threadId);
    if (!sessionId) return;

    if (method === "turn/started") {
      const turnId = typeof p?.turn?.id === "string" ? p.turn.id : typeof p?.turnId === "string" ? p.turnId : null;
      codexNativeThreadRun.set(threadId, { running: true, turnId });
      broadcastGlobal({ type: "sessions.changed" });
      broadcastGlobal({ type: "workspaces.changed" });
      broadcastSession(sessionId, { type: "codex.native.turn", event: "started", threadId, turnId, turn: p?.turn ?? null, ts: Date.now() });
      return;
    }

    if (method === "turn/completed") {
      const turnId = typeof p?.turn?.id === "string" ? p.turn.id : typeof p?.turnId === "string" ? p.turnId : null;
      codexNativeThreadRun.set(threadId, { running: false, turnId: null });
      broadcastGlobal({ type: "sessions.changed" });
      broadcastGlobal({ type: "workspaces.changed" });
      broadcastSession(sessionId, { type: "codex.native.turn", event: "completed", threadId, turnId, turn: p?.turn ?? null, ts: Date.now() });
      queueWorkerAutomationSignal(sessionId, "turn.completed", {
        delayMs: 500,
        minGapMs: 20_000,
        runSync: true,
        runReview: false,
        deliverToOrchestrator: false,
      });
      return;
    }

    if (method === "item/agentMessage/delta" && typeof p?.delta === "string") {
      touchCodexNativePreview(sessionId, p.delta);
      broadcastSession(sessionId, { type: "codex.native.delta", kind: "agent", ...p, ts: Date.now() });
      return;
    }
    if (method === "item/plan/delta" && typeof p?.delta === "string") {
      touchCodexNativePreview(sessionId, p.delta);
      broadcastSession(sessionId, { type: "codex.native.delta", kind: "plan", ...p, ts: Date.now() });
      return;
    }
    if (method === "item/reasoning/textDelta" && typeof p?.delta === "string") {
      touchCodexNativePreview(sessionId, p.delta);
      broadcastSession(sessionId, { type: "codex.native.delta", kind: "reasoning", ...p, ts: Date.now() });
      return;
    }
    if (method === "turn/diff/updated" && typeof p?.diff === "string") {
      broadcastSession(sessionId, { type: "codex.native.diff", threadId, turnId: p?.turnId ?? null, diff: p.diff, ts: Date.now() });
      return;
    }

    // Forward a small subset of other structured notifications for debugging and UI sync.
    if (
      method === "thread/name/updated" ||
      method === "thread/tokenUsage/updated" ||
      method === "item/started" ||
      method === "item/completed"
    ) {
      broadcastSession(sessionId, { type: "codex.native.notification", method, params: p, ts: Date.now() });
    }
  });

  codexApp.on("request", (r: any) => {
    const id = (r?.id ?? null) as any;
    const method = typeof r?.method === "string" ? r.method : "";
    const p = (r?.params ?? null) as any;
    if (!method) return;
    const threadId = typeof p?.threadId === "string" ? p.threadId : "";
    if (!threadId) return;
    const sessionId = codexNativeSessionIdForThread(threadId);
    if (!sessionId) return;

    // Command execution approval
    if (method === "item/commandExecution/requestApproval") {
      const cmd = typeof p?.command === "string" ? p.command : "";
      const reason = typeof p?.reason === "string" ? p.reason : "";
      const turnId = typeof p?.turnId === "string" ? p.turnId : "";
      const itemId = typeof p?.itemId === "string" ? p.itemId : "";
      const signature = `${sessionId}|codex.native.exec_approval|${threadId}|${turnId}|${itemId}`;
      const title = cmd ? "Codex approval: Run command" : "Codex approval: Run command";
      const body = cmd ? `$ ${cmd}` : reason ? reason : "Codex wants to run a command.";
      // Response shape per Codex App Server spec:
      // - accept: { decision:"accept", acceptSettings:{ forSession:boolean } }
      // - decline: { decision:"decline" }
      const options: any[] = [
        { id: "y", label: "Allow once", rpc: { requestId: id, result: { decision: "accept", acceptSettings: { forSession: false } } } },
        { id: "a", label: "Allow for session", rpc: { requestId: id, result: { decision: "accept", acceptSettings: { forSession: true } } } },
        { id: "n", label: "Deny", rpc: { requestId: id, result: { decision: "decline" } } },
      ];

      const created = store.createAttentionItem({
        sessionId,
        kind: "codex.native.approval.exec",
        severity: "danger",
        title,
        body,
        signature,
        options,
      });
      const attentionId = created.ok ? created.id : created.existingId ?? -1;
      if (attentionId !== -1) {
        codexNativeRpcByAttentionId.set(attentionId, { requestId: id, method });
        queueAttentionForOrchestrator(sessionId, attentionId, "codex.native.approval.exec");
      }
      broadcastGlobal({ type: "inbox.changed", sessionId });
      return;
    }

    // File change approval
    if (method === "item/fileChange/requestApproval") {
      const reason = typeof p?.reason === "string" ? p.reason : "";
      const turnId = typeof p?.turnId === "string" ? p.turnId : "";
      const itemId = typeof p?.itemId === "string" ? p.itemId : "";
      const signature = `${sessionId}|codex.native.file_approval|${threadId}|${turnId}|${itemId}`;
      const title = "Codex approval: Apply edits";
      const body = reason ? reason : "Codex produced file edits and is asking to apply them.";
      const options: any[] = [
        { id: "y", label: "Accept", rpc: { requestId: id, result: { decision: "accept" } } },
        { id: "n", label: "Decline", rpc: { requestId: id, result: { decision: "decline" } } },
      ];

      const created = store.createAttentionItem({
        sessionId,
        kind: "codex.native.approval.file",
        severity: "warn",
        title,
        body,
        signature,
        options,
      });
      const attentionId = created.ok ? created.id : created.existingId ?? -1;
      if (attentionId !== -1) {
        codexNativeRpcByAttentionId.set(attentionId, { requestId: id, method });
        queueAttentionForOrchestrator(sessionId, attentionId, "codex.native.approval.file");
      }
      broadcastGlobal({ type: "inbox.changed", sessionId });
      return;
    }

    // request_user_input (touch UI)
    if (method === "tool/requestUserInput" || method === "item/tool/requestUserInput") {
      const questions = Array.isArray(p?.questions) ? p.questions : [];
      const turnId = typeof p?.turnId === "string" ? p.turnId : "";
      const itemId = typeof p?.itemId === "string" ? p.itemId : "";
      const signature = `${sessionId}|codex.native.user_input|${threadId}|${turnId}|${itemId}`;

      const q0 = questions[0] ?? null;
      const qId = typeof q0?.id === "string" ? q0.id : "";
      const qHeader = typeof q0?.header === "string" && q0.header ? q0.header : "Codex needs input";
      const qText = typeof q0?.question === "string" && q0.question ? q0.question : "Select an option to continue.";
      const rawOpts = Array.isArray(q0?.options) ? q0.options : [];

      const options: any[] = rawOpts.length
        ? rawOpts.slice(0, 10).map((o: any, idx: number) => ({
            id: String(idx + 1),
            label: String(o?.label ?? `Option ${idx + 1}`),
            userInput: { questionId: qId, answers: [String(o?.label ?? "")] },
          }))
        : [{ id: "n", label: "Not supported (needs text input)", userInput: { questionId: qId, answers: [""] } }];

      const created = store.createAttentionItem({
        sessionId,
        kind: "codex.native.user_input",
        severity: "info",
        title: qHeader,
        body: qText,
        signature,
        options,
      });
      const attentionId = created.ok ? created.id : created.existingId ?? -1;
      if (attentionId !== -1) {
        codexNativeUserInputByAttentionId.set(attentionId, { requestId: id, threadId, questions, idx: 0, answers: {} });
        queueAttentionForOrchestrator(sessionId, attentionId, "codex.native.user_input");
      }
      broadcastGlobal({ type: "inbox.changed", sessionId });
      return;
    }
  });

  function setAssist(sessionId: string, assist: any | null) {
    const sig = assist && typeof assist.signature === "string" ? assist.signature : "";
    const prev = assistState.get(sessionId)?.sig ?? "";
    if (sig === prev) return;
    assistState.set(sessionId, { sig, assist });
    const set = sockets.get(sessionId);
    if (!set) return;
    for (const sock of set) wsSend(sock, { type: "assist", assist, ts: Date.now() });
  }

  function attachBroadcast(sessionId: string, tool: ToolId) {
    sessions.onOutput(sessionId, (chunk) => {
      queueOutput(sessionId, chunk);
      updateLastLine(sessionId, chunk);
      const latestLine = lastPreview.get(sessionId)?.line ?? "";
      if (looksLikeWorkerCompletionCue(latestLine)) {
        const found = findOrchestrationByWorkerSession(sessionId);
        if (found) markWorkerDoneLatch(found.orchestrationId, sessionId, "completion.cue");
        queueWorkerAutomationSignal(sessionId, "completion.cue", {
          delayMs: 420,
          minGapMs: 30_000,
          runSync: true,
          runReview: true,
          deliverToOrchestrator: true,
        });
      }
      if (looksLikeWorkerQuestionCue(latestLine)) {
        const found = findOrchestrationByWorkerSession(sessionId);
        if (found) clearWorkerDoneLatch(found.orchestrationId, sessionId);
        queueWorkerAutomationSignal(sessionId, "question.cue", {
          delayMs: 220,
          minGapMs: 20_000,
          runSync: true,
          runReview: true,
          deliverToOrchestrator: true,
        });
      }
      const buf = updatePlainBuffer(sessionId, chunk);
      const tail = buf.slice(-9000);
      if (looksLikeWorkerQuestionCue(tail)) {
        const found = findOrchestrationByWorkerSession(sessionId);
        if (found) clearWorkerDoneLatch(found.orchestrationId, sessionId);
        queueWorkerAutomationSignal(sessionId, "question.cue.tail", {
          delayMs: 240,
          minGapMs: 24_000,
          runSync: true,
          runReview: true,
          deliverToOrchestrator: true,
        });
      }

      const orchestratedBy = findOrchestrationByOrchestratorSession(sessionId);
      if (orchestratedBy) {
        const controlDirectives = parseOrchestratorControlDirectivesForSession(sessionId, chunk);
        for (const d of controlDirectives.dispatches) {
          void dispatchFromOrchestratorDirective(
            orchestratedBy.orchestrationId,
            orchestratedBy.rec,
            d,
            "orchestrator.directive",
          ).catch(() => undefined);
        }
        for (const qa of controlDirectives.questionAnswers) {
          void submitQuestionAnswerDirective(qa).catch(() => undefined);
        }
      }

      // Light global preview updates (throttled).
      const lastTs = lastPreviewBroadcast.get(sessionId) ?? 0;
      if (Date.now() - lastTs > 900) {
        const p = lastPreview.get(sessionId);
        if (p?.line) {
          lastPreviewBroadcast.set(sessionId, Date.now());
          broadcastGlobal({ type: "session.preview", sessionId, line: p.line, ts: p.ts });
        }
      }

      // Lightweight Codex approval detection. Best with `codex --no-alt-screen`.
      // We do not spam: signature dedupe is enforced in the store.
      if (tool === "codex") {
        const cand = detectCodexAttention(sessionId, tail);
        if (cand) {
          const created = store.createAttentionItem(cand);
          const attentionId = created.ok ? created.id : created.existingId ?? -1;
          if (attentionId !== -1) queueAttentionForOrchestrator(sessionId, attentionId, String(cand.kind));
          // Throttle broadcasts so the phone UI updates even when we touch/refresh an existing item.
          const last = lastInboxBroadcast.get(sessionId) ?? 0;
          if (Date.now() - last > 900) {
            lastInboxBroadcast.set(sessionId, Date.now());
            broadcastGlobal({ type: "inbox.changed", sessionId });
          }
        }
      }

      // TUI Assist: best-effort option/menu detection for touch-friendly buttons on phones.
      // This is intentionally generic (not tool-specific), so it survives small TUI text changes.
      try {
        const assist = detectTuiAssist(tail);
        setAssist(sessionId, assist);
      } catch {
        // ignore
      }

      const set = sockets.get(sessionId);
      if (!set) return;
      for (const sock of set) wsSend(sock, { type: "output", chunk, ts: Date.now() });
    });
  }

  function attachExitTracking(sessionId: string) {
    sessions.onExit(sessionId, (st) => {
      try {
        const exists = store.getSession(sessionId);
        if (!exists) return;
        flushOutput(sessionId);
        try {
          store.setSessionExit(sessionId, st.exitCode ?? null, st.signal ?? null);
        } catch {
          // ignore
        }
        let evId = -1;
        try {
          evId = store.appendEvent(sessionId, "session.exit", { exitCode: st.exitCode ?? null, signal: st.signal ?? null });
        } catch {
          evId = -1;
        }
        log("session exit", { sessionId, exitCode: st.exitCode ?? null, signal: st.signal ?? null });
        if (evId !== -1) {
          broadcastEvent(sessionId, {
            id: evId,
            ts: Date.now(),
            kind: "session.exit",
            data: { exitCode: st.exitCode ?? null, signal: st.signal ?? null },
          });
        }
        queueWorkerAutomationSignal(sessionId, "session.exit", {
          delayMs: 180,
          minGapMs: 0,
          runSync: true,
          runReview: true,
          forceSync: true,
          deliverToOrchestrator: true,
        });
        broadcastGlobal({ type: "sessions.changed" });
        broadcastGlobal({ type: "workspaces.changed" });
      } catch {
        // ignore
      } finally {
        // Best-effort cleanup to avoid unbounded memory growth if many sessions are spawned.
        cleanupSessionTransientState(sessionId);
      }
    });
  }

  function broadcastGlobal(payload: unknown) {
    for (const sock of globalSockets) wsSend(sock, payload);
  }

  function broadcastEvent(sessionId: string, evt: { id: number; ts: number; kind: string; data: unknown }) {
    const set = sockets.get(sessionId);
    if (!set) return;
    const payload = { type: "event", event: evt };
    for (const sock of set) wsSend(sock, payload);
  }

  function detectCodexAttention(sessionId: string, text: string): null | {
    sessionId: string;
    kind: string;
    severity: "info" | "warn" | "danger";
    title: string;
    body: string;
    signature: string;
    options: any;
  } {
    // Titles + option labels from Codex TUI source:
    // - "Would you like to run the following command?"
    // - "Would you like to make the following edits?"
    // - "Do you want to approve access to \"<host>\"?"
    // - "<server> needs your approval."
    // Options commonly have shortcuts: y / a / p / n / Esc / c (mcp cancel)
    const t = text;

    // Network approval
    const mHost = t.match(/Do you want to approve access to "([^"]+)"\?/);
    if (mHost?.[1]) {
      const host = mHost[1];
      const title = `Network access: ${host}`;
      const signature = `${sessionId}|codex.approval|net|${host}`;
      const options = [
        { id: "y", label: "Yes, just this once (Y)", send: "y" },
        { id: "a", label: "Yes, allow this host for session (A)", send: "a" },
        { id: "n", label: "No, tell Codex what to do (N / Esc)", send: "n" },
        { id: "esc", label: "Esc", send: "\u001b" },
      ];
      return {
        sessionId,
        kind: "codex.approval",
        severity: "danger",
        title,
        body: "Codex is requesting network access.",
        signature,
        options,
      };
    }

    // Exec approval
    if (t.includes("Would you like to run the following command?")) {
      // Best-effort snippet extraction: look for first "$ ..." line after the title.
      const mCmd = t.match(/Would you like to run the following command\\?[\\s\\S]{0,800}?\\$\\s*([^\\n\\r]{1,180})/);
      const cmd = mCmd?.[1]?.trim() ?? "";
      const title = "Run command approval";
      const signature = `${sessionId}|codex.approval|exec|${cmd || "unknown"}`;
      const hasPrefixOpt = t.includes("don't ask again for commands that start with `");
      const options = [
        { id: "y", label: "Yes, proceed (Y)", send: "y" },
        ...(hasPrefixOpt ? [{ id: "p", label: "Yes, don't ask again for this prefix (P)", send: "p" }] : []),
        { id: "n", label: "No, tell Codex what to do (N / Esc)", send: "n" },
        { id: "esc", label: "Esc", send: "\u001b" },
      ];
      return {
        sessionId,
        kind: "codex.approval",
        severity: "warn",
        title,
        body: cmd ? `$ ${cmd}` : "Codex wants to run a command.",
        signature,
        options,
      };
    }

    // Patch approval
    if (t.includes("Would you like to make the following edits?")) {
      const signature = `${sessionId}|codex.approval|patch`;
      const options = [
        { id: "y", label: "Yes, proceed (Y)", send: "y" },
        { id: "a", label: "Yes, don't ask again for these files (A)", send: "a" },
        { id: "n", label: "No, tell Codex what to do (N / Esc)", send: "n" },
        { id: "esc", label: "Esc", send: "\u001b" },
      ];
      return {
        sessionId,
        kind: "codex.approval",
        severity: "warn",
        title: "Apply edits approval",
        body: "Codex produced edits and is asking to apply them.",
        signature,
        options,
      };
    }

    // MCP elicitation approval
    const mMcp = t.match(/\\b([^\\n\\r]{1,60}) needs your approval\\./);
    if (mMcp?.[1]) {
      const serverName = mMcp[1].trim();
      const signature = `${sessionId}|codex.approval|mcp|${serverName}`;
      const options = [
        { id: "y", label: "Yes, provide requested info (Y)", send: "y" },
        { id: "n", label: "No, continue without it (N)", send: "n" },
        { id: "c", label: "Cancel request (C / Esc)", send: "c" },
        { id: "esc", label: "Esc", send: "\u001b" },
      ];
      return {
        sessionId,
        kind: "codex.approval",
        severity: "info",
        title: `MCP approval: ${serverName}`,
        body: "A tool/server is requesting approval.",
        signature,
        options,
      };
    }

    return null;
  }

  function detectTuiAssist(text: string): null | { title: string; body: string | null; options: any[]; signature: string } {
    // Generic prompt/menu detector for touch UIs:
    // - Extracts the most recent question-ish line (title)
    // - Extracts option hotkeys like "(Y) Yes", "1) Foo", "[A] Allow"
    // - Emits a stable signature so the UI can update without spamming
    // Treat CR as a line boundary so redraw-heavy TUIs don't concatenate fragments.
    const raw = String(text ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (!raw.trim()) return null;

    const linesAll = raw.split("\n");
    const lines = linesAll.slice(Math.max(0, linesAll.length - 90)).map((l) => String(l ?? "").trimEnd());
    while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop();
    if (!lines.length) return null;

    const opts: { id: string; label: string; send: string }[] = [];
    const seen = new Set<string>();
    const pushOpt = (send: string, label: string) => {
      const s = String(send ?? "");
      const l = String(label ?? "").trim();
      if (!s || !l) return;
      if (seen.has(s)) return;
      if (opts.length >= 10) return;
      seen.add(s);
      opts.push({ id: s, label: l.length > 60 ? l.slice(0, 60) : l, send: s });
    };

    const parseOptionLine = (ln: string) => {
      const line = ln.trim();
      if (!line) return;

      // Inline: "... (Y) Yes (N) No ..."
      const inlineRe = /\(([A-Za-z0-9])\)\s*([A-Za-z][^()]{0,50})/g;
      let m: RegExpExecArray | null = null;
      // eslint-disable-next-line no-cond-assign
      while ((m = inlineRe.exec(line))) {
        const key = String(m[1] ?? "").trim();
        const label = String(m[2] ?? "").trim().replace(/^[,;:\-]+/, "").trim();
        if (!key || !label) continue;
        pushOpt(key.toLowerCase(), label);
      }

      // [Y] Yes
      const b = line.match(/^\s*\[([A-Za-z0-9])\]\s*(.{2,80})\s*$/);
      if (b?.[1] && b?.[2]) pushOpt(String(b[1]).toLowerCase(), String(b[2]));

      // (Y) Yes
      const p = line.match(/^\s*\(([A-Za-z0-9])\)\s*(.{2,80})\s*$/);
      if (p?.[1] && p?.[2]) pushOpt(String(p[1]).toLowerCase(), String(p[2]));

      // Y) Yes
      const r = line.match(/^\s*([A-Za-z0-9])\)\s*(.{2,80})\s*$/);
      if (r?.[1] && r?.[2]) pushOpt(String(r[1]).toLowerCase(), String(r[2]));

      // 1) Foo / 1. Foo
      const n = line.match(/^\s*([0-9]{1,2})[.)]\s*(.{2,80})\s*$/);
      if (n?.[1] && n?.[2]) pushOpt(String(n[1]), String(n[2]));

      // y/n quick prompt (no labels). We map to Yes/No.
      if (/\b[yY]\/[nN]\b/.test(line) || /\b[nN]\/[yY]\b/.test(line)) {
        pushOpt("y", "Yes");
        pushOpt("n", "No");
      }
    };

    // Scan recent lines for options.
    const scanStart = Math.max(0, lines.length - 34);
    for (let i = scanStart; i < lines.length; i++) parseOptionLine(lines[i]!);

    // "Type/Reply with CODE ..." confirmation prompts.
    // Codex sometimes asks for an explicit code instead of a (Y/N) hotkey.
    const tailText = lines.slice(scanStart).join("\n");
    const codeRe =
      /\b(?:reply\s+with|type)\s+([A-Za-z0-9]{4,12})\b(?:\s+(?:only|to\s+(?:continue|proceed|confirm)|to\s+approve))?/i;
    const mCode = tailText.match(codeRe);
    if (mCode?.[1]) {
      const code = String(mCode[1]).trim();
      if (code) pushOpt(code + "\r", `Reply ${code}`);
    }

    // Also surface common navigation hints as single-tap buttons when they appear in the text.
    // Keep this conservative to avoid showing the overlay during normal terminal output.
    const lowTail = lines.slice(scanStart).join("\n").toLowerCase();
    const hadChoices = opts.length > 0;
    const hasShiftTab = /\bshift\s*[\+\- ]?\s*tab\b/.test(lowTail) || lowTail.includes("shift-tab");
    const hasPressTab = /\b(?:press|hit)\s+tab\b/.test(lowTail);
    const hasPressEnter = /\b(?:press|hit)\s+enter\b/.test(lowTail);
    const hasPressEsc = /\b(?:press|hit)\s+(?:esc|escape)\b/.test(lowTail);
    const hasArrowKeys = /\barrow\s+keys\b/.test(lowTail);

    if (!hadChoices && !hasShiftTab && !hasPressTab && !hasPressEnter && !hasPressEsc && !hasArrowKeys) return null;

    if (hasShiftTab) pushOpt("\u001b[Z", "Shift+Tab");
    if (hasPressTab || hasShiftTab) pushOpt("\t", "Tab");
    if (hasPressEnter) pushOpt("\r", "Enter");
    if (hasPressEsc || (hadChoices && /\b(?:esc|escape)\b/.test(lowTail))) pushOpt("\u001b", "Esc");
    if (hasArrowKeys) {
      pushOpt("\u001b[A", "Up");
      pushOpt("\u001b[B", "Down");
      pushOpt("\r", "Enter");
    }

    if (opts.length === 0) return null;

    // Pick a reasonable title.
    let title = "";
    let body: string | null = null;
    for (let i = lines.length - 1; i >= 0 && lines.length - i <= 42; i--) {
      const ln = lines[i]!.trim();
      if (!ln) continue;
      if (ln.length > 220) continue;
      if (ln.includes("?") || /^(select|choose|pick|press|permission|mode|sandbox|approval)\b/i.test(ln)) {
        title = ln;
        break;
      }
      if (!title) title = ln;
    }
    title = title ? title.slice(0, 140) : "TUI";

    for (let i = lines.length - 1; i >= 0 && lines.length - i <= 30; i--) {
      const ln = lines[i]!.trim();
      if (!ln) continue;
      const low = ln.toLowerCase();
      if (low.includes("arrow") || low.includes("shift+tab") || low.includes("escape") || low.includes("press enter")) {
        body = ln.slice(0, 240);
        break;
      }
    }

    const sig = createHash("sha256")
      .update(JSON.stringify({ title, body, options: opts.map((o) => ({ id: o.id, label: o.label })) }))
      .digest("hex")
      .slice(0, 16);

    return { title, body, options: opts, signature: `assist:${sig}` };
  }

  // Tracks linking attempts so repeated inputs don't start overlapping scans.
  const codexToolSessionLinkInFlight = new Set<string>();
  const opencodeToolSessionLinkInFlight = new Set<string>();
  const codexToolSessionsCache = { ts: 0, items: [] as ToolSessionSummary[] };
  const CODEX_TOOL_SESSIONS_MIN_REFRESH_MS = 1500;
  // Snapshot of tool-native sessions that already existed when a FYP session was spawned.
  // We never auto-link to these IDs to avoid attaching a new FYP session to an unrelated old tool session.
  const codexLinkExcludedIds = new Map<string, Set<string>>();
  const opencodeLinkExcludedIds = new Map<string, Set<string>>();

  function listCodexToolSessionsCached(opts?: { refresh?: boolean }): ToolSessionSummary[] {
    const refresh = opts?.refresh === true;
    const now = Date.now();
    const age = now - Number(codexToolSessionsCache.ts || 0);
    if (codexToolSessionsCache.items.length > 0 && age < CODEX_TOOL_SESSIONS_MIN_REFRESH_MS) {
      return codexToolSessionsCache.items.slice();
    }
    const items = toolIndex.list({ refresh: true }).filter((s) => s.tool === "codex");
    codexToolSessionsCache.ts = now;
    codexToolSessionsCache.items = items;
    return items.slice();
  }

  function createCwdMatcher(cwd: string): (p: string) => boolean {
    const normCwd = path.resolve(cwd);
    let normCwdReal = "";
    try {
      normCwdReal = fs.realpathSync(normCwd);
    } catch {
      normCwdReal = "";
    }
    return (p: string): boolean => {
      const resolved = path.resolve(p);
      if (resolved === normCwd) return true;
      if (!normCwdReal) return false;
      try {
        return fs.realpathSync(resolved) === normCwdReal;
      } catch {
        return false;
      }
    };
  }

  function snapshotCodexSessionIds(cwd: string): Set<string> {
    const matchCwd = createCwdMatcher(cwd);
    const ids = new Set<string>();
    try {
      const items = listCodexToolSessionsCached({ refresh: true });
      for (const it of items) {
        if (!matchCwd(it.cwd)) continue;
        const sid = String(it.id ?? "").trim();
        if (sid) ids.add(sid);
      }
    } catch {
      // ignore
    }
    return ids;
  }

  async function snapshotOpenCodeSessionIds(cwd: string): Promise<Set<string>> {
    const matchCwd = createCwdMatcher(cwd);
    const ids = new Set<string>();
    try {
      const items = await listOpenCodeToolSessionsForPath(cwd, { refresh: true });
      for (const it of items) {
        if (it.tool !== "opencode") continue;
        if (!matchCwd(it.cwd)) continue;
        const sid = String(it.id ?? "").trim();
        if (sid) ids.add(sid);
      }
    } catch {
      // ignore
    }
    return ids;
  }

  function getCodexLinkExcludedIds(fypSessionId: string): Set<string> {
    return codexLinkExcludedIds.get(fypSessionId) ?? new Set<string>();
  }

  function getOpenCodeLinkExcludedIds(fypSessionId: string): Set<string> {
    return opencodeLinkExcludedIds.get(fypSessionId) ?? new Set<string>();
  }

  function scheduleCodexToolSessionLink(
    fypSessionId: string,
    cwd: string,
    createdAt: number,
    opts?: { excludedIds?: Set<string> },
  ) {
    // Codex does not let us set the session UUID ahead of time, so we discover it by scanning
    // the ~/.codex/sessions logs shortly after spawn.
    // Notes:
    // - Codex may resume an existing session log whose *createdAt* is older than this FYP session.
    //   In that case, the session is still "new" to us if the log is being written now.
    // - We also re-trigger linking on first input (HTTP/WS) in case the log appears late.
    // Codex may create/update its session log a few seconds after spawning,
    // especially on slower disks or when resuming an existing session.
    const maxAttempts = 32;
    const baseDelayMs = 250;
    const stepMs = 650;
    const matchCwd = createCwdMatcher(cwd);
    const excludedIds = opts?.excludedIds ?? getCodexLinkExcludedIds(fypSessionId);
    if (codexToolSessionLinkInFlight.has(fypSessionId)) return;
    codexToolSessionLinkInFlight.add(fypSessionId);

    const done = () => {
      try {
        codexToolSessionLinkInFlight.delete(fypSessionId);
      } catch {
        // ignore
      }
    };

    const attempt = (n: number) => {
      const delay = baseDelayMs + n * stepMs + Math.floor(Math.random() * 80);
      setTimeout(() => {
        try {
          const cur = store.getSession(fypSessionId);
          if (!cur) {
            done();
            return;
          }
          if (cur.toolSessionId) {
            done();
            return;
          }

          const shouldRefresh = n === 0 || n % 4 === 0;
          const items = listCodexToolSessionsCached({ refresh: shouldRefresh })
            .filter((s) => matchCwd(s.cwd))
            .filter((s) => !excludedIds.has(String(s.id)))
            .sort((a, b) => b.updatedAt - a.updatedAt);

          const cutoff = createdAt - 12_000;
          const recent = items.filter((s) => Math.max(Number(s.updatedAt ?? 0), Number(s.createdAt ?? 0)) >= cutoff);
          const cand = recent[0] ?? null;

          if (!cand) {
            if (n + 1 < maxAttempts) attempt(n + 1);
            else done();
            return;
          }

          // Avoid linking two FYP sessions to the same Codex session id.
          const dup = store.listSessions().find((s) => s.id !== fypSessionId && s.toolSessionId === cand.id) ?? null;
          if (dup) {
            if (n + 1 < maxAttempts) attempt(n + 1);
            else done();
            return;
          }

          store.setSessionToolSessionId(fypSessionId, cand.id);
          const evId = store.appendEvent(fypSessionId, "session.tool_link", { tool: "codex", toolSessionId: cand.id });
          if (evId !== -1) {
            broadcastEvent(fypSessionId, { id: evId, ts: Date.now(), kind: "session.tool_link", data: { tool: "codex", toolSessionId: cand.id } });
          }
          broadcastGlobal({ type: "sessions.changed" });
          broadcastGlobal({ type: "workspaces.changed" });
          done();
        } catch {
          if (n + 1 >= maxAttempts) done();
          // ignore
        }
      }, delay).unref?.();
    };

    attempt(0);
  }

  function scheduleOpenCodeToolSessionLink(
    fypSessionId: string,
    cwd: string,
    createdAt: number,
    opts?: { excludedIds?: Set<string> },
  ) {
    // OpenCode doesn't expose the new session id to stdout, so we discover it by listing
    // recent sessions and picking the most-recent one for this directory.
    // We re-trigger on first input (HTTP/WS) in case the session is created late.
    const maxAttempts = 22;
    const baseDelayMs = 320;
    const stepMs = 720;
    const matchCwd = createCwdMatcher(cwd);
    const excludedIds = opts?.excludedIds ?? getOpenCodeLinkExcludedIds(fypSessionId);
    if (opencodeToolSessionLinkInFlight.has(fypSessionId)) return;
    opencodeToolSessionLinkInFlight.add(fypSessionId);

    const done = () => {
      try {
        opencodeToolSessionLinkInFlight.delete(fypSessionId);
      } catch {
        // ignore
      }
    };

    const attempt = (n: number) => {
      const delay = baseDelayMs + n * stepMs + Math.floor(Math.random() * 120);
      setTimeout(() => {
        void (async () => {
          try {
            const cur = store.getSession(fypSessionId);
            if (!cur || cur.tool !== "opencode") {
              done();
              return;
            }
            if (cur.toolSessionId) {
              done();
              return;
            }

            const shouldRefresh = n === 0 || n % 3 === 0;
            const items = (await listOpenCodeToolSessionsForPath(cwd, { refresh: shouldRefresh }))
              .filter((s) => s.tool === "opencode" && matchCwd(s.cwd))
              .filter((s) => !excludedIds.has(String(s.id)))
              .sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0));

            const cutoff = createdAt - 12_000;
            const recent = items.filter((s) => Math.max(Number(s.updatedAt ?? 0), Number(s.createdAt ?? 0)) >= cutoff);
            const cand = recent[0] ?? null;
            if (!cand) {
              if (n + 1 < maxAttempts) attempt(n + 1);
              else done();
              return;
            }

            // Avoid linking two FYP sessions to the same OpenCode session id.
            const dup = store.listSessions().find((s) => s.id !== fypSessionId && s.toolSessionId === cand.id) ?? null;
            if (dup) {
              if (n + 1 < maxAttempts) attempt(n + 1);
              else done();
              return;
            }

            store.setSessionToolSessionId(fypSessionId, cand.id);
            const evId = store.appendEvent(fypSessionId, "session.tool_link", { tool: "opencode", toolSessionId: cand.id });
            if (evId !== -1) {
              broadcastEvent(fypSessionId, {
                id: evId,
                ts: Date.now(),
                kind: "session.tool_link",
                data: { tool: "opencode", toolSessionId: cand.id },
              });
            }
            broadcastGlobal({ type: "sessions.changed" });
            broadcastGlobal({ type: "workspaces.changed" });
            done();
          } catch {
            if (n + 1 >= maxAttempts) done();
            // ignore
          }
        })();
      }, delay).unref?.();
    };

    attempt(0);
  }

  // Pairing: generate short code so you don’t have to paste long tokens.
  app.post("/api/auth/pair/start", async () => {
    const rec = pairing.start();
    return { ok: true, code: rec.code, expiresAt: rec.expiresAt };
  });

  // Clear the auth cookie on this device (useful for debugging or changing hosts).
  // No auth required because it only removes access, it doesn't grant access.
  app.post("/api/auth/logout", async (_req, reply) => {
    reply.setCookie("fyp_token", "", {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
    return { ok: true };
  });

  // No auth required. Exchange a short-lived code for the httpOnly cookie.
  app.post("/api/auth/pair/claim", async (req, reply) => {
    const body = (req.body ?? {}) as any;
    const code = typeof body.code === "string" ? body.code : "";
    const r = pairing.claim(code);
    if (!r.ok) return reply.code(400).send({ ok: false, reason: r.reason });
    reply.setCookie("fyp_token", cfg.token, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    return { ok: true };
  });

  app.get("/api/doctor", async () => {
    const caps = await detector.get();
    return {
      ok: true,
      scannedAt: caps.scannedAt,
      app: {
        name: typeof appPkg?.name === "string" ? appPkg.name : null,
        version: typeof appPkg?.version === "string" ? appPkg.version : null,
        root: appRoot,
        moduleDir,
        webRoot,
      },
      process: {
        pid: process.pid,
        cwd: process.cwd(),
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      tools: caps,
      features: {
        terminalModeEnabled,
      },
      store: store.doctor(),
      workspaceRoots: roots,
    };
  });

  app.post("/api/doctor/rescan", async () => {
    const caps = await detector.scan();
    return {
      ok: true,
      scannedAt: caps.scannedAt,
      app: {
        name: typeof appPkg?.name === "string" ? appPkg.name : null,
        version: typeof appPkg?.version === "string" ? appPkg.version : null,
        root: appRoot,
        moduleDir,
        webRoot,
      },
      process: {
        pid: process.pid,
        cwd: process.cwd(),
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      tools: caps,
      features: {
        terminalModeEnabled,
      },
      store: store.doctor(),
      workspaceRoots: roots,
    };
  });

  app.get("/api/features", async () => {
    return {
      ok: true,
      features: {
        terminalModeEnabled,
      },
    };
  });

  app.get("/api/harness/prompts", async () => {
    return {
      ok: true,
      prompts: {
        genericKnowledge: buildGenericKnowledgePrompt(),
        creatorSystem: buildCreatorSystemPrompt(),
        improverSystem: buildImproverSystemPrompt(),
        masterSystemLibrary: buildMasterSystemPromptLibrary({ minLines: 4096 }),
      },
      commandCatalog: defaultCommandCatalog(),
    };
  });

  app.get("/api/harness/commands", async () => {
    const commands = defaultCommandCatalog().map((c) => {
      const mode = commandExecutionModeForId(c.id);
      const schema = buildHarnessCommandPayloadSchema({
        commandId: c.id,
        mode: mode.mode,
      });
      const policy = buildHarnessCommandPolicyMeta({
        commandId: c.id,
        mode: mode.mode,
      });
      return {
        ...c,
        execution: {
          mode: mode.mode,
          defaultTarget: mode.defaultTarget,
          includeBootstrapIfPresent: mode.includeBootstrapIfPresent,
          defaultPriority: mode.defaultPriority,
        },
        payloadSchema: schema.schema,
        payloadRules: {
          requiredNonEmpty: schema.requiredNonEmpty,
          requiredAnyOf: schema.requiredAnyOf,
        },
        policy,
      };
    });
    return {
      ok: true,
      count: commands.length,
      commands,
      route: "/api/orchestrations/:id/commands/execute",
      examples: {
        runWorkerTask: {
          commandId: "diag-evidence",
          target: "worker:Worker A",
          task: "Reproduce startup stall and capture root-cause evidence.",
          scope: ["server/src/app.ts", "server/test/harness.test.ts"],
          verify: ["npm run test -- server/test/harness.test.ts"],
          priority: "HIGH",
        },
        runSystemSync: {
          commandId: "sync-status",
          force: true,
          deliverToOrchestrator: true,
        },
      },
    };
  });

  app.get("/api/harness/sota-audit", async (req) => {
    const q = (req.query ?? {}) as any;
    const parseNum = (v: any): number | undefined => {
      const n = Number(v);
      return Number.isFinite(n) ? n : undefined;
    };
    const rootsRaw = Array.isArray(q?.roots)
      ? q.roots.map((v: any) => String(v ?? "").trim()).filter(Boolean)
      : typeof q?.roots === "string"
        ? q.roots.split(",").map((v: string) => v.trim()).filter(Boolean)
        : [];

    const audit = buildHarnessSotaAudit({
      skillRoots: rootsRaw,
      sampleSize: parseNum(q?.sampleSize),
      maxSkills: parseNum(q?.maxSkills),
      commandCatalog: defaultCommandCatalog(),
    });

    return {
      ok: true,
      audit,
    };
  });

  app.post("/api/harness/creator/recommend", async (req, reply) => {
    const body = (req.body ?? {}) as any;
    const objective = toNonEmpty(body?.objective || body?.goal || body?.task);
    if (!objective) return reply.code(400).send({ ok: false, error: "missing_objective" });

    const prefs = toHarnessPrefs(body?.prefs ?? {});
    let scan: WorkspaceScanSummary | null = null;
    let projectPath: string | null = null;
    const projectPathRaw = toNonEmpty(body?.projectPath);
    if (prefs.allowWorkspaceScan && projectPathRaw) {
      const v = validateCwd(projectPathRaw, roots);
      if (!v.ok) return reply.code(400).send({ ok: false, error: "bad_projectPath", reason: v.reason });
      projectPath = v.cwd;
      scan = summarizeWorkspaceForHarness(projectPath);
    }

    const rec = recommendHarnessPlan({ objective, prefs, scan });
    return {
      ok: true,
      recommendation: rec,
      context: {
        objective,
        projectPath,
        prefs,
        scan,
      },
    };
  });

  app.post("/api/harness/creator/build", async (req, reply) => {
    const body = (req.body ?? {}) as any;
    const objective = toNonEmpty(body?.objective || body?.goal || body?.task);
    if (!objective) return reply.code(400).send({ ok: false, error: "missing_objective" });

    const projectPathRaw = toNonEmpty(body?.projectPath);
    if (!projectPathRaw) return reply.code(400).send({ ok: false, error: "missing_projectPath" });
    const vProject = validateCwd(projectPathRaw, roots);
    if (!vProject.ok) return reply.code(400).send({ ok: false, error: "bad_projectPath", reason: vProject.reason });
    const projectPath = vProject.cwd;

    const prefs = toHarnessPrefs(body?.prefs ?? {});
    const scan = prefs.allowWorkspaceScan ? summarizeWorkspaceForHarness(projectPath) : null;
    const recommendation = recommendHarnessPlan({ objective, prefs, scan });
    const behavior = normalizeCreatorBuildBehavior(body?.behavior ?? {});

    const dispatchModeRaw = toNonEmpty(body?.dispatchMode || recommendation.orchestrator.dispatchMode);
    const dispatchMode = dispatchModeRaw === "worker-first" ? "worker-first" : "orchestrator-first";

    const manualWorkers = Array.isArray(body?.workers) ? body.workers : null;
    const workerPlanSource = (manualWorkers && manualWorkers.length > 0
      ? manualWorkers.map((w: any, i: number) => ({
          name: toNonEmpty(w?.name) || recommendation.workers[i]?.name || `worker-${i + 1}`,
          role: toNonEmpty(w?.role) || recommendation.workers[i]?.role || "Worker",
          tool: toToolId(w?.tool, recommendation.workers[i]?.tool ?? "codex"),
          profileId: toNonEmpty(w?.profileId) || recommendation.workers[i]?.profileId || `${toToolId(w?.tool, recommendation.workers[i]?.tool ?? "codex")}.default`,
          taskPrompt: toNonEmpty(w?.taskPrompt || w?.prompt || recommendation.workers[i]?.taskPrompt),
          isolated: typeof w?.isolated === "boolean" ? w.isolated : true,
          projectPath: toNonEmpty(w?.projectPath),
          branch: toNonEmpty(w?.branch),
          baseRef: toNonEmpty(w?.baseRef),
        }))
      : recommendation.workers.map((w) => ({
          name: w.name,
          role: w.role,
          tool: w.tool,
          profileId: w.profileId,
          taskPrompt: w.taskPrompt,
          isolated: true,
          projectPath: "",
          branch: "",
          baseRef: "",
        }))) as Array<{
      name: string;
      role: string;
      tool: ToolId;
      profileId: string;
      taskPrompt: string;
      isolated: boolean;
      projectPath: string;
      branch: string;
      baseRef: string;
    }>;

    if (!workerPlanSource.length) return reply.code(400).send({ ok: false, error: "missing_workers" });
    for (let i = 0; i < workerPlanSource.length; i++) {
      if (!toNonEmpty(workerPlanSource[i]!.taskPrompt)) {
        return reply.code(400).send({ ok: false, error: "missing_worker_prompt", workerIndex: i + 1, workerName: workerPlanSource[i]!.name });
      }
      if (workerPlanSource[i]!.projectPath) {
        const vv = validateCwd(workerPlanSource[i]!.projectPath, roots);
        if (!vv.ok) {
          return reply
            .code(400)
            .send({ ok: false, error: "bad_worker_projectPath", workerIndex: i + 1, workerName: workerPlanSource[i]!.name, reason: vv.reason });
        }
        workerPlanSource[i]!.projectPath = vv.cwd;
      }
    }

    const allWorkerNames = workerPlanSource.map((w) => w.name);
    const workers = workerPlanSource.map((w, idx) => {
      const recWorker = recommendation.workers[idx] ?? null;
      const inferredRole = inferWorkerRole({
        role: w.role,
        name: w.name,
        taskPrompt: w.taskPrompt,
        profileId: w.profileId,
      });
      const workerRole = toNonEmpty(w.role) || toNonEmpty(recWorker?.role) || inferredRole;
      const workerTaskPrompt = buildCreatorWorkerPrompt({
        objective,
        role: workerRole,
        workerName: w.name,
        baseTaskPrompt: w.taskPrompt,
        allWorkerNames,
        behavior,
      });
      const workerSystemPrompt =
        toNonEmpty((manualWorkers?.[idx] as any)?.systemPrompt) ||
        toNonEmpty(recWorker?.systemPrompt) ||
        buildWorkerSystemPrompt(inferredRole);

      return {
        name: w.name,
        role: workerRole,
        tool: w.tool,
        profileId: w.profileId,
        systemPrompt: workerSystemPrompt,
        taskPrompt: workerTaskPrompt,
        isolated: w.isolated,
        ...(w.projectPath ? { projectPath: w.projectPath } : {}),
        ...(w.branch ? { branch: w.branch } : {}),
        ...(w.baseRef ? { baseRef: w.baseRef } : {}),
      };
    });

    const orchestratorTool = toToolId(body?.orchestrator?.tool, recommendation.orchestrator.tool);
    const orchestratorProfileId = toNonEmpty(body?.orchestrator?.profileId) || recommendation.orchestrator.profileId;
    const orchestratorPrompt =
      toNonEmpty(body?.orchestrator?.prompt || body?.orchestratorPrompt) ||
      `Own orchestration, dispatch, and integration for objective: ${objective}`;
    const runtimeOrchestratorSystemPrompt = buildRuntimeOrchestratorSystemPrompt({
      objective,
      baseSystemPrompt: recommendation.orchestrator.systemPrompt,
      workerPlan: workers.map((w) => ({
        name: w.name,
        tool: w.tool,
        profileId: w.profileId,
      })),
      behavior,
    });

    const name = toNonEmpty(body?.name) || inferTaskNameFromObjective(objective);
    const autoDispatchInitialPrompts =
      typeof body?.autoDispatchInitialPrompts === "boolean" ? Boolean(body.autoDispatchInitialPrompts) : behavior.autoDispatchInitialPrompts;

    const orchestrationSpec = {
      name,
      projectPath,
      dispatchMode,
      autoDispatchInitialPrompts,
      orchestrator: {
        tool: orchestratorTool,
        profileId: orchestratorProfileId,
        prompt: orchestratorPrompt,
      },
      harness: {
        useDefaultPrompts: false,
        orchestratorSystemPrompt: runtimeOrchestratorSystemPrompt,
      },
      workers,
    };

    const syncPolicyRecommendation = {
      mode: behavior.sync.mode,
      intervalMs: behavior.sync.intervalMs,
      deliverToOrchestrator: behavior.sync.deliverToOrchestrator,
      minDeliveryGapMs: behavior.sync.minDeliveryGapMs,
    };

    return {
      ok: true,
      objective,
      projectPath,
      prefs,
      scan,
      behavior,
      recommendation,
      orchestrationSpec,
      postCreateActions: [
        {
          action: "set_sync_policy",
          method: "PATCH",
          routeTemplate: "/api/orchestrations/{id}/sync-policy",
          payload: syncPolicyRecommendation,
        },
      ],
      notes: [
        "Use orchestrationSpec as-is with POST /api/orchestrations.",
        "After creation, apply postCreateActions[0] with the real orchestration id.",
        "If you prefer backend to send worker prompts immediately, set dispatchMode=worker-first.",
      ],
    };
  });

  // OpenCode helpers: list available models. Useful for phone UI model picker.
  const opencodeModelsCache = new Map<string, { ts: number; items: string[] }>();
  app.get("/api/opencode/models", async (req, reply) => {
    const q = (req.query ?? {}) as any;
    const provider = typeof q?.provider === "string" ? q.provider.trim() : "";
    const refresh = q?.refresh === "1" || q?.refresh === "true" || q?.refresh === "yes";
    const key = provider || "*";

    try {
      const caps = await detector.get();
      if (!caps.opencode.installed) return reply.code(400).send({ ok: false, error: "tool_not_installed" });
    } catch {
      // ignore
    }

    const cached = !refresh ? opencodeModelsCache.get(key) : null;
    const maxAgeMs = 5 * 60 * 1000;
    if (cached && Date.now() - cached.ts < maxAgeMs) {
      return { ok: true, provider: provider || null, cached: true, items: cached.items };
    }

    const spec = tools.opencode;
    const args = [...spec.args, "models"];
    if (provider) args.push(provider);
    if (refresh) args.push("--refresh");
    // OpenCode can truncate stdout when captured via pipes. Capture via file for reliability.
    const r = await execCaptureViaFile(spec.command, args, { timeoutMs: refresh ? 20_000 : 8_000 });
    if (!r.ok) {
      const msg = (r.stderr || r.stdout || r.error || "").trim().slice(0, 420);
      return reply.code(400).send({ ok: false, error: "models_failed", message: msg || "failed to list models" });
    }

    const items = stripAnsi(r.stdout)
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      // Defensive: filter out accidental log lines.
      .filter((s) => !s.startsWith("INFO ") && !s.startsWith("WARN ") && !s.startsWith("ERROR "));

    opencodeModelsCache.set(key, { ts: Date.now(), items });
    return { ok: true, provider: provider || null, cached: false, items };
  });

  app.get("/api/config", async () => {
    const safeProfiles = Object.entries(profiles).map(([id, p]) => ({
      id,
      tool: p.tool,
      title: p.title,
      sendSuffix: p.sendSuffix,
    }));
    return {
      ok: true,
      tools: Object.keys(tools),
      profiles: safeProfiles,
      workspaceRoots: roots,
    };
  });

  app.get("/api/config/raw", async () => {
    const raw = fs.readFileSync(configPath(), "utf8");
    return { toml: redactTomlSecrets(raw) };
  });

  app.put("/api/config/raw", async (req, reply) => {
    const body = (req.body ?? {}) as any;
    const toml = typeof body.toml === "string" ? body.toml : "";
    if (!toml.trim()) return reply.code(400).send({ error: "empty" });
    const curRaw = fs.readFileSync(configPath(), "utf8");
    const mergedToml = mergeRedactedTomlSecrets(toml, curRaw);
    let next: Config;
    try {
      next = parseConfigToml(mergedToml);
    } catch (e: any) {
      return reply.code(400).send({ error: "parse_failed", message: typeof e?.message === "string" ? e.message : "" });
    }
    fs.writeFileSync(configPath(), mergedToml, "utf8");
    profiles = next.profiles ?? profiles;
    return { ok: true };
  });

  app.get("/api/fs/list", async (req, reply) => {
    const q = req.query as any;
    const p = typeof q?.path === "string" ? q.path : roots[0] ?? process.cwd();
    const showHidden = q?.showHidden === "1" || q?.showHidden === "true" || q?.showHidden === "yes";
    const r = listDir(p, roots, { showHidden });
    if (!r.ok) return reply.code(400).send({ error: "bad_path", reason: r.reason });
    return r;
  });

  app.post("/api/fs/mkdir", async (req, reply) => {
    const body = (req.body ?? {}) as any;
    const parent =
      typeof body?.path === "string" ? body.path : typeof body?.parent === "string" ? body.parent : "";
    const name = typeof body?.name === "string" ? body.name : "";
    if (!parent.trim() || !name.trim()) {
      return reply.code(400).send({ error: "missing_fields", reason: "parent path and folder name are required" });
    }
    const r = createDir(parent, name, roots);
    if (!r.ok) return reply.code(400).send({ error: "mkdir_failed", reason: r.reason });
    return r;
  });

  app.get("/api/workspaces/recent", async (req) => {
    const q = req.query as any;
    const limit = Number(q?.limit ?? 10);
    return { ok: true, items: store.listRecentWorkspaces(limit) };
  });

  app.get("/api/workspaces", async () => {
    const sess = store.listSessions();
    const counts = store.getOpenAttentionCounts();

    type Ws = {
      key: string;
      root: string;
      isGit: boolean;
      trees: any[];
      sessions: any[];
      lastUsed: number;
    };

    const byKey = new Map<string, Ws>();
    for (const s of sess) {
      const cwd = typeof s.cwd === "string" ? s.cwd.trim() : "";
      // If cwd is missing (legacy sessions), group them together so the UI doesn't show a pile
      // of blank "dir" rows with one session each.
      const key = s.workspaceKey ? String(s.workspaceKey) : cwd ? `dir:${cwd}` : "dir:(unknown)";
      const root = s.workspaceRoot || s.treePath || cwd || "(unknown)";
      const ws: Ws =
        byKey.get(key) ??
        ({
          key,
          root,
          isGit: Boolean(s.workspaceKey),
          trees: [],
          sessions: [],
          lastUsed: 0,
        } as Ws);

      ws.lastUsed = Math.max(ws.lastUsed, Number(s.updatedAt ?? 0));
      ws.sessions.push({
        id: s.id,
        tool: s.tool,
        profileId: s.profileId,
        transport: s.transport ?? "pty",
        toolSessionId: s.toolSessionId ?? null,
        cwd: s.cwd,
        treePath: s.treePath,
        workspaceKey: s.workspaceKey,
        workspaceRoot: s.workspaceRoot,
        label: s.label,
        pinnedSlot: s.pinnedSlot,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        running: isStoreSessionRunning(s),
        closing: closingSessions.has(String(s.id)),
        attention: counts[s.id] ?? 0,
        preview: lastPreview.get(s.id)?.line ?? null,
      });
      byKey.set(key, ws);
    }

    const items = Array.from(byKey.values()).sort((a, b) => b.lastUsed - a.lastUsed);

    // Attach tree lists for git workspaces (cached).
    for (const w of items) {
      if (!w.isGit) continue;
      const any = w.sessions.find((x) => typeof x.treePath === "string" && x.treePath) ?? w.sessions[0];
      const anyRoot = String(any?.treePath || any?.cwd || w.root || "");
      if (!anyRoot) continue;
      const cached = worktreeCache.get(w.key);
      if (cached && Date.now() - cached.ts < 6000) {
        w.trees = cached.items;
        continue;
      }
      const r = await listGitWorktrees(anyRoot);
      if (r.ok) {
        w.trees = r.items;
        worktreeCache.set(w.key, { ts: Date.now(), items: r.items as any[], root: anyRoot });
      } else {
        w.trees = [];
      }
    }

    return { ok: true, items };
  });

  app.get("/api/workspaces/preset", async (req, reply) => {
    const q = req.query as any;
    const p = typeof q?.path === "string" ? q.path : "";
    const tool = q?.tool as ToolId;
    if (!p) return reply.code(400).send({ error: "bad_path" });
    if (tool !== "codex" && tool !== "claude" && tool !== "opencode") return reply.code(400).send({ error: "bad_tool" });
    const vv = validateCwd(p, roots);
    if (!vv.ok) return reply.code(400).send({ error: "bad_path", reason: vv.reason });
    // Prefer exact directory presets, but fall back to git-workspace presets so
    // worktrees share defaults (Codex-like "workspace" behavior).
    let rec = store.getWorkspacePreset(vv.cwd, tool);
    if (!rec) {
      try {
        const gr = await resolveGitForPath(vv.cwd);
        if (gr.ok) {
          rec =
            store.getWorkspacePreset(gr.workspaceKey, tool) ??
            store.getWorkspacePreset(gr.workspaceRoot, tool) ??
            null;
        }
      } catch {
        // ignore
      }
    }
    return { ok: true, preset: rec };
  });

  app.put("/api/workspaces/preset", async (req, reply) => {
    const body = (req.body ?? {}) as any;
    const p = typeof body?.path === "string" ? body.path : "";
    const tool = body?.tool as ToolId;
    const profileId = typeof body?.profileId === "string" ? body.profileId : "";
    const overrides = body?.overrides ?? {};
    if (!p || !profileId) return reply.code(400).send({ error: "bad_request" });
    if (tool !== "codex" && tool !== "claude" && tool !== "opencode") return reply.code(400).send({ error: "bad_tool" });
    const vv = validateCwd(p, roots);
    if (!vv.ok) return reply.code(400).send({ error: "bad_path", reason: vv.reason });
    store.upsertWorkspacePreset({ path: vv.cwd, tool, profileId, overrides });
    try {
      const gr = await resolveGitForPath(vv.cwd);
      if (gr.ok) {
        store.upsertWorkspacePreset({ path: gr.workspaceKey, tool, profileId, overrides });
      }
    } catch {
      // ignore
    }
    broadcastGlobal({ type: "workspaces.changed" });
    return { ok: true };
  });

  function toToolId(v: unknown, fallback: ToolId): ToolId {
    const t = typeof v === "string" ? v.trim() : "";
    if (t === "codex" || t === "claude" || t === "opencode") return t;
    return fallback;
  }

  function toNonEmpty(v: unknown): string {
    return typeof v === "string" ? v.trim() : "";
  }

  type ClaudeAuthMode = "subscription" | "api";
  function toClaudeAuthMode(v: unknown): ClaudeAuthMode | null {
    const s = toNonEmpty(v).toLowerCase();
    if (s === "subscription" || s === "api") return s as ClaudeAuthMode;
    return null;
  }

  function resolveClaudeAuthMode(claudeCfg: any): ClaudeAuthMode {
    const explicit = toClaudeAuthMode(claudeCfg?.authMode);
    if (explicit) return explicit;
    const envMode = toClaudeAuthMode(process.env.FYP_CLAUDE_AUTH_MODE);
    return envMode ?? "subscription";
  }

  function branchSlug(v: string): string {
    const s = String(v || "")
      .toLowerCase()
      .replace(/[^a-z0-9._/-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[-/]+|[-/]+$/g, "");
    return s || "worker";
  }

  function normalizePromptInput(v: string): string {
    const raw = String(v ?? "");
    if (!raw) return raw;
    if (raw.endsWith("\r")) return raw;
    // Some CLIs treat trailing LF as text/newline-in-composer, not "submit".
    // Always normalize to a final CR so startup/dispatch prompts are actually sent.
    const withoutTrailingLf = raw.replace(/\n+$/g, "");
    return withoutTrailingLf + "\r";
  }

  function compactRuntimeTextBlock(
    text: string,
    opts?: { maxLines?: number; maxChars?: number },
  ): { text: string; truncated: boolean } {
    const raw = String(text ?? "").trim();
    if (!raw) return { text: "", truncated: false };
    const maxLines = Math.min(600, Math.max(16, Math.floor(Number(opts?.maxLines ?? 180) || 180)));
    const maxChars = Math.min(120_000, Math.max(1200, Math.floor(Number(opts?.maxChars ?? 22_000) || 22_000)));
    const lines = raw.split(/\r?\n/);
    let out = lines.slice(0, maxLines).join("\n");
    let truncated = lines.length > maxLines;
    if (out.length > maxChars) {
      out = out.slice(0, maxChars);
      truncated = true;
    }
    return { text: out.trim(), truncated };
  }

  function clearBootstrapRetry(sessionId: string): void {
    const tm = bootstrapRetryTimers.get(sessionId);
    if (!tm) return;
    try {
      clearTimeout(tm);
    } catch {
      // ignore
    }
    bootstrapRetryTimers.delete(sessionId);
  }

  function scheduleBootstrapFallbackRetry(sessionId: string): void {
    clearBootstrapRetry(sessionId);
    const tm = setTimeout(async () => {
      bootstrapRetryTimers.delete(sessionId);
      const fallback = firstUserBootstrapFallback.get(sessionId);
      if (!fallback) return;
      const retries = Math.max(0, Math.floor(Number(fallback.autoRetries ?? 0)));
      if (retries >= 2) return;

      let sess: any = null;
      try {
        sess = store.getSession(sessionId);
      } catch {
        return;
      }
      if (!sess || !isStoreSessionRunning(sess)) return;
      const latestPreviewTs = Number(lastPreview.get(sessionId)?.ts ?? 0);
      if (latestPreviewTs > Number(fallback.queuedAt ?? 0) + 50) return;

      const kickoffLabel = toNonEmpty(fallback.kickoffLabel) || "AUTOMATIC STARTUP KICKOFF";
      const retryText = normalizePromptInput(
        [
          fallback.text,
          "",
          kickoffLabel,
          "(auto-retry to ensure bootstrap is submitted)",
        ].join("\n"),
      );
      try {
        await sendInputDirect(sessionId, retryText);
        firstUserBootstrapFallback.set(sessionId, {
          ...fallback,
          queuedAt: Date.now(),
          forceOnFirstInput: false,
          autoRetries: retries + 1,
        });
      } catch {
        return;
      }
      scheduleBootstrapFallbackRetry(sessionId);
    }, 2600);
    tm.unref?.();
    bootstrapRetryTimers.set(sessionId, tm);
  }

  function applyBootstrapFallbackForInput(
    sessionId: string,
    rawText: string,
    opts?: { kickoffLabel?: string },
  ): { text: string; injectedBootstrap: boolean } {
    let text = String(rawText ?? "");
    let injectedBootstrap = false;
    const fallback = firstUserBootstrapFallback.get(sessionId);
    if (!fallback) return { text, injectedBootstrap };

    const latestPreviewTs = Number(lastPreview.get(sessionId)?.ts ?? 0);
    const force = fallback.forceOnFirstInput === true;
    const bootstrapLikelyApplied = !force && latestPreviewTs > Number(fallback.queuedAt ?? 0) + 50;
    if (!bootstrapLikelyApplied) {
      const kickoff = String(rawText ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
      const kickoffLabel = toNonEmpty(opts?.kickoffLabel || fallback.kickoffLabel) || "USER KICKOFF MESSAGE";
      text = normalizePromptInput(
        [
          fallback.text,
          "",
          kickoffLabel,
          kickoff || "(no additional message)",
        ].join("\n"),
      );
      injectedBootstrap = true;
    }
    clearBootstrapRetry(sessionId);
    firstUserBootstrapFallback.delete(sessionId);
    return { text, injectedBootstrap };
  }

  function isCodexInteractivePreviewLine(line: string): boolean {
    const t = String(line ?? "").toLowerCase();
    if (!t) return false;
    return (
      t.includes("tab to queue message") ||
      t.includes("context left") ||
      t.includes("/model to change") ||
      t.includes("tip:") ||
      t.includes("esc to interrupt")
    );
  }

  async function waitForSessionReady(sessionId: string, timeoutMs = 15_000): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const st = sessions.getStatus(sessionId);
      if (st?.running) return;
      await new Promise((resolve) => setTimeout(resolve, 45));
    }
    throw new Error(`session_start_timeout:${sessionId}`);
  }

  async function waitForSessionWarmup(
    sessionId: string,
    opts?: {
      settleMs?: number;
      previewProbeMs?: number;
      requireInteractive?: boolean;
    },
  ): Promise<void> {
    const settleMs = Math.max(0, Number(opts?.settleMs ?? 280));
    const previewProbeMs = Math.max(0, Number(opts?.previewProbeMs ?? 1400));
    const requireInteractive = opts?.requireInteractive !== false;
    const sess = store.getSession(sessionId);
    const isCodex = String(sess?.tool ?? "") === "codex";
    const requireCodexInteractive = requireInteractive && isCodex;
    let sawPreview = false;
    let firstPreviewAt = 0;
    if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
    const start = Date.now();
    while (Date.now() - start < previewProbeMs) {
      const st = sessions.getStatus(sessionId);
      if (!st?.running) throw new Error(`session_not_running:${sessionId}`);
      const p = lastPreview.get(sessionId);
      if (p?.ts) {
        sawPreview = true;
        if (!requireCodexInteractive) return;
        if (isCodexInteractivePreviewLine(p.line)) return;
        if (!firstPreviewAt) firstPreviewAt = Date.now();
        // Some CLIs (and test stubs) never emit Codex interactive UI markers.
        // After a short grace period with any preview activity, proceed and rely
        // on bootstrap retry fallback if the initial message lands too early.
        if (Date.now() - firstPreviewAt >= Math.min(previewProbeMs, 1200)) return;
      }
      await new Promise((resolve) => setTimeout(resolve, 45));
    }
    if (sawPreview) return;
  }

  function buildWorkerStartupPrompt(input: {
    orchestrationId: string;
    orchestrationName: string;
    objective: string;
    orchestratorSessionId: string;
    workerName: string;
    workerRole: WorkerRoleKey;
    workerProfileId: string;
    workerIndex: number;
    workerCount: number;
    dispatchMode: "orchestrator-first" | "worker-first";
    workerSystemPrompt: string;
    taskPrompt: string;
    taskStartsNow: boolean;
  }): string {
    const compactWorkerSystemPrompt = compactRuntimeTextBlock(input.workerSystemPrompt, {
      maxLines: 140,
      maxChars: 14_000,
    });
    const modeLine = input.taskStartsNow
      ? "START MODE: begin execution now using the assigned task below."
      : "WAIT MODE: acknowledge bootstrap, then wait for orchestrator dispatch before editing files.";
    const assignedTask = input.taskStartsNow
      ? input.taskPrompt
      : [
          input.taskPrompt,
          "",
          "Execution gate: Wait for an explicit orchestrator release message before touching files.",
        ].join("\n");
    return [
      "SYSTEM PROMPT (apply strictly):",
      "ROLE: ORCHESTRATED WORKER CLI",
      "You are part of a private multi-CLI orchestration harness.",
      "",
      "PRIVATE CONTEXT",
      "- This channel is internal orchestration context. Treat it as private to the user.",
      "- Do not assume direct communication with other workers.",
      "- The orchestrator is your control plane for cross-worker coordination.",
      "- You are an implementation worker. You do not orchestrate other workers.",
      "",
      "ORCHESTRATION",
      `- id: ${input.orchestrationId}`,
      `- name: ${input.orchestrationName}`,
      `- objective: ${input.objective}`,
      `- orchestrator session: ${input.orchestratorSessionId}`,
      `- worker slot: ${input.workerIndex + 1}/${input.workerCount} (${input.workerName})`,
      `- worker role: ${input.workerRole}`,
      `- worker profile: ${input.workerProfileId}`,
      `- dispatch mode: ${input.dispatchMode}`,
      "",
      "WORKER SYSTEM PROMPT (MANDATORY)",
      compactWorkerSystemPrompt.text,
      compactWorkerSystemPrompt.truncated
        ? "(system prompt truncated for runtime safety; full reference lives in .agents/system/runtime-worker-contracts.md)"
        : "",
      "",
      "COMMUNICATION RULES",
      "- Execute only scoped instructions from your assigned prompt and orchestrator follow-ups.",
      "- If blocked, ask one structured question packet with context + file list + options.",
      "- Prefer CLI request-input/question tools for blocking decisions whenever available.",
      "- If awaiting orchestrator decision, remain in standby and do not self-resolve the decision.",
      "- When sending a blocker question, include this exact packet format:",
      "  QUESTION:",
      "  CONTEXT:",
      "  FILES:",
      "  OPTIONS:",
      "  RECOMMENDED:",
      "  BLOCKING:",
      "- Do not send conversational status chatter; send concise blocker-first updates only.",
      "- Do not fabricate status. Report concrete evidence only.",
      "",
      "PROGRESS FILE CONTRACT",
      "- Create and maintain `.fyp/task.md` in your cwd.",
      "- Keep sections: Objective, Scope, Checklist, Blockers, Files touched, Verification.",
      "- Use markdown checkboxes (`- [ ]`, `- [x]`) for checklist items.",
      "- Update this file after each meaningful milestone so external status UI can read progress.",
      "",
      "AGENT DOCS CONTRACT",
      "- Read `.agents/README.md` if it exists.",
      "- Read `.agents/system/orchestrator.md` to understand question + no-op review policy.",
      "- Read `.agents/system/command-bus.md` for dispatch and approval flows.",
      "- Keep your worker plan in `.agents/tasks/worker-${input.workerIndex + 1}-${branchSlug(input.workerName)}.md`.",
      "- Do not edit peer worker task files unless explicitly instructed by orchestrator.",
      "- When blocked, record blocker + options in your worker task file before asking orchestrator.",
      "",
      "ASSIGNED TASK",
      assignedTask,
      "",
      modeLine,
      "Reply once with: BOOTSTRAP-ACK",
    ].join("\n");
  }

  function buildOrchestratorStartupPrompt(input: {
    runtimeSystemPrompt: string;
    orchestrationId: string;
    orchestrationName: string;
    objective: string;
    projectPath: string;
    orchestratorTool: ToolId;
    orchestratorProfileId: string;
    dispatchMode: "orchestrator-first" | "worker-first";
    workerSummary: string;
    dispatchExamples: string;
  }): string {
    const compactRuntimeSystemPrompt = compactRuntimeTextBlock(input.runtimeSystemPrompt, {
      maxLines: 220,
      maxChars: 22_000,
    });
    const startupDirective =
      input.dispatchMode === "orchestrator-first"
        ? [
      "STARTUP SEQUENCE (STRICT)",
      "1. Acknowledge bootstrap and publish a short execution plan.",
      "2. Verify each worker acknowledged BOOTSTRAP-ACK.",
      "3. Dispatch first TASK/SCOPE/NOT-YOUR-JOB/DONE-WHEN/VERIFY prompts within first 2 exchanges.",
      "   Preferred: emit `FYP_DISPATCH_JSON: {\"target\":\"...\",\"text\":\"...\"}` lines so server routes directly to workers.",
      "4. Explicitly teach workers to escalate only through structured questions when blocked.",
      "5. Enforce `.agents/tasks/worker-*.md` + `.fyp/task.md` updates for progress visibility.",
          ].join("\n")
        : [
            "STARTUP SEQUENCE (STRICT)",
            "1. Acknowledge bootstrap and verify workers started correctly.",
            "2. Confirm each worker is following assigned scope and quality bar.",
            "3. Begin monitoring and course correction immediately.",
            "4. Enforce `.agents/tasks/worker-*.md` + `.fyp/task.md` updates for progress visibility.",
          ].join("\n");
    return [
      compactRuntimeSystemPrompt.text
        ? `SYSTEM PROMPT (apply strictly):\n${compactRuntimeSystemPrompt.text}`
        : "",
      compactRuntimeSystemPrompt.truncated
        ? "SYSTEM PROMPT NOTE: Runtime prompt was truncated for safety. Full reference is persisted in .agents/system/runtime-bootstrap-orchestrator.md."
        : "",
      `You are the orchestrator for ${input.orchestrationId} (${input.orchestrationName}).`,
      "This is private internal orchestration context.",
      "You are the only orchestration authority in this run.",
      "Workers implement scoped tasks; you assign, coordinate, review, and decide.",
      "Never delegate orchestration authority to a worker.",
      "",
      "ORCHESTRATOR DIRECTIVE",
      input.objective,
      "",
      "ENVIRONMENT SNAPSHOT",
      `- project path: ${input.projectPath}`,
      `- orchestrator tool/profile: ${input.orchestratorTool} / ${input.orchestratorProfileId}`,
      `- runtime date: ${new Date().toISOString()}`,
      "",
      "DOCUMENT STRATEGY (MANDATORY)",
      "- Create `.agents/README.md` as orchestration index (objective, worker ownership, rules).",
      "- Create `.agents/system/orchestrator.md` with your orchestration policy and checkpoints.",
      "- Read `.agents/system/command-bus.md` for dispatch and question handling commands.",
      "- Treat `.agents/system/runtime-bootstrap-orchestrator.md` as immutable startup contract.",
      "- Create one worker task file per worker under `.agents/tasks/` and keep them updated.",
      "- Use these docs as the canonical shared plan state; keep concise and current.",
      "- If a worker appears finished, run review and decide either targeted follow-up or NO-DISPATCH.",
      "",
      `Dispatch mode: ${input.dispatchMode}`,
      startupDirective,
      "",
      "WORKER REGISTRY",
      input.workerSummary,
      "",
      "CONTROL BUS",
      input.dispatchExamples,
      "",
      "DIRECT DISPATCH EMISSION (RELIABLE)",
      "- Equivalent to typing into worker CLI and pressing Enter.",
      "- Emit this exact one-line JSON payload from your response:",
      '  FYP_DISPATCH_JSON: {"target":"all","text":"<prompt>"}',
      '  FYP_DISPATCH_JSON: {"target":"worker:<name>","text":"<prompt>"}',
      '  FYP_SEND_TASK_JSON: {"target":"worker:<name>","task":"<task>","initialize":true}',
      "- Use compact single-line JSON. Do not wrap in markdown fences.",
      "",
      "CONTROL TOOLS (MUST USE)",
      "1) SEND TASK (preferred):",
      '   FYP_SEND_TASK_JSON: {"target":"worker:<name|all|session:...|1>","task":"TASK/SCOPE/NOT-YOUR-JOB/DONE-WHEN/VERIFY ...","initialize":true|false,"interrupt":true|false,"forceInterrupt":true|false}',
      "   - `initialize:true` = include bootstrap context on first task release.",
      "   - `interrupt:true` = force-replace current worker turn when needed.",
      "   - `forceInterrupt:true` = interrupt even when worker appears active.",
      "2) ANSWER WORKER QUESTION:",
      '   FYP_ANSWER_QUESTION_JSON: {"attentionId":123,"optionId":"1","source":"orchestrator-auto","meta":{"reason":"why"}}',
      "   - Use only when worker asked a structured question and option is clear/safe.",
      "   - If uncertain, keep item open and summarize why.",
      "",
      "WORKER COMMUNICATION CONTRACT (ENFORCE)",
      "- Workers communicate blockers/decisions via structured question packets only.",
      "- Workers should update `.agents/tasks/worker-*.md` and `.fyp/task.md` continuously.",
      "- If worker finishes and no follow-up is needed: NO-DISPATCH and keep worker on standby.",
      "",
      "FIRST-TRY QUICKSTART (DO THIS)",
      "1. After BOOTSTRAP-ACKs, send one plain release line:",
      '   FYP_DISPATCH_JSON: {"target":"all","text":"<prompt>"}',
      "2. Wait for worker ACK/progress updates.",
      "3. Then send scoped follow-ups only when needed (not constant debug pings).",
      "",
      "Progress feed endpoint:",
      'curl -sS "$FYP_API_BASE_URL/api/orchestrations/$FYP_ORCHESTRATION_ID/progress" -H "Authorization: Bearer $FYP_API_TOKEN"',
    ]
      .filter(Boolean)
      .join("\n");
  }

  function toHarnessPrefs(v: any): HarnessCreatorPrefs {
    const budgetRaw = String(v?.budget ?? "balanced").trim();
    const priorityRaw = String(v?.priority ?? "balanced").trim();
    const budget = budgetRaw === "low" || budgetRaw === "high" ? (budgetRaw as any) : "balanced";
    const priority = priorityRaw === "speed" || priorityRaw === "quality" ? (priorityRaw as any) : "balanced";
    const maxWorkers = Math.min(6, Math.max(1, Math.floor(Number(v?.maxWorkers ?? 4) || 4)));
    const allowWorkspaceScan = v?.allowWorkspaceScan !== false;
    return { budget, priority, maxWorkers, allowWorkspaceScan };
  }

  type CreatorBuildCoordinationStyle = "strict" | "balanced" | "exploratory";
  type CreatorBuildApprovalPolicy = "manual" | "guarded-auto";
  type CreatorBuildInterruptPolicy = "manual" | "on-blocker" | "never";
  type CreatorBuildSyncMode = "off" | "manual" | "interval";
  type CreatorBuildBehavior = {
    coordinationStyle: CreatorBuildCoordinationStyle;
    approvalPolicy: CreatorBuildApprovalPolicy;
    interruptPolicy: CreatorBuildInterruptPolicy;
    enforceFileOwnership: boolean;
    allowWorkerSubagents: boolean;
    maxWorkerSubagents: number;
    autoDispatchInitialPrompts: boolean;
    sync: {
      mode: CreatorBuildSyncMode;
      intervalMs: number;
      deliverToOrchestrator: boolean;
      minDeliveryGapMs: number;
    };
  };

  function normalizeCreatorBuildBehavior(v: any): CreatorBuildBehavior {
    const styleRaw = toNonEmpty(v?.coordinationStyle).toLowerCase();
    const approvalRaw = toNonEmpty(v?.approvalPolicy).toLowerCase();
    const interruptRaw = toNonEmpty(v?.interruptPolicy).toLowerCase();
    const syncModeRaw = toNonEmpty(v?.sync?.mode || v?.syncMode).toLowerCase();

    const coordinationStyle: CreatorBuildCoordinationStyle =
      styleRaw === "strict" || styleRaw === "exploratory" ? (styleRaw as CreatorBuildCoordinationStyle) : "balanced";
    const approvalPolicy: CreatorBuildApprovalPolicy = approvalRaw === "manual" ? "manual" : "guarded-auto";
    const interruptPolicy: CreatorBuildInterruptPolicy =
      interruptRaw === "never" || interruptRaw === "on-blocker" ? (interruptRaw as CreatorBuildInterruptPolicy) : "manual";
    const syncMode: CreatorBuildSyncMode =
      syncModeRaw === "off" || syncModeRaw === "interval" ? (syncModeRaw as CreatorBuildSyncMode) : "manual";

    return {
      coordinationStyle,
      approvalPolicy,
      interruptPolicy,
      enforceFileOwnership: v?.enforceFileOwnership !== false,
      allowWorkerSubagents: v?.allowWorkerSubagents !== false,
      maxWorkerSubagents: Math.min(4, Math.max(0, Math.floor(Number(v?.maxWorkerSubagents ?? 1) || 1))),
      // Default on to prevent "all workers idle waiting for manual release" dead-starts.
      autoDispatchInitialPrompts:
        typeof v?.autoDispatchInitialPrompts === "boolean" ? Boolean(v.autoDispatchInitialPrompts) : true,
      sync: {
        mode: syncMode,
        intervalMs: Math.min(30 * 60 * 1000, Math.max(15_000, Math.floor(Number(v?.sync?.intervalMs ?? 120_000) || 120_000))),
        deliverToOrchestrator: v?.sync?.deliverToOrchestrator !== false,
        minDeliveryGapMs: Math.min(10 * 60 * 1000, Math.max(10_000, Math.floor(Number(v?.sync?.minDeliveryGapMs ?? 45_000) || 45_000))),
      },
    };
  }

  function inferTaskNameFromObjective(objective: string): string {
    const base = objective
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!base) return "orchestration-task";
    return base.slice(0, 56);
  }

  function buildRuntimeOrchestratorSystemPrompt(input: {
    objective: string;
    baseSystemPrompt: string;
    workerPlan: Array<{ name: string; tool: ToolId; profileId: string }>;
    behavior: CreatorBuildBehavior;
  }): string {
    const workerSnapshot = input.workerPlan
      .map((w, i) => `${i + 1}. ${w.name} (${w.tool}/${w.profileId})`)
      .join("\n");
    const approvalRule =
      input.behavior.approvalPolicy === "manual"
        ? "Never auto-approve actions. Request explicit approval for all permission-gated operations."
        : "Use guarded auto-approval only for low-risk, reversible actions aligned to objective and file ownership.";
    const interruptRule =
      input.behavior.interruptPolicy === "never"
        ? "Do not interrupt active workers except when user explicitly commands it."
        : input.behavior.interruptPolicy === "on-blocker"
          ? "Interrupt a worker only for blockers, safety issues, or hard contract violations."
          : "Default to no interrupt; allow interrupts only when user explicitly requests or when a safety issue appears.";

    return [
      input.baseSystemPrompt,
      "",
      "RUNTIME BEHAVIOR CONTROLS",
      `- Coordination style: ${input.behavior.coordinationStyle}`,
      `- Approval policy: ${input.behavior.approvalPolicy}`,
      `- Interrupt policy: ${input.behavior.interruptPolicy}`,
      `- Enforce file ownership: ${input.behavior.enforceFileOwnership ? "yes" : "no"}`,
      `- Worker subagents allowed: ${input.behavior.allowWorkerSubagents ? "yes" : "no"} (max ${input.behavior.maxWorkerSubagents})`,
      `- Auto-dispatch initial prompts: ${input.behavior.autoDispatchInitialPrompts ? "yes" : "no"}`,
      "",
      "MANDATORY OPERATING RULES",
      approvalRule,
      interruptRule,
      input.behavior.enforceFileOwnership
        ? "Reject overlapping file ownership across workers. Replan before dispatch if scopes collide."
        : "Prefer non-overlapping ownership, but allow overlap only with explicit integration checkpoint.",
      "Require worker reports to include: files changed, tests run, residual risk, and next action.",
      "Escalate to user when tradeoffs affect architecture, data integrity, or production safety.",
      "",
      "SYNC POLICY TARGET",
      `- Mode: ${input.behavior.sync.mode}`,
      `- Interval ms: ${input.behavior.sync.intervalMs}`,
      `- Deliver to orchestrator: ${input.behavior.sync.deliverToOrchestrator ? "yes" : "no"}`,
      `- Min delivery gap ms: ${input.behavior.sync.minDeliveryGapMs}`,
      "",
      "OBJECTIVE",
      input.objective,
      "",
      "WORKER SNAPSHOT",
      workerSnapshot || "(none)",
    ].join("\n");
  }

  function buildCreatorWorkerPrompt(input: {
    objective: string;
    role: string;
    workerName: string;
    baseTaskPrompt: string;
    allWorkerNames: string[];
    behavior: CreatorBuildBehavior;
  }): string {
    const peers = input.allWorkerNames.filter((n) => n !== input.workerName);
    return [
      `ROLE: ${input.role}`,
      `WORKER: ${input.workerName}`,
      "",
      "PRIMARY OBJECTIVE",
      input.objective,
      "",
      "ASSIGNED TASK",
      input.baseTaskPrompt,
      "",
      "EXECUTION CONSTRAINTS",
      input.behavior.enforceFileOwnership
        ? "FILE OWNERSHIP: You own only your assigned scope. Do not edit peer-owned files without explicit orchestrator reassignment."
        : "FILE OWNERSHIP: Prefer your assigned scope and minimize cross-worker edits.",
      input.behavior.allowWorkerSubagents
        ? `SUBAGENTS: Allowed, up to ${input.behavior.maxWorkerSubagents} concurrent subagents.`
        : "SUBAGENTS: Disabled. Complete work directly in this worker.",
      "QUALITY BAR: Provide concrete verification evidence (tests, commands, or deterministic checks).",
      "ANTI-SLOP: Avoid duplicate implementations and broad rewrites outside assigned scope.",
      peers.length ? `PEER WORKERS: ${peers.join(", ")}` : "PEER WORKERS: none",
      "",
      "DELIVERY CONTRACT",
      "Return: changed files, concise rationale, verification output, and any blocker requiring orchestrator action.",
    ].join("\n");
  }

  function summarizeWorkspaceForHarness(root: string): WorkspaceScanSummary {
    const maxFiles = 7000;
    const stack: string[] = [root];
    let fileCount = 0;
    let tsFileCount = 0;
    let jsFileCount = 0;
    let pyFileCount = 0;
    let goFileCount = 0;
    let rsFileCount = 0;
    let testFileCount = 0;

    while (stack.length > 0 && fileCount < maxFiles) {
      const cur = stack.pop()!;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(cur, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const name = String(e.name ?? "");
        if (!name) continue;
        if (e.isDirectory()) {
          if (
            name === ".git" ||
            name === "node_modules" ||
            name === "dist" ||
            name === "build" ||
            name === ".next" ||
            name === ".turbo" ||
            name === ".venv" ||
            name === "__pycache__"
          ) {
            continue;
          }
          stack.push(path.join(cur, name));
          continue;
        }
        if (!e.isFile()) continue;
        fileCount += 1;
        const lower = name.toLowerCase();
        if (lower.endsWith(".ts") || lower.endsWith(".tsx")) tsFileCount += 1;
        if (lower.endsWith(".js") || lower.endsWith(".jsx")) jsFileCount += 1;
        if (lower.endsWith(".py")) pyFileCount += 1;
        if (lower.endsWith(".go")) goFileCount += 1;
        if (lower.endsWith(".rs")) rsFileCount += 1;
        if (/(^test_|_test\.|\.test\.|\.spec\.)/i.test(lower)) testFileCount += 1;
      }
    }

    const frontendLikely = tsFileCount + jsFileCount > 0;
    const backendLikely = pyFileCount + goFileCount + rsFileCount + tsFileCount + jsFileCount > 0;
    return {
      root,
      fileCount,
      tsFileCount,
      jsFileCount,
      pyFileCount,
      goFileCount,
      rsFileCount,
      testFileCount,
      frontendLikely,
      backendLikely,
    };
  }

  function normalizeTaskMode(raw: unknown): "wrap" | "terminal" {
    const mode = typeof raw === "string" ? raw.trim() : "";
    if (terminalModeEnabled && mode === "terminal") return "terminal";
    return "wrap";
  }

  function defaultTaskTitleForSession(s: any): string {
    const label = typeof s?.label === "string" ? s.label.trim() : "";
    if (label) return label;
    const profile = typeof s?.profileId === "string" ? s.profileId.trim() : "";
    if (profile) return profile;
    const tool = typeof s?.tool === "string" ? s.tool.trim() : "";
    return tool ? `${tool} task` : "Task";
  }

  function ensureTaskForSession(input: {
    sessionId: string;
    role?: "solo" | "parent" | "child" | "helper";
    ordinal?: number;
    taskId?: string;
    title?: string | null;
    isInternal?: boolean;
    defaultHidden?: boolean;
  }): string {
    const sessionId = String(input.sessionId || "").trim();
    if (!sessionId) throw new Error("bad_session_id");
    const existingMember = store.getTaskMemberBySession(sessionId);
    if (existingMember?.taskId) {
      store.upsertTaskMember({
        taskId: existingMember.taskId,
        sessionId,
        role: input.role ?? existingMember.role ?? "solo",
        ordinal: typeof input.ordinal === "number" ? input.ordinal : existingMember.ordinal ?? 0,
        title: input.title ?? existingMember.title ?? null,
        isInternal: input.isInternal ?? existingMember.isInternal ?? false,
        defaultHidden: input.defaultHidden ?? existingMember.defaultHidden ?? false,
      });
      return existingMember.taskId;
    }

    const sid = String(input.taskId || "").trim() || `sess:${sessionId}`;
    const sess = store.getSession(sessionId);
    if (!store.getTask(sid)) {
      store.upsertTask({
        id: sid,
        title: input.title ?? defaultTaskTitleForSession(sess),
        kind: "single",
        status: "active",
        source: "manual",
        defaultMode: "wrap",
        visibility: input.isInternal ? "internal" : "user",
      });
    }
    store.upsertTaskMember({
      taskId: sid,
      sessionId,
      role: input.role ?? "solo",
      ordinal: Number.isFinite(Number(input.ordinal)) ? Math.floor(Number(input.ordinal)) : 0,
      title: input.title ?? null,
      isInternal: input.isInternal === true,
      defaultHidden: input.defaultHidden === true,
    });
    return sid;
  }

  function ensureTaskForOrchestration(input: {
    orchestrationId: string;
    name: string;
    orchestratorSessionId: string;
    workers: Array<{ sessionId: string; name: string; workerIndex?: number }>;
  }): string {
    const taskId = `orch:${String(input.orchestrationId || "").trim()}`;
    store.upsertTask({
      id: taskId,
      title: toNonEmpty(input.name) || `Orchestration ${input.orchestrationId}`,
      kind: "orchestrator",
      status: "active",
      source: "manual",
      defaultMode: "wrap",
      visibility: "user",
    });
    store.clearTaskMembers(taskId);
    store.upsertTaskMember({
      taskId,
      sessionId: input.orchestratorSessionId,
      role: "parent",
      ordinal: 0,
      title: "Orchestrator",
      isInternal: false,
      defaultHidden: false,
    });
    for (const w of input.workers) {
      store.upsertTaskMember({
        taskId,
        sessionId: String(w.sessionId),
        role: "child",
        ordinal: Number.isFinite(Number(w.workerIndex)) ? Number(w.workerIndex) + 1 : 1,
        title: toNonEmpty(w.name) || "Worker",
        isInternal: false,
        defaultHidden: false,
      });
    }
    return taskId;
  }

  function hydrateLegacyTasks(): void {
    try {
      for (const orch of store.listOrchestrations(1000)) {
        const rec = store.getOrchestration(String(orch.id));
        if (!rec) continue;
        ensureTaskForOrchestration({
          orchestrationId: rec.orchestration.id,
          name: rec.orchestration.name,
          orchestratorSessionId: rec.orchestration.orchestratorSessionId,
          workers: rec.workers.map((w) => ({ sessionId: String(w.sessionId), name: String(w.name), workerIndex: Number(w.workerIndex ?? 0) })),
        });
      }
      for (const s of store.listSessions()) {
        ensureTaskForSession({ sessionId: String(s.id), role: "solo", ordinal: 0, title: s.label ?? null });
      }
      store.pruneOrphanTasks();
    } catch {
      // ignore best-effort migration
    }
  }

  hydrateLegacyTasks();
  const ORPHAN_TASK_PRUNE_MIN_GAP_MS = 60_000;
  let lastOrphanTaskPruneAt = Date.now();
  function maybePruneOrphanTasks(opts?: { force?: boolean }) {
    const force = opts?.force === true;
    const now = Date.now();
    if (!force && now - lastOrphanTaskPruneAt < ORPHAN_TASK_PRUNE_MIN_GAP_MS) return false;
    try {
      store.pruneOrphanTasks();
      lastOrphanTaskPruneAt = now;
      return true;
    } catch {
      return false;
    }
  }

  async function createSessionDirect(input: {
    tool: ToolId;
    profileId: string;
    cwd: string;
    overrides?: any;
    extraEnv?: Record<string, string>;
  }): Promise<string> {
    const tool = input.tool;
    const profileId = input.profileId || `${tool}.default`;
    const profile = profiles[profileId];
    const caps = await detector.get();
    const toolCaps = tool === "codex" ? caps.codex : tool === "claude" ? caps.claude : caps.opencode;
    if (!(toolCaps as any).installed) throw new Error("tool_not_installed");

    const effectiveProfile =
      profile && profile.tool === tool
        ? (structuredClone(profile) as any)
        : ({
            tool,
            title: `${tool} (custom)`,
            startup: [],
            sendSuffix: "\r",
          } as any);

    const overrides = input.overrides ?? {};
    if (tool === "codex" && typeof overrides?.codex === "object") {
      effectiveProfile.codex = { ...(effectiveProfile.codex ?? {}), ...(overrides.codex ?? {}) };
    }
    if (tool === "claude" && typeof overrides?.claude === "object") {
      effectiveProfile.claude = { ...(effectiveProfile.claude ?? {}), ...(overrides.claude ?? {}) };
    }
    if (tool === "opencode" && typeof overrides?.opencode === "object") {
      effectiveProfile.opencode = { ...(effectiveProfile.opencode ?? {}), ...(overrides.opencode ?? {}) };
    }
    if (tool === "codex") {
      const model = toNonEmpty(effectiveProfile?.codex?.model);
      if (model && !caps.codex.supports.model) throw new Error("unsupported:codex.model");
      if (model) effectiveProfile.codex.model = model;
      else delete effectiveProfile.codex?.model;
    }
    if (tool === "claude") {
      const model = toNonEmpty(effectiveProfile?.claude?.model);
      if (model && !caps.claude.supports.model) throw new Error("unsupported:claude.model");
      if (model) effectiveProfile.claude.model = model;
      else delete effectiveProfile.claude?.model;
      const authMode = toClaudeAuthMode(effectiveProfile?.claude?.authMode);
      if (authMode) effectiveProfile.claude.authMode = authMode;
      else delete effectiveProfile.claude?.authMode;
    }

    const built = buildArgsForSession({
      tool,
      baseArgs: [],
      profile: effectiveProfile,
      cwd: input.cwd,
    });
    const codexExcludedAtSpawn = tool === "codex" && input.cwd ? snapshotCodexSessionIds(input.cwd) : null;
    const opencodeExcludedAtSpawn = tool === "opencode" && input.cwd ? await snapshotOpenCodeSessionIds(input.cwd) : null;
    const toolSessionIdForStore = tool === "claude" ? randomUUID() : null;
    if (tool === "claude" && toolSessionIdForStore) built.args.push("--session-id", toolSessionIdForStore);
    const claudeAuthMode = tool === "claude" ? resolveClaudeAuthMode(effectiveProfile?.claude) : undefined;

    const id = nanoid(12);
    sessions.createSession({
      id,
      tool,
      profileId,
      cwd: input.cwd,
      extraArgs: built.args,
      env: input.extraEnv ?? {},
      claudeAuthMode,
    });

    store.createSession({
      id,
      tool,
      profileId,
      toolSessionId: toolSessionIdForStore,
      cwd: input.cwd,
      workspaceKey: null,
      workspaceRoot: null,
      treePath: null,
    });
    ensureTaskForSession({
      sessionId: id,
      role: "solo",
      ordinal: 0,
      title: profile?.title ?? null,
    });

    attachBroadcast(id, tool);
    attachExitTracking(id);

    store.appendEvent(id, "session.created", {
      tool,
      profileId,
      cwd: input.cwd,
      args: built.args,
      notes: built.notes,
      overrides: overrides ?? {},
      savePreset: false,
    });

    if (tool === "codex" && input.cwd) {
      if (codexExcludedAtSpawn) codexLinkExcludedIds.set(id, codexExcludedAtSpawn);
      scheduleCodexToolSessionLink(id, input.cwd, Date.now(), { excludedIds: codexExcludedAtSpawn ?? undefined });
    }
    if (tool === "opencode" && input.cwd) {
      if (opencodeExcludedAtSpawn) opencodeLinkExcludedIds.set(id, opencodeExcludedAtSpawn);
      scheduleOpenCodeToolSessionLink(id, input.cwd, Date.now(), { excludedIds: opencodeExcludedAtSpawn ?? undefined });
    }

    if (input.cwd) {
      void (async () => {
        try {
          const gr = await resolveGitForPath(input.cwd);
          if (!gr.ok) return;
          const cur = store.getSession(id);
          if (!cur) return;
          store.setSessionMeta({
            id,
            workspaceKey: gr.workspaceKey,
            workspaceRoot: gr.workspaceRoot,
            treePath: gr.treeRoot,
            label: cur.label ?? null,
          });
          const evId = store.appendEvent(id, "session.git", {
            workspaceKey: gr.workspaceKey,
            workspaceRoot: gr.workspaceRoot,
            treePath: gr.treeRoot,
          });
          if (evId !== -1) {
            broadcastEvent(id, {
              id: evId,
              ts: Date.now(),
              kind: "session.git",
              data: { workspaceKey: gr.workspaceKey, workspaceRoot: gr.workspaceRoot, treePath: gr.treeRoot },
            });
          }
          broadcastGlobal({ type: "sessions.changed" });
          broadcastGlobal({ type: "workspaces.changed" });
        } catch {
          // ignore
        }
      })();
    }

    if (profile && profile.tool === tool) {
      try {
        const writes = macroToWrites(profile.startup as any);
        for (const w of writes) sessions.write(id, w);
      } catch {
        // ignore
      }
    }

    broadcastGlobal({ type: "sessions.changed" });
    broadcastGlobal({ type: "workspaces.changed" });
    broadcastGlobal({ type: "tasks.changed" });
    return id;
  }

  async function sendInputDirect(sessionId: string, text: string): Promise<void> {
    const sess = store.getSession(sessionId);
    if (!sess) throw new Error("session_not_found");
    const transport = sessionTransport(sess);
    if (transport === "pty") {
      const st = sessions.getStatus(sessionId);
      if (!st || !st.running) throw new Error("session_not_running");
    } else if (transport === "codex-app-server" && sess.tool === "codex") {
      const threadId = sess.toolSessionId ? String(sess.toolSessionId) : "";
      if (!threadId) throw new Error("no_thread");
      codexNativeThreadToSession.set(threadId, sessionId);

      let cleaned = String(text ?? "");
      if (cleaned.endsWith("\r\n")) cleaned = cleaned.slice(0, -2);
      else if (cleaned.endsWith("\r")) cleaned = cleaned.slice(0, -1);

      const wantsPlan = String(sess.profileId ?? "").toLowerCase().includes("plan");
      const meta = codexNativeThreadMeta.get(threadId) ?? null;
      const collaborationMode =
        wantsPlan && meta?.model
          ? { mode: "plan", settings: { model: meta.model, reasoning_effort: null, developer_instructions: null } }
          : null;

      await codexApp.ensureStarted();
      const r: any = await codexApp.call("turn/start", {
        threadId,
        input: [{ type: "text", text: cleaned, text_elements: [] }],
        collaborationMode,
      });
      const turnId = typeof r?.turn?.id === "string" ? String(r.turn.id) : null;
      codexNativeThreadRun.set(threadId, { running: true, turnId });
    } else {
      throw new Error(`unsupported_transport:${transport}`);
    }

    const evId = store.appendEvent(sessionId, "input", { text });
    broadcastEvent(sessionId, { id: evId, ts: Date.now(), kind: "input", data: { text } });
    if (transport === "pty") {
      sessions.write(sessionId, text);
      if (sess.tool === "codex" && !sess.toolSessionId && sess.cwd) {
        scheduleCodexToolSessionLink(sessionId, sess.cwd, Date.now(), { excludedIds: getCodexLinkExcludedIds(sessionId) });
      }
      if (sess.tool === "opencode" && !sess.toolSessionId && sess.cwd) {
        scheduleOpenCodeToolSessionLink(sessionId, sess.cwd, Date.now(), { excludedIds: getOpenCodeLinkExcludedIds(sessionId) });
      }
    }
    broadcastGlobal({ type: "sessions.changed" });
    broadcastGlobal({ type: "workspaces.changed" });
  }

  async function deleteSessionDirect(sessionId: string): Promise<void> {
    const sess = store.getSession(sessionId);
    if (!sess) return;
    if (closingSessions.has(sessionId)) return;
    closingSessions.add(sessionId);
    try {
      await closeSessionLifecycle({ sessionId, storeSession: sess, force: true, deleteRecord: true });
    } finally {
      closingSessions.delete(sessionId);
    }
  }

  function readWorkerProgressMarkdown(
    baseDir: string,
    worker?: {
      workerIndex?: number | null;
      workerName?: string | null;
    },
  ): {
    found: boolean;
    relPath: string | null;
    updatedAt: number | null;
    checklistDone: number;
    checklistTotal: number;
    preview: string | null;
    excerpt: string | null;
  } {
    const workerIdx = Number(worker?.workerIndex ?? -1);
    const workerName = toNonEmpty(worker?.workerName ?? "");
    const candidates = [
      ...(workerName || workerIdx >= 0
        ? [
            workerIdx >= 0 && workerName ? `.agents/tasks/worker-${workerIdx + 1}-${branchSlug(workerName)}.md` : "",
            workerIdx >= 0 ? `.agents/tasks/worker-${workerIdx + 1}.md` : "",
            workerName ? `.agents/tasks/${branchSlug(workerName)}.md` : "",
          ].filter(Boolean)
        : []),
      ".agents/tasks/task.md",
      ".agents/tasks/progress.md",
      ".fyp/task.md",
      ".fyp/progress.md",
      "task.md",
      "TASK.md",
      "progress.md",
      "PROGRESS.md",
    ];
    for (const relPath of candidates) {
      const absPath = path.join(baseDir, relPath);
      let st: fs.Stats | null = null;
      try {
        st = fs.statSync(absPath);
      } catch {
        st = null;
      }
      if (!st?.isFile()) continue;
      try {
        const raw = fs.readFileSync(absPath, "utf8");
        const text = String(raw ?? "")
          .replace(/\r\n/g, "\n")
          .replace(/\u0000/g, "")
          .slice(0, 64_000);
        const checklistDone = (text.match(/^\s*[-*]\s*\[[xX]\]/gm) ?? []).length;
        const checklistTotal = (text.match(/^\s*[-*]\s*\[(?: |x|X)\]/gm) ?? []).length;
        const nonEmpty = text
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .filter((line) => !line.startsWith("```"));
        const preview = nonEmpty.slice(0, 3).join(" · ").slice(0, 260) || null;
        const excerpt = nonEmpty.slice(0, 24).join("\n").slice(0, 2200) || null;
        return {
          found: true,
          relPath,
          updatedAt: Math.floor(Number(st.mtimeMs || Date.now())),
          checklistDone,
          checklistTotal,
          preview,
          excerpt,
        };
      } catch {
        continue;
      }
    }
    return {
      found: false,
      relPath: null,
      updatedAt: null,
      checklistDone: 0,
      checklistTotal: 0,
      preview: null,
      excerpt: null,
    };
  }

  function isPlaceholderWorkerPreview(raw: string): boolean {
    const text = String(raw ?? "").trim();
    if (!text) return true;
    if (/^#\s*worker\s+\d+\s+task\s+card\b/i.test(text)) return true;
    if (/^bootstrap-ack(?:-confirmed)?\b/i.test(text)) return true;
    if (/reply once with:\s*bootstrap-ack/i.test(text)) return true;
    if (/\bgenerated:\s*\d{4}-\d{2}-\d{2}t/i.test(text) && /\borchestration id:\s*`?[-_a-z0-9]+`?/i.test(text)) return true;
    return false;
  }

  function selectWorkerPreview(input: {
    progressPreview?: string | null;
    progressUpdatedAt?: number | null;
    livePreview?: string | null;
    livePreviewTs?: number | null;
  }): { preview: string | null; source: "none" | "progress" | "live" } {
    const progressPreview = toNonEmpty(input.progressPreview ?? "");
    const progressUpdatedAt = Number(input.progressUpdatedAt ?? 0) || 0;
    const livePreviewRaw = toNonEmpty(input.livePreview ?? "");
    const livePreview = livePreviewRaw && !isCodexInteractivePreviewLine(livePreviewRaw) ? livePreviewRaw : "";
    const livePreviewTs = Number(input.livePreviewTs ?? 0) || 0;

    if (livePreview) {
      const progressLooksPlaceholder = isPlaceholderWorkerPreview(progressPreview);
      const liveIsNewer = livePreviewTs > progressUpdatedAt + 250;
      if (!progressPreview || progressLooksPlaceholder || liveIsNewer) {
        return { preview: livePreview, source: "live" };
      }
    }
    if (progressPreview) return { preview: progressPreview, source: "progress" };
    if (livePreview) return { preview: livePreview, source: "live" };
    return { preview: null, source: "none" };
  }

  function deriveWorkerActivity(input: {
    running: boolean;
    attention: number;
    previewTs?: number | null;
    progressUpdatedAt?: number | null;
    lastEventTs?: number | null;
    sessionUpdatedAt?: number | null;
    now?: number;
  }): {
    state: "live" | "needs_input" | "waiting_or_done" | "idle";
    stale: boolean;
    staleAfterMs: number;
    lastActivityAt: number | null;
    idleForMs: number | null;
  } {
    const now = Number.isFinite(Number(input.now)) ? Number(input.now) : Date.now();
    const times = [
      Number(input.previewTs ?? 0),
      Number(input.progressUpdatedAt ?? 0),
      Number(input.lastEventTs ?? 0),
      Number(input.sessionUpdatedAt ?? 0),
    ].filter((v) => Number.isFinite(v) && v > 0);
    const lastActivityAt = times.length ? Math.max(...times) : null;
    const idleForMs = lastActivityAt == null ? null : Math.max(0, now - lastActivityAt);
    const stale = Boolean(input.running && idleForMs != null && idleForMs >= ORCH_WORKER_STALE_MS);
    const attention = Math.max(0, Math.floor(Number(input.attention) || 0));

    let state: "live" | "needs_input" | "waiting_or_done" | "idle";
    if (!input.running) state = "idle";
    else if (!stale) state = "live";
    else if (attention > 0) state = "needs_input";
    else state = "waiting_or_done";

    return {
      state,
      stale,
      staleAfterMs: ORCH_WORKER_STALE_MS,
      lastActivityAt,
      idleForMs,
    };
  }

  type OrchestrationStartupState = {
    dispatchMode: "orchestrator-first" | "worker-first";
    state: "auto-released" | "waiting-first-dispatch" | "running";
    deferredInitialDispatch: string[];
    dispatchedSessionIds: string[];
    pendingSessionIds: string[];
    pendingWorkerNames: string[];
  };

  const ORCH_STARTUP_DISPATCH_SCAN_BATCH = 80;
  const ORCH_STARTUP_DISPATCH_SCAN_PAGES = 24;

  function normalizeOrchestrationDispatchMode(raw: any): "orchestrator-first" | "worker-first" {
    const dispatchModeRaw = typeof raw === "string" ? String(raw) : "worker-first";
    return dispatchModeRaw === "orchestrator-first" ? "orchestrator-first" : "worker-first";
  }

  function collectOrchestratorDispatchEvidence(orchestratorSessionId: string): Set<string> {
    const sid = toNonEmpty(orchestratorSessionId);
    if (!sid) return new Set();

    const latestRef = store.getEvents(sid, { limit: 1, cursor: null }).items.at(-1);
    const latestEventId = Number(latestRef?.id ?? 0);
    if (!Number.isFinite(latestEventId) || latestEventId <= 0) return new Set();

    const cached = orchestrationDispatchEvidenceCache.get(sid);
    if (cached && cached.latestEventId === latestEventId) {
      return new Set(cached.sentSessionIds);
    }

    const sentSessionIds = cached ? new Set(cached.sentSessionIds) : new Set<string>();
    const stopAtEventId = Number(cached?.latestEventId ?? 0);
    let cursor: number | null = null;

    for (let page = 0; page < ORCH_STARTUP_DISPATCH_SCAN_PAGES; page++) {
      const eventsPage = store.getEvents(sid, {
        limit: ORCH_STARTUP_DISPATCH_SCAN_BATCH,
        cursor,
      });
      const items = Array.isArray(eventsPage.items) ? eventsPage.items : [];
      if (!items.length) break;

      let hitStop = false;
      for (let i = items.length - 1; i >= 0; i--) {
        const ev = items[i];
        const evId = Number(ev?.id ?? 0);
        if (stopAtEventId > 0 && evId <= stopAtEventId) {
          hitStop = true;
          break;
        }
        if (String(ev?.kind ?? "") !== "orchestration.dispatch") continue;
        const sent = Array.isArray(ev?.data?.sent) ? ev.data.sent : [];
        for (const rawSid of sent) {
          const workerSid = toNonEmpty(rawSid);
          if (workerSid) sentSessionIds.add(workerSid);
        }
      }

      if (hitStop || eventsPage.nextCursor == null) break;
      cursor = Number(eventsPage.nextCursor);
      if (!Number.isFinite(cursor) || cursor <= 0) break;
    }

    orchestrationDispatchEvidenceCache.set(sid, {
      latestEventId,
      sentSessionIds: new Set(sentSessionIds),
    });
    return sentSessionIds;
  }

  function orchestrationStartupView(input: { orchestration: any; workers: any[] }): OrchestrationStartupState {
    const orch = input.orchestration;
    const createdMeta = store.getLatestEvent(String(orch.orchestratorSessionId), "orchestration.created")?.data ?? {};
    const dispatchMode = normalizeOrchestrationDispatchMode(createdMeta?.dispatchMode);

    const deferredRaw: string[] = Array.isArray(createdMeta?.deferredInitialDispatch)
      ? createdMeta.deferredInitialDispatch
          .map((v: any) => toNonEmpty(v))
          .filter((v: string): v is string => Boolean(v))
      : [];
    const deferredInitialDispatch: string[] = Array.from(new Set(deferredRaw));

    const sentEvidence =
      dispatchMode === "orchestrator-first" && deferredInitialDispatch.length > 0
        ? collectOrchestratorDispatchEvidence(String(orch.orchestratorSessionId))
        : new Set<string>();
    const pendingSessionIds: string[] =
      dispatchMode === "orchestrator-first"
        ? deferredInitialDispatch.filter((sid) => !sentEvidence.has(sid))
        : [];
    const dispatchedSessionIds: string[] =
      dispatchMode === "orchestrator-first"
        ? deferredInitialDispatch.filter((sid) => sentEvidence.has(sid))
        : [];
    const pendingWorkerNames = pendingSessionIds
      .map((sid) => input.workers.find((w) => String(w.sessionId) === sid))
      .map((w) => (w ? toNonEmpty(w.name) : null))
      .filter(Boolean) as string[];

    const state: OrchestrationStartupState["state"] =
      dispatchMode === "worker-first"
        ? "auto-released"
        : pendingSessionIds.length > 0
          ? "waiting-first-dispatch"
          : "running";

    return {
      dispatchMode,
      state,
      deferredInitialDispatch,
      dispatchedSessionIds,
      pendingSessionIds,
      pendingWorkerNames,
    };
  }

  function orchestrationProgressView(rec: { orchestration: any; workers: any[] }) {
    const counts = store.getOpenAttentionCounts();
    const now = Date.now();
    const startup = orchestrationStartupView(rec);
    const workers = rec.workers.map((w) => {
      const sid = String(w.sessionId);
      const sess = store.getSession(sid);
      const running = sess ? isStoreSessionRunning(sess) : false;
      const attention = Number(counts[sid] ?? 0);
      const previewState = lastPreview.get(sid) ?? null;
      const lastEvent = latestSessionEventRef(sid);
      const baseDir = toNonEmpty(w.worktreePath) || toNonEmpty(w.projectPath);
      const progress = baseDir
        ? readWorkerProgressMarkdown(baseDir, {
            workerIndex: Number(w.workerIndex),
            workerName: String(w.name),
          })
        : {
            found: false,
            relPath: null,
            updatedAt: null,
            checklistDone: 0,
            checklistTotal: 0,
            preview: null,
            excerpt: null,
          };
      const activity = deriveWorkerActivity({
        running,
        attention,
        previewTs: previewState?.ts ?? null,
        progressUpdatedAt: progress.updatedAt ?? null,
        lastEventTs: lastEvent?.ts ?? null,
        sessionUpdatedAt: Number(sess?.updatedAt ?? 0) || null,
        now,
      });
      const effectivePreview = selectWorkerPreview({
        progressPreview: progress.preview,
        progressUpdatedAt: progress.updatedAt,
        livePreview: previewState?.line ?? null,
        livePreviewTs: previewState?.ts ?? null,
      });
      return {
        workerIndex: Number(w.workerIndex),
        name: String(w.name),
        sessionId: sid,
        running,
        attention,
        branch: toNonEmpty(w.branch) || null,
        worktreePath: toNonEmpty(w.worktreePath) || null,
        projectPath: toNonEmpty(w.projectPath) || null,
        taskPrompt: String(w.taskPrompt ?? ""),
        preview: effectivePreview.preview,
        previewSource: effectivePreview.source,
        previewTs: previewState?.ts ?? null,
        lastEvent,
        activity,
        progress,
      };
    });
    return {
      orchestrationId: String(rec.orchestration.id),
      generatedAt: Date.now(),
      startup,
      workers,
    };
  }

  function orchestrationView(input: { orchestration: any; workers: any[] }) {
    const counts = store.getOpenAttentionCounts();
    const orch = input.orchestration;
    const lockRec = orchestrationLocks.get(orchLockKey(String(orch.id))) ?? null;
    const orchestratorSession = store.getSession(orch.orchestratorSessionId);
    const orchestratorRunning = orchestratorSession ? isStoreSessionRunning(orchestratorSession) : false;
    const startup = orchestrationStartupView(input);
    const dispatchMode = startup.dispatchMode;
    const deferredInitialDispatch = startup.deferredInitialDispatch;

    const workers = input.workers.map((w) => {
      const sess = store.getSession(String(w.sessionId));
      const running = sess ? isStoreSessionRunning(sess) : false;
      return {
        ...w,
        running,
        attention: counts[w.sessionId] ?? 0,
        preview: lastPreview.get(String(w.sessionId))?.line ?? null,
        session: sess
          ? {
              ...sess,
              running,
              closing: closingSessions.has(String(sess.id)),
            }
          : null,
      };
    });

    const runningWorkers = workers.filter((w) => w.running).length;
    const stoppedWorkers = workers.length - runningWorkers;
    const workerAttention = workers.reduce((n, w) => n + Number(w.attention ?? 0), 0);
    const missingWorkerSessions = workers.filter((w) => !w.session).length;

    return {
      id: orch.id,
      taskId: `orch:${orch.id}`,
      name: orch.name,
      projectPath: orch.projectPath,
      orchestratorSessionId: orch.orchestratorSessionId,
      status: String(orch.status ?? "active"),
      lastError: orch.lastError ?? null,
      cleanedAt: orch.cleanedAt ?? null,
      createdAt: orch.createdAt,
      updatedAt: orch.updatedAt,
      dispatchMode,
      deferredInitialDispatch,
      startup,
      workerCount: workers.length,
      runningWorkers,
      stoppedWorkers,
      missingWorkerSessions,
      attentionTotal: workerAttention + (counts[orch.orchestratorSessionId] ?? 0),
      lock: lockRec
        ? {
            operation: lockRec.op,
            owner: lockRec.owner,
            startedAt: lockRec.startedAt,
            ageMs: Math.max(0, Date.now() - lockRec.startedAt),
          }
        : null,
      orchestrator: {
        running: orchestratorRunning,
        attention: counts[orch.orchestratorSessionId] ?? 0,
        preview: lastPreview.get(String(orch.orchestratorSessionId))?.line ?? null,
        session: orchestratorSession
          ? {
              ...orchestratorSession,
              running: orchestratorRunning,
              closing: closingSessions.has(String(orchestratorSession.id)),
            }
          : null,
      },
      sync: orchestrationSyncView(String(orch.id)),
      automation: orchestrationAutomationView(String(orch.id)),
      workers,
    };
  }

  function taskPrimarySessionId(task: any, members: any[]): string | null {
    const parent = members.find((m) => m.role === "parent");
    if (parent?.sessionId) return String(parent.sessionId);
    const solo = members.find((m) => m.role === "solo");
    if (solo?.sessionId) return String(solo.sessionId);
    return members[0]?.sessionId ? String(members[0].sessionId) : null;
  }

  function taskView(task: any, opts?: { counts?: Record<string, number> }): any | null {
    const members = store.listTaskMembers(String(task.id));
    if (!members.length) return null;
    const counts = opts?.counts ?? store.getOpenAttentionCounts();
    let runningCount = 0;
    let pendingCount = 0;
    let lastActivityAt = Number(task.updatedAt ?? 0);

    const memberViews = members.map((m) => {
      const sess = store.getSession(String(m.sessionId));
      const running = sess ? isStoreSessionRunning(sess) : false;
      if (running) runningCount += 1;
      const attention = counts[String(m.sessionId)] ?? 0;
      pendingCount += attention;
      const preview = lastPreview.get(String(m.sessionId))?.line ?? null;
      const candidateUpdated = Math.max(Number(sess?.updatedAt ?? 0), Number(m.createdAt ?? 0));
      if (candidateUpdated > lastActivityAt) lastActivityAt = candidateUpdated;
      return {
        ...m,
        attention,
        running,
        preview,
        mode: normalizeTaskMode(m.modeOverride ?? task.defaultMode),
        session: sess
          ? {
              ...sess,
              running,
              closing: closingSessions.has(String(sess.id)),
            }
          : null,
      };
    });

    return {
      ...task,
      defaultMode: normalizeTaskMode(task.defaultMode),
      pendingCount,
      runningCount,
      memberCount: memberViews.length,
      lastActivityAt,
      primarySessionId: taskPrimarySessionId(task, memberViews),
      members: memberViews,
    };
  }

  app.get("/api/tasks", async (req) => {
    maybePruneOrphanTasks();
    const q = (req.query ?? {}) as any;
    const limit = Math.min(500, Math.max(1, Math.floor(Number(q?.limit ?? 120) || 120)));
    const includeInternal = q?.includeInternal === "1" || q?.includeInternal === "true" || q?.includeInternal === "yes";
    const includeArchived = q?.includeArchived === "1" || q?.includeArchived === "true" || q?.includeArchived === "yes";
    const includeIdle = q?.includeIdle === "1" || q?.includeIdle === "true" || q?.includeIdle === "yes";
    const counts = store.getOpenAttentionCounts();
    const items = store
      .listTasks(limit)
      .filter((t) => includeInternal || t.visibility !== "internal")
      .filter((t) => includeArchived || t.status !== "archived")
      .map((t) => taskView(t, { counts }))
      .filter(Boolean)
      .filter((t: any) => includeIdle || Number(t?.runningCount ?? 0) > 0 || Number(t?.pendingCount ?? 0) > 0)
      .sort((a, b) => Number(b?.lastActivityAt ?? 0) - Number(a?.lastActivityAt ?? 0));
    return { ok: true, items };
  });

  app.get("/api/tasks/:id", async (req, reply) => {
    const id = String((req.params as any)?.id ?? "").trim();
    if (!id) return reply.code(400).send({ ok: false, error: "bad_id" });
    const t = store.getTask(id);
    if (!t) return reply.code(404).send({ ok: false, error: "not_found" });
    const item = taskView(t);
    if (!item) return reply.code(404).send({ ok: false, error: "not_found" });
    return { ok: true, item };
  });

  app.post("/api/tasks/:id/open-target", async (req, reply) => {
    const id = String((req.params as any)?.id ?? "").trim();
    if (!id) return reply.code(400).send({ ok: false, error: "bad_id" });
    const t = store.getTask(id);
    if (!t) return reply.code(404).send({ ok: false, error: "not_found" });
    const tv = taskView(t);
    if (!tv) return reply.code(404).send({ ok: false, error: "not_found" });

    const members = Array.isArray(tv.members) ? tv.members : [];
    const ranked = members
      .slice()
      .sort((a: any, b: any) => {
        const aa = Number(a?.attention ?? 0);
        const bb = Number(b?.attention ?? 0);
        if (aa !== bb) return bb - aa;
        const ar = String(a?.role ?? "");
        const br = String(b?.role ?? "");
        const rank = (r: string) => (r === "parent" ? 0 : r === "solo" ? 1 : r === "child" ? 2 : 3);
        return rank(ar) - rank(br);
      });

    let sessionId = tv.primarySessionId ? String(tv.primarySessionId) : "";
    let attentionId: number | null = null;
    for (const m of ranked) {
      const sid = String(m?.sessionId ?? "");
      if (!sid) continue;
      const open = store.listInbox({ limit: 1, sessionId: sid });
      if (open.length > 0) {
        sessionId = sid;
        attentionId = Number(open[0]!.id);
        break;
      }
    }
    if (!sessionId) return reply.code(409).send({ ok: false, error: "no_member_sessions" });
    return { ok: true, taskId: id, sessionId, attentionId, focusAction: attentionId != null };
  });

  app.patch("/api/tasks/:id/mode", async (req, reply) => {
    const id = String((req.params as any)?.id ?? "").trim();
    if (!id) return reply.code(400).send({ ok: false, error: "bad_id" });
    const t = store.getTask(id);
    if (!t) return reply.code(404).send({ ok: false, error: "not_found" });
    const body = (req.body ?? {}) as any;
    const mode = String(body?.mode ?? "").trim();
    if (mode !== "wrap" && mode !== "terminal") return reply.code(400).send({ ok: false, error: "bad_mode" });
    if (mode === "terminal" && !terminalModeEnabled) {
      return reply.code(409).send({ ok: false, error: "terminal_mode_disabled", message: "Raw terminal mode is disabled on this server." });
    }
    store.setTaskDefaultMode(id, normalizeTaskMode(mode));
    broadcastGlobal({ type: "tasks.changed" });
    return { ok: true, id, mode: normalizeTaskMode(mode), terminalModeEnabled };
  });

  app.patch("/api/tasks/:id/members/:sessionId/mode", async (req, reply) => {
    const id = String((req.params as any)?.id ?? "").trim();
    const sessionId = String((req.params as any)?.sessionId ?? "").trim();
    if (!id || !sessionId) return reply.code(400).send({ ok: false, error: "bad_id" });
    const t = store.getTask(id);
    if (!t) return reply.code(404).send({ ok: false, error: "not_found" });
    const mem = store.getTaskMemberBySession(sessionId);
    if (!mem || mem.taskId !== id) return reply.code(404).send({ ok: false, error: "member_not_found" });
    const body = (req.body ?? {}) as any;
    const modeRaw = String(body?.mode ?? "").trim();
    if (modeRaw === "terminal" && !terminalModeEnabled) {
      return reply.code(409).send({ ok: false, error: "terminal_mode_disabled", message: "Raw terminal mode is disabled on this server." });
    }
    const mode = modeRaw === "wrap" || modeRaw === "terminal" ? modeRaw : null;
    store.setTaskMemberModeOverride(id, sessionId, mode ? normalizeTaskMode(mode) : null);
    broadcastGlobal({ type: "tasks.changed" });
    return { ok: true, id, sessionId, mode: mode ? normalizeTaskMode(mode) : null, terminalModeEnabled };
  });

  app.post("/api/tasks/:id/archive", async (req, reply) => {
    const id = String((req.params as any)?.id ?? "").trim();
    if (!id) return reply.code(400).send({ ok: false, error: "bad_id" });
    const t = store.getTask(id);
    if (!t) return reply.code(404).send({ ok: false, error: "not_found" });
    const body = (req.body ?? {}) as any;
    const stopMembers = body?.stopMembers !== false;
    const hardCleanup = body?.hardCleanup === true;

    const members = store.listTaskMembers(id);
    const summary = {
      stopped: 0,
      skipped: 0,
      failed: 0,
    };
    if (stopMembers) {
      for (const m of members) {
        const sid = String(m.sessionId);
        const sess = store.getSession(sid);
        if (!sess) {
          summary.skipped += 1;
          continue;
        }
        try {
          await closeSessionLifecycle({
            sessionId: sid,
            storeSession: sess,
            force: true,
            deleteRecord: hardCleanup,
          });
          summary.stopped += 1;
        } catch {
          summary.failed += 1;
        }
      }
    }
    store.setTaskStatus(id, "archived", Date.now());
    if (hardCleanup) {
      store.clearTaskMembers(id);
      store.pruneOrphanTasks();
    }
    broadcastGlobal({ type: "tasks.changed" });
    broadcastGlobal({ type: "sessions.changed" });
    broadcastGlobal({ type: "workspaces.changed" });
    return { ok: summary.failed === 0, id, archived: true, hardCleanup, summary };
  });

  app.get("/api/orchestrations", async (req) => {
    const q = (req.query ?? {}) as any;
    const limit = Number(q?.limit ?? 80);
    const rows = store.listOrchestrations(limit);
    const items = rows
      .map((r) => store.getOrchestration(r.id))
      .filter(Boolean)
      .map((rec) => orchestrationView(rec!));
    return { ok: true, items };
  });

  app.get("/api/orchestrations/:id", async (req, reply) => {
    const id = String((req.params as any)?.id ?? "").trim();
    if (!id) return reply.code(400).send({ ok: false, error: "bad_id" });
    const rec = store.getOrchestration(id);
    if (!rec) return reply.code(404).send({ ok: false, error: "not_found" });
    return { ok: true, item: orchestrationView(rec) };
  });

  app.get("/api/orchestrations/:id/progress", async (req, reply) => {
    const id = String((req.params as any)?.id ?? "").trim();
    if (!id) return reply.code(400).send({ ok: false, error: "bad_id" });
    const rec = store.getOrchestration(id);
    if (!rec) return reply.code(404).send({ ok: false, error: "not_found" });
    return {
      ok: true,
      item: orchestrationProgressView(rec),
    };
  });

  function resolveOrchestrationDispatchTargets(rec: { orchestration: any; workers: any[] }, targetRaw: any): {
    targets: Array<{ workerIndex: number; name: string; sessionId: string }>;
    availableTargets: Array<{ workerIndex: number; name: string; sessionId: string; aliases: string[] }>;
  } {
    const targetsIn = Array.isArray(targetRaw) ? targetRaw : [targetRaw ?? "all"];
    const allWorkers = rec.workers.map((w) => ({
      workerIndex: Number(w.workerIndex),
      name: String(w.name),
      sessionId: String(w.sessionId),
    }));

    const picked = new Map<string, { workerIndex: number; name: string; sessionId: string }>();
    const canonicalName = (v: string): string =>
      String(v ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "");
    const slugName = (v: string): string =>
      String(v ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "");
    const findWorkerByName = (needleRaw: string) => {
      const needle = String(needleRaw ?? "").trim().toLowerCase();
      if (!needle) return null;
      const canon = canonicalName(needle);
      const slug = slugName(needle);
      return (
        allWorkers.find((w) => String(w.name).trim().toLowerCase() === needle) ||
        allWorkers.find((w) => canonicalName(w.name) === canon) ||
        allWorkers.find((w) => slugName(w.name) === slug) ||
        null
      );
    };
    const addBySessionId = (sid: string) => {
      const f = allWorkers.find((w) => w.sessionId === sid);
      if (f) picked.set(f.sessionId, f);
    };
    for (const t0 of targetsIn) {
      const t = typeof t0 === "string" ? t0.trim() : "";
      if (!t || t === "all" || t === "*") {
        for (const w of allWorkers) picked.set(w.sessionId, w);
        continue;
      }
      if (/^\d+$/.test(t)) {
        const idx = Number(t) - 1;
        const f = allWorkers.find((w) => w.workerIndex === idx);
        if (f) picked.set(f.sessionId, f);
        continue;
      }
      if (t.startsWith("worker:")) {
        const name = t.slice("worker:".length).trim();
        const f = findWorkerByName(name);
        if (f) picked.set(f.sessionId, f);
        continue;
      }
      if (t.startsWith("session:")) {
        addBySessionId(t.slice("session:".length).trim());
        continue;
      }
      // sessionId or name fallback
      addBySessionId(t);
      const byName = findWorkerByName(t);
      if (byName) picked.set(byName.sessionId, byName);
    }

    return {
      targets: Array.from(picked.values()),
      availableTargets: allWorkers.map((w) => ({
        workerIndex: w.workerIndex + 1,
        name: w.name,
        sessionId: w.sessionId,
        aliases: [`worker:${w.name}`, `worker:${slugName(w.name)}`, String(w.workerIndex + 1), `session:${w.sessionId}`],
      })),
    };
  }

  async function dispatchOrchestrationText(
    orchestrationId: string,
    rec: { orchestration: any; workers: any[] },
    input: {
      text: string;
      targetRaw: any;
      interrupt: boolean;
      forceInterrupt?: boolean;
      includeBootstrapIfPresent?: boolean;
      source?: string;
      kickoffLabel?: string;
    },
  ): Promise<{
    targets: Array<{ workerIndex: number; name: string; sessionId: string }>;
    availableTargets: Array<{ workerIndex: number; name: string; sessionId: string; aliases: string[] }>;
    sent: any[];
    failed: any[];
  }> {
    const resolved = resolveOrchestrationDispatchTargets(rec, input.targetRaw);
    const targets = resolved.targets;
    const sent: any[] = [];
    const failed: any[] = [];
    if (!targets.length) {
      return { targets, availableTargets: resolved.availableTargets, sent, failed };
    }

    const text = toNonEmpty(input.text);
    if (!text) {
      return { targets: [], availableTargets: resolved.availableTargets, sent, failed: [{ reason: "missing_text" }] };
    }
    const includeBootstrapIfPresent = input.includeBootstrapIfPresent === true;

    const attentionCounts = store.getOpenAttentionCounts();
    for (const tgt of targets) {
      try {
        await waitForSessionReady(tgt.sessionId, 30_000);
        const sess = store.getSession(tgt.sessionId);
        if (!sess) throw new Error("session_not_found");
        const attention = Number(attentionCounts[tgt.sessionId] ?? 0);
        const previewState = lastPreview.get(tgt.sessionId) ?? null;
        const lastEvent = latestSessionEventRef(tgt.sessionId);
        const hadDoneLatch = hasWorkerDoneLatch(orchestrationId, tgt.sessionId);
        if (hadDoneLatch) clearWorkerDoneLatch(orchestrationId, tgt.sessionId);
        const activity = deriveWorkerActivity({
          running: isStoreSessionRunning(sess),
          attention,
          previewTs: previewState?.ts ?? null,
          lastEventTs: lastEvent?.ts ?? null,
          sessionUpdatedAt: Number(sess.updatedAt ?? 0) || null,
          now: Date.now(),
        });
        const forceInterrupt = input.forceInterrupt === true;
        const allowInterrupt = Boolean(
          input.interrupt &&
            !hadDoneLatch &&
            (forceInterrupt ||
              activity.state === "needs_input" ||
              activity.state === "waiting_or_done" ||
              (activity.stale && attention > 0)),
        );

        if (allowInterrupt) {
          const transport = sessionTransport(sess);
          if (transport === "codex-app-server" && sess.tool === "codex") {
            const threadId = sess.toolSessionId ? String(sess.toolSessionId) : "";
            const turnId = threadId ? codexNativeThreadRun.get(threadId)?.turnId ?? null : null;
            if (threadId && turnId) {
              try {
                await codexApp.ensureStarted();
                await codexApp.call("turn/interrupt", { threadId, turnId });
              } catch {
                // ignore
              }
            }
          } else {
            try {
              sessions.interrupt(tgt.sessionId);
            } catch {
              // ignore
            }
          }
        }
        const pendingFallback = firstUserBootstrapFallback.get(tgt.sessionId) ?? null;
        const hadPendingBootstrapFallback = Boolean(pendingFallback);
        let outboundText = text;
        let injectedBootstrap = false;
        if (pendingFallback && includeBootstrapIfPresent) {
          const boot = toNonEmpty(pendingFallback.text);
          if (boot) {
            outboundText = `${boot}\n\n${text}`;
            injectedBootstrap = true;
          }
        }
        if (hadPendingBootstrapFallback) {
          // Once orchestrator dispatch begins for a worker, avoid injecting the giant bootstrap
          // block into dispatch payloads. Keep dispatch messages concise and directly executable.
          clearBootstrapRetry(tgt.sessionId);
          firstUserBootstrapFallback.delete(tgt.sessionId);
        }
        await waitForSessionWarmup(tgt.sessionId, {
          settleMs: 320,
          previewProbeMs: 5200,
          requireInteractive: true,
        });
        await sendInputDirect(tgt.sessionId, normalizePromptInput(outboundText));
        sent.push({
          sessionId: tgt.sessionId,
          name: tgt.name,
          workerIndex: tgt.workerIndex + 1,
          injectedBootstrap,
          clearedBootstrapFallback: hadPendingBootstrapFallback,
          interruptRequested: input.interrupt,
          forceInterrupt,
          interruptIssued: allowInterrupt,
          interruptSkippedReason: input.interrupt && !allowInterrupt ? "worker_active" : null,
          activityState: activity.state,
          doneLatchCleared: hadDoneLatch,
        });
      } catch (e: any) {
        failed.push({
          sessionId: tgt.sessionId,
          name: tgt.name,
          reason: String(e?.message ?? "dispatch_failed"),
        });
      }
    }

    try {
      store.appendEvent(rec.orchestration.orchestratorSessionId, "orchestration.dispatch", {
        orchestrationId,
        sent: sent.map((s) => s.sessionId),
        failed,
        interrupt: input.interrupt,
        source: toNonEmpty(input.source) || "api.dispatch",
      });
    } catch {
      // ignore
    }

    broadcastGlobal({ type: "orchestrations.changed" });
    broadcastGlobal({ type: "sessions.changed" });
    return {
      targets,
      availableTargets: resolved.availableTargets,
      sent,
      failed,
    };
  }

  app.post("/api/orchestrations/:id/dispatch", async (req, reply) => {
    const id = String((req.params as any)?.id ?? "").trim();
    if (!id) return reply.code(400).send({ ok: false, error: "bad_id" });
    const rec = store.getOrchestration(id);
    if (!rec) return reply.code(404).send({ ok: false, error: "not_found" });

    const body = (req.body ?? {}) as any;
    const text = toNonEmpty(body?.text || body?.prompt || "");
    if (!text) return reply.code(400).send({ ok: false, error: "missing_text" });
    const interrupt = body?.interrupt === true;
    const forceInterrupt = parseForceInterruptFlag(body);
    const run = await dispatchOrchestrationText(id, rec, {
      text,
      targetRaw: body?.target,
      interrupt,
      forceInterrupt,
      source: "api.dispatch",
      kickoffLabel: "ORCHESTRATOR DISPATCH MESSAGE",
    });
    if (!run.targets.length) {
      return reply.code(400).send({
        ok: false,
        error: "no_targets",
        availableTargets: run.availableTargets,
      });
    }
    return {
      ok: run.failed.length === 0,
      orchestrationId: id,
      sent: run.sent,
      failed: run.failed,
      count: { sent: run.sent.length, failed: run.failed.length },
    };
  });

  app.post("/api/orchestrations/:id/send-task", async (req, reply) => {
    const id = String((req.params as any)?.id ?? "").trim();
    if (!id) return reply.code(400).send({ ok: false, error: "bad_id" });
    const rec = store.getOrchestration(id);
    if (!rec) return reply.code(404).send({ ok: false, error: "not_found" });

    const body = (req.body ?? {}) as any;
    const text = toNonEmpty(body?.task || body?.text || body?.prompt || "");
    if (!text) return reply.code(400).send({ ok: false, error: "missing_task" });
    const interrupt = body?.interrupt === true;
    const forceInterrupt = parseForceInterruptFlag(body);
    const includeBootstrapIfPresent =
      body?.initialize === true ||
      body?.init === true ||
      body?.includeBootstrap === true ||
      body?.first === true;
    const run = await dispatchOrchestrationText(id, rec, {
      text,
      targetRaw: body?.target,
      interrupt,
      forceInterrupt,
      includeBootstrapIfPresent,
      source: "api.send_task",
      kickoffLabel: "ORCHESTRATOR DISPATCH MESSAGE",
    });
    if (!run.targets.length) {
      return reply.code(400).send({
        ok: false,
        error: "no_targets",
        availableTargets: run.availableTargets,
      });
    }
    return {
      ok: run.failed.length === 0,
      orchestrationId: id,
      sent: run.sent,
      failed: run.failed,
      count: { sent: run.sent.length, failed: run.failed.length },
      mode: "send-task",
    };
  });

  app.post("/api/orchestrations/:id/commands/execute", async (req, reply) => {
    const id = String((req.params as any)?.id ?? "").trim();
    if (!id) return reply.code(400).send({ ok: false, error: "bad_id" });
    const rec = store.getOrchestration(id);
    if (!rec) return reply.code(404).send({ ok: false, error: "not_found" });

    const body = (req.body ?? {}) as any;
    const commandId = toNonEmpty(body?.commandId || body?.id).toLowerCase();
    if (!commandId) return reply.code(400).send({ ok: false, error: "missing_commandId" });
    const catalog = defaultCommandCatalog();
    const command = catalog.find((c) => String(c.id).toLowerCase() === commandId) ?? null;
    if (!command) {
      return reply.code(400).send({
        ok: false,
        error: "unknown_command",
        commandId,
        available: catalog.map((c) => c.id),
      });
    }

    const modeMeta = commandExecutionModeForId(command.id);
    const schemaValidation = validateHarnessCommandPayloadBySchema({
      command,
      mode: modeMeta.mode,
      payload: {
        ...body,
        commandId: command.id,
      },
    });
    if (!schemaValidation.ok) {
      return reply.code(400).send({
        ok: false,
        error: "invalid_command_payload",
        commandId: command.id,
        reason: schemaValidation.reason,
        issues: schemaValidation.errors.slice(0, 12),
      });
    }
    const policyDecision = evaluateHarnessCommandPolicy({
      command,
      mode: modeMeta.mode,
      payload: {
        ...body,
        commandId: command.id,
      },
      env: process.env,
    });
    if (!policyDecision.ok) {
      return reply.code(403).send({
        ok: false,
        error: "command_policy_blocked",
        commandId: command.id,
        tier: policyDecision.meta.tier,
        reason: policyDecision.reason,
        unmet: policyDecision.unmet,
        requirements: policyDecision.meta.requirements,
      });
    }
    const validatedInput = validateHarnessCommandInput(body);
    if (!validatedInput.ok) {
      return reply.code(400).send({
        ok: false,
        error: "invalid_command_payload",
        commandId: command.id,
        reason: validatedInput.reason,
      });
    }
    const commandInput = validatedInput.value;
    const headerKeyRaw = req.headers?.["idempotency-key"];
    const headerKey = Array.isArray(headerKeyRaw) ? toNonEmpty(headerKeyRaw[0]) : toNonEmpty(headerKeyRaw);
    const idempotencyKey = toNonEmpty(commandInput.idempotencyKey || headerKey);
    const cacheKey = idempotencyKey ? `${id}:${command.id}:${idempotencyKey}` : "";
    const now = Date.now();
    if (cacheKey) {
      pruneHarnessCommandExecutionCache(now);
      let cached = harnessCommandExecutionCache.get(cacheKey) ?? null;
      if (!cached) {
        try {
          const persisted = store.getHarnessCommandReplay(cacheKey);
          if (persisted) {
            cached = {
              ts: Number(persisted.ts ?? 0),
              response:
                persisted.response && typeof persisted.response === "object" && !Array.isArray(persisted.response)
                  ? persisted.response
                  : {},
            };
            harnessCommandExecutionCache.set(cacheKey, cached);
          }
        } catch {
          // ignore
        }
      }
      if (cached && now - Number(cached.ts ?? 0) <= HARNESS_COMMAND_IDEMPOTENCY_TTL_MS) {
        return {
          ok: true,
          replayed: true,
          orchestrationId: id,
          commandId: command.id,
          idempotencyKey,
          ...cached.response,
        };
      }
    }

    const interrupt = commandInput.interrupt === true;
    const forceInterrupt = parseForceInterruptFlag(body);
    const targetRaw = toNonEmpty(commandInput.target) || modeMeta.defaultTarget;
    const packetBody = {
      ...body,
      ...commandInput,
    };
    const payloadText =
      toNonEmpty(commandInput.rawPrompt) ||
      (modeMeta.mode === "orchestrator.input"
        ? buildHarnessCommandOrchestratorPacket({
            commandId: command.id,
            command,
            body: packetBody,
          })
        : buildHarnessCommandWorkerPacket({
            commandId: command.id,
            command,
            body: packetBody,
            mode: modeMeta.mode,
          }));

    let responseBody: Record<string, any> = {
      mode: modeMeta.mode,
      target: targetRaw,
      command: {
        id: command.id,
        title: command.title,
      },
      policy: {
        tier: policyDecision.meta.tier,
        bypassed: policyDecision.bypassed,
        satisfied: policyDecision.satisfied,
      },
    };

    if (modeMeta.mode === "system.sync") {
      const force = commandInput.force === true;
      const deliverRaw = commandInput.deliverToOrchestrator;
      const deliverToOrchestrator = typeof deliverRaw === "boolean" ? deliverRaw : true;
      const run = await runOrchestrationSync(id, {
        trigger: `api.command.${command.id}`,
        force,
        deliverToOrchestrator,
      });
      responseBody = {
        ...responseBody,
        sync: run,
      };
    } else if (modeMeta.mode === "system.review") {
      const run = await runOrchestrationSteeringReview(id, {
        trigger: `api.command.${command.id}`,
        force: commandInput.force === true,
      });
      responseBody = {
        ...responseBody,
        review: run,
      };
    } else if (modeMeta.mode === "orchestrator.input") {
      await sendInputDirect(String(rec.orchestration.orchestratorSessionId), normalizePromptInput(payloadText));
      responseBody = {
        ...responseBody,
        orchestratorSessionId: String(rec.orchestration.orchestratorSessionId),
        dispatched: true,
      };
    } else {
      const includeBootstrapIfPresent =
        commandInput.initialize === true ||
        body?.init === true ||
        commandInput.includeBootstrap === true ||
        body?.includeBootstrap === true ||
        body?.first === true ||
        modeMeta.includeBootstrapIfPresent;
      const run = await dispatchOrchestrationText(id, rec, {
        text: payloadText,
        targetRaw,
        interrupt,
        forceInterrupt,
        includeBootstrapIfPresent,
        source: `api.command.${command.id}`,
        kickoffLabel: "ORCHESTRATOR COMMAND MESSAGE",
      });
      if (!run.targets.length) {
        return reply.code(400).send({
          ok: false,
          error: "no_targets",
          commandId: command.id,
          availableTargets: run.availableTargets,
        });
      }
      responseBody = {
        ...responseBody,
        sent: run.sent,
        failed: run.failed,
        count: { sent: run.sent.length, failed: run.failed.length },
      };
    }

    try {
      store.appendEvent(rec.orchestration.orchestratorSessionId, "orchestration.command.executed", {
        orchestrationId: id,
        commandId: command.id,
        mode: modeMeta.mode,
        target: targetRaw,
        idempotencyKey: idempotencyKey || null,
        result: {
          mode: modeMeta.mode,
          policy: {
            tier: policyDecision.meta.tier,
            bypassed: policyDecision.bypassed,
          },
          ...(responseBody.count ? { count: responseBody.count } : {}),
          ...(responseBody.sync ? { sync: { reason: responseBody.sync.reason, delivered: responseBody.sync.delivered } } : {}),
          ...(responseBody.review ? { review: { reason: responseBody.review.reason, sent: responseBody.review.sent } } : {}),
        },
      });
    } catch {
      // ignore
    }
    broadcastGlobal({ type: "orchestrations.changed" });
    broadcastGlobal({ type: "sessions.changed" });

    if (cacheKey) {
      harnessCommandExecutionCache.set(cacheKey, {
        ts: now,
        response: { ...responseBody },
      });
      try {
        store.upsertHarnessCommandReplay({
          cacheKey,
          orchestrationId: id,
          commandId: command.id,
          ts: now,
          response: { ...responseBody },
        });
      } catch {
        // ignore
      }
    }

    return {
      ok: true,
      replayed: false,
      orchestrationId: id,
      commandId: command.id,
      idempotencyKey: idempotencyKey || null,
      ...responseBody,
    };
  });

  app.post("/api/orchestrations/:id/sync", async (req, reply) => {
    const id = String((req.params as any)?.id ?? "").trim();
    if (!id) return reply.code(400).send({ ok: false, error: "bad_id" });
    const rec = store.getOrchestration(id);
    if (!rec) return reply.code(404).send({ ok: false, error: "not_found" });

    const body = (req.body ?? {}) as any;
    const force = body?.force === true;
    const triggerRaw = toNonEmpty(body?.trigger) || toNonEmpty(body?.reason) || "manual";
    const trigger = triggerRaw.slice(0, 80);
    const deliverRaw = body?.deliverToOrchestrator;
    const deliverToOrchestrator = typeof deliverRaw === "boolean" ? deliverRaw : undefined;

    const run = await runOrchestrationSync(id, {
      trigger,
      force,
      deliverToOrchestrator,
    });
    return { ok: true, id, sync: run, state: orchestrationSyncView(id) };
  });

  app.patch("/api/orchestrations/:id/sync-policy", async (req, reply) => {
    const id = String((req.params as any)?.id ?? "").trim();
    if (!id) return reply.code(400).send({ ok: false, error: "bad_id" });
    const rec = store.getOrchestration(id);
    if (!rec) return reply.code(404).send({ ok: false, error: "not_found" });

    const body = (req.body ?? {}) as any;
    const wantsRunNow = body?.runNow === true;
    const runForce = body?.force === true;

    const lk = tryAcquireOrchestrationLock(id, "sync-policy");
    if (!lk.ok) return reply.code(409).send({ ok: false, error: "orchestration_locked", lock: lk.lock });
    const owner = lk.owner;
    try {
      const cur = ensureOrchestrationSyncState(id);

      if (body?.mode != null) {
        const mode = String(body.mode).trim();
        if (mode !== "off" && mode !== "manual" && mode !== "interval") {
          return reply.code(400).send({ ok: false, error: "bad_mode" });
        }
        cur.policy.mode = mode;
      }
      if (body?.intervalMs != null) {
        cur.policy.intervalMs = normalizeOrchestrationSyncInterval(body.intervalMs, cur.policy.intervalMs);
      }
      if (body?.minDeliveryGapMs != null) {
        cur.policy.minDeliveryGapMs = normalizeOrchestrationDeliveryGap(body.minDeliveryGapMs, cur.policy.minDeliveryGapMs);
      }
      if (body?.deliverToOrchestrator != null) {
        cur.policy.deliverToOrchestrator = Boolean(body.deliverToOrchestrator);
      }
    } finally {
      releaseOrchestrationLock(id, owner);
    }

    let run: Awaited<ReturnType<typeof runOrchestrationSync>> | null = null;
    if (wantsRunNow) {
      run = await runOrchestrationSync(id, {
        trigger: "policy.runNow",
        force: runForce,
      });
    }

    const view = orchestrationSyncView(id);
    return {
      ok: true,
      id,
      sync: {
        ...view,
        policy: { ...view.policy },
        run,
      },
    };
  });

  app.get("/api/orchestrations/:id/automation-policy", async (req, reply) => {
    const id = String((req.params as any)?.id ?? "").trim();
    if (!id) return reply.code(400).send({ ok: false, error: "bad_id" });
    const rec = store.getOrchestration(id);
    if (!rec) return reply.code(404).send({ ok: false, error: "not_found" });
    return {
      ok: true,
      id,
      automation: orchestrationAutomationView(id),
    };
  });

  app.patch("/api/orchestrations/:id/automation-policy", async (req, reply) => {
    const id = String((req.params as any)?.id ?? "").trim();
    if (!id) return reply.code(400).send({ ok: false, error: "bad_id" });
    const rec = store.getOrchestration(id);
    if (!rec) return reply.code(404).send({ ok: false, error: "not_found" });

    const body = (req.body ?? {}) as any;
    const wantsRunNow = body?.runNow === true;
    const runForce = body?.force === true;

    const lk = tryAcquireOrchestrationLock(id, "automation-policy");
    if (!lk.ok) return reply.code(409).send({ ok: false, error: "orchestration_locked", lock: lk.lock });
    const owner = lk.owner;
    try {
      const cur = ensureOrchestrationAutomationState(id);
      cur.policy = normalizeOrchestrationAutomationPolicy(body ?? {}, cur.policy);
      if (cur.policy.questionMode === "off") {
        for (const aid of cur.pendingAttentionIds) clearAttentionTimeoutTimer(aid);
        cur.pendingAttentionIds = [];
      }
    } finally {
      releaseOrchestrationLock(id, owner);
    }

    let run: Awaited<ReturnType<typeof runOrchestrationSteeringReview>> | null = null;
    if (wantsRunNow) {
      run = await runOrchestrationSteeringReview(id, {
        trigger: "policy.runNow",
        force: runForce,
      });
    }

    broadcastGlobal({ type: "orchestrations.changed" });
    return {
      ok: true,
      id,
      automation: {
        ...orchestrationAutomationView(id),
        run,
      },
    };
  });

  app.post("/api/orchestrations/:id/cleanup", async (req, reply) => {
    const id = String((req.params as any)?.id ?? "").trim();
    if (!id) return reply.code(400).send({ ok: false, error: "bad_id" });

    const rec = store.getOrchestration(id);
    if (!rec) return reply.code(404).send({ ok: false, error: "not_found" });

    const body = (req.body ?? {}) as any;
    const stopSessions = body?.stopSessions !== false;
    const deleteSessions = body?.deleteSessions === true;
    const removeWorktrees = body?.removeWorktrees !== false;
    const removeRecord = body?.removeRecord === true;
    const keepCoordinator = body?.keepCoordinator === true;

    const lk = tryAcquireOrchestrationLock(id, "cleanup");
    if (!lk.ok) return reply.code(409).send({ ok: false, error: "orchestration_locked", lock: lk.lock });
    const owner = lk.owner;

    const summary = {
      sessions: {
        attempted: 0,
        closed: 0,
        missing: 0,
        failed: 0,
      },
      worktrees: {
        attempted: 0,
        removed: 0,
        missing: 0,
        failed: 0,
      },
      errors: [] as Array<{ kind: string; target: string; message: string }>,
    };

    const debugDelayMs = Number(body?.debugDelayMs ?? 0);

    try {
      store.setOrchestrationState(id, { status: "cleaning", lastError: null, cleanedAt: null });
      broadcastGlobal({ type: "orchestrations.changed" });

      if (Number.isFinite(debugDelayMs) && debugDelayMs > 0 && process.env.NODE_ENV === "test") {
        await sleep(Math.min(2_000, Math.floor(debugDelayMs)));
      }

      const workerRows = rec.workers.slice();
      const sessionIds = new Set<string>();
      for (const w of workerRows) {
        if (w.sessionId) sessionIds.add(String(w.sessionId));
      }
      if (!keepCoordinator && rec.orchestration.orchestratorSessionId) {
        sessionIds.add(String(rec.orchestration.orchestratorSessionId));
      }

      if (stopSessions) {
        for (const sid of sessionIds) {
          summary.sessions.attempted += 1;
          const sess = store.getSession(sid);
          if (!sess) {
            summary.sessions.missing += 1;
            continue;
          }
          try {
            await closeSessionLifecycle({
              sessionId: sid,
              storeSession: sess,
              force: true,
              deleteRecord: deleteSessions,
            });
            summary.sessions.closed += 1;
          } catch (e: any) {
            summary.sessions.failed += 1;
            summary.errors.push({
              kind: "session",
              target: sid,
              message: String(e?.message ?? "failed to close session"),
            });
          }
        }
      }

      if (removeWorktrees) {
        const gitRootCache = new Map<string, string>();
        for (const w of workerRows) {
          const wtPath = typeof w.worktreePath === "string" ? w.worktreePath.trim() : "";
          if (!wtPath) continue;
          summary.worktrees.attempted += 1;

          if (!fs.existsSync(wtPath)) {
            summary.worktrees.missing += 1;
            continue;
          }

          const proj = String(w.projectPath || "").trim();
          let repoRoot = gitRootCache.get(proj) ?? "";
          if (!repoRoot) {
            try {
              const gr = await resolveGitForPath(proj);
              repoRoot = gr.ok ? gr.workspaceRoot : proj;
            } catch {
              repoRoot = proj;
            }
            gitRootCache.set(proj, repoRoot);
          }

          try {
            const rm = await removeGitWorktreeRobust({
              repoPath: repoRoot || proj,
              worktreePath: wtPath,
              force: true,
            });
            if (rm.ok) summary.worktrees.removed += 1;
            else {
              summary.worktrees.failed += 1;
              summary.errors.push({
                kind: "worktree",
                target: wtPath,
                message: rm.message,
              });
            }
          } catch (e: any) {
            summary.worktrees.failed += 1;
            summary.errors.push({
              kind: "worktree",
              target: wtPath,
              message: String(e?.message ?? "failed to remove worktree"),
            });
          }
        }
      }

      const ok = summary.errors.length === 0;
      if (ok) {
        store.setOrchestrationState(id, {
          status: "cleaned",
          lastError: null,
          cleanedAt: Date.now(),
        });
        const auto = orchestrationAutomationState.get(id);
        if (auto) {
          for (const aid of auto.pendingAttentionIds) clearAttentionTimeoutTimer(aid);
          auto.pendingAttentionIds = [];
        }
        const taskId = `orch:${id}`;
        if (store.getTask(taskId)) store.setTaskStatus(taskId, "archived", Date.now());
        if (removeRecord) {
          store.deleteOrchestration(id);
          orchestrationSyncState.delete(id);
          orchestrationAutomationState.delete(id);
          orchestrationDispatchEvidenceCache.delete(String(rec.orchestration.orchestratorSessionId));
          const signalPrefix = `${id}|`;
          for (const [sigKey, sigTimer] of orchestrationWorkerSignalTimers.entries()) {
            if (!sigKey.startsWith(signalPrefix)) continue;
            try {
              clearTimeout(sigTimer);
            } catch {
              // ignore
            }
            orchestrationWorkerSignalTimers.delete(sigKey);
          }
          for (const sigKey of orchestrationWorkerSignalLastSentAt.keys()) {
            if (sigKey.startsWith(signalPrefix)) orchestrationWorkerSignalLastSentAt.delete(sigKey);
          }
          const qtm = orchestrationQuestionBatchTimers.get(id);
          if (qtm) {
            try {
              clearTimeout(qtm);
            } catch {
              // ignore
            }
            orchestrationQuestionBatchTimers.delete(id);
          }
          if (store.getTask(taskId)) store.deleteTask(taskId);
        }
      } else {
        store.setOrchestrationState(id, {
          status: "error",
          lastError: summary.errors[0]?.message ?? "cleanup failed",
          cleanedAt: null,
        });
      }

      broadcastGlobal({ type: "sessions.changed" });
      broadcastGlobal({ type: "workspaces.changed" });
      broadcastGlobal({ type: "orchestrations.changed" });
      broadcastGlobal({ type: "tasks.changed" });

      return {
        ok,
        summary,
        orchestrationId: id,
        removeRecord: ok && removeRecord,
      };
    } finally {
      releaseOrchestrationLock(id, owner);
    }
  });

  app.post("/api/orchestrations", async (req, reply) => {
    const body = (req.body ?? {}) as any;
    const name = toNonEmpty(body?.name) || `Orchestration ${new Date().toISOString().slice(0, 19).replace("T", " ")}`;
    const projectPathRaw = toNonEmpty(body?.projectPath);
    if (!projectPathRaw) return reply.code(400).send({ ok: false, error: "bad_projectPath" });

    const vProject = validateCwd(projectPathRaw, roots);
    if (!vProject.ok) return reply.code(400).send({ ok: false, error: "bad_projectPath", reason: vProject.reason });
    const projectPath = vProject.cwd;
    const createLockId = `create:${projectPath}`;
    const createLock = tryAcquireOrchestrationLock(createLockId, "create");
    if (!createLock.ok) return reply.code(409).send({ ok: false, error: "orchestration_locked", lock: createLock.lock });
    const createLockOwner = createLock.owner;

    try {
      const orchestratorRaw = body?.orchestrator ?? {};
      const defaultTool = toToolId(body?.tool, "codex");
      const defaultProfileId = toNonEmpty(body?.profileId) || `${defaultTool}.default`;
      const orchestratorTool = toToolId(orchestratorRaw?.tool, defaultTool);
      const orchestratorProfileId = toNonEmpty(orchestratorRaw?.profileId) || `${orchestratorTool}.default`;
      const orchestratorPrompt =
        toNonEmpty(orchestratorRaw?.prompt) || toNonEmpty(body?.orchestratorPrompt);
      if (!orchestratorPrompt) return reply.code(400).send({ ok: false, error: "missing_orchestrator_prompt" });
      const orchestrationObjective =
        normalizeOrchestrationObjective(orchestratorPrompt) || orchestratorPrompt;

      const workersIn = Array.isArray(body?.workers) ? body.workers : [];
      if (!workersIn.length) return reply.code(400).send({ ok: false, error: "missing_workers" });
      if (workersIn.length > 12) return reply.code(400).send({ ok: false, error: "too_many_workers", max: 12 });

      const autoWorktrees = body?.autoWorktrees !== false;
      const lockWorktrees = body?.lockWorktrees !== false;
      const baseRefDefault = toNonEmpty(body?.baseRef) || "HEAD";
      const branchPrefix = toNonEmpty(body?.branchPrefix) || `fyp/orch-${nanoid(8)}`;
      const worktreeRootRaw = toNonEmpty(body?.worktreeRoot);
      const dispatchModeRaw = toNonEmpty(body?.dispatchMode || body?.harness?.dispatchMode);
      const dispatchMode = dispatchModeRaw === "worker-first" ? "worker-first" : "orchestrator-first";
      const useDefaultHarnessPrompts = body?.harness?.useDefaultPrompts !== false;
      const commandCatalog = defaultCommandCatalog();
      const orchestratorSystemPromptOverride = toNonEmpty(body?.orchestratorSystemPrompt || body?.harness?.orchestratorSystemPrompt);
      const automationPolicy = normalizeOrchestrationAutomationPolicy(body?.automation ?? {});
      const orchestrationId = nanoid(12);
      const emitCreateProgress = (step: string, message: string, extra?: Record<string, any>) => {
        broadcastGlobal({
          type: "orchestration.create.progress",
          orchestrationId,
          step,
          message,
          ts: Date.now(),
          ...(extra ?? {}),
        });
      };
      emitCreateProgress("planning", "Planning orchestration blueprint.");

      const createdSessionIds: string[] = [];
      const createdWorktrees: Array<{ repoPath: string; worktreePath: string }> = [];
      let orchestrationRecordCreated = false;
      let orchestrationTaskId: string | null = null;
      let orchestratorSessionIdCreated: string | null = null;
      const gitResolveCache = new Map<string, Awaited<ReturnType<typeof resolveGitForPath>>>();

      const resolveGitCached = async (cwd: string) => {
        const k = path.resolve(cwd);
        const cached = gitResolveCache.get(k);
        if (cached?.ok) return cached;

        // Transient git resolution failures can happen under process churn.
        // Retry once and only cache successful resolutions so one miss doesn't
        // disable worktree isolation for every worker in the orchestration.
        let r = await resolveGitForPath(k);
        if (!r.ok) {
          await new Promise((resolve) => setTimeout(resolve, 45));
          r = await resolveGitForPath(k);
        }
        if (r.ok) gitResolveCache.set(k, r);
        return r;
      };

      try {
      type WorkerCreate = {
        workerIndex: number;
        name: string;
        role: WorkerRoleKey;
        tool: ToolId;
        profileId: string;
        systemPrompt: string;
        sessionId: string;
        projectPath: string;
        worktreePath: string | null;
        branch: string | null;
        baseRef: string | null;
        taskPrompt: string;
      };
      const workerRows: WorkerCreate[] = [];
      const deferredWorkerDispatch: Array<{ sessionId: string; taskPrompt: string; name: string }> = [];

      for (let i = 0; i < workersIn.length; i++) {
        emitCreateProgress("spawning_workers", `Creating worker ${i + 1}/${workersIn.length}.`, { workerIndex: i + 1, workerTotal: workersIn.length });
        const w = workersIn[i] ?? {};
        const workerName = toNonEmpty(w?.name) || `worker-${i + 1}`;
        const rawTaskPrompt = toNonEmpty(w?.taskPrompt) || toNonEmpty(w?.prompt);
        if (!rawTaskPrompt) return reply.code(400).send({ ok: false, error: "missing_worker_prompt", worker: workerName, index: i });
        const taskPrompt = ensureWorkerTaskIncludesObjective(rawTaskPrompt, orchestrationObjective);

        const workerTool = toToolId(w?.tool, defaultTool);
        const workerProfileId = toNonEmpty(w?.profileId) || `${workerTool}.default`;
        const workerRole = inferWorkerRole({
          role: toNonEmpty(w?.role),
          name: workerName,
          taskPrompt,
          profileId: workerProfileId,
        });
        const workerSystemPrompt = toNonEmpty(w?.systemPrompt) || buildWorkerSystemPrompt(workerRole);
        const workerProjectRaw = toNonEmpty(w?.projectPath) || projectPath;
        const vWorkerProject = validateCwd(workerProjectRaw, roots);
        if (!vWorkerProject.ok) {
          return reply.code(400).send({ ok: false, error: "bad_worker_projectPath", worker: workerName, reason: vWorkerProject.reason });
        }
        const workerProjectPath = vWorkerProject.cwd;
        let workerCwd = workerProjectPath;
        let workerWorktreePath: string | null = null;
        let workerBranch: string | null = null;
        let workerBaseRef: string | null = null;

        const isolated = typeof w?.isolated === "boolean" ? w.isolated : autoWorktrees;
        if (isolated) {
          const gitInfo = await resolveGitCached(workerProjectPath);
          if (gitInfo.ok) {
            const baseRef = toNonEmpty(w?.baseRef) || baseRefDefault;
            const branch = toNonEmpty(w?.branch) || `${branchPrefix}/${i + 1}-${branchSlug(workerName)}`;
            const explicitWorktree = toNonEmpty(w?.worktreePath);
            const generatedBase = (() => {
              if (worktreeRootRaw) return path.resolve(worktreeRootRaw);
              const workspaceBase = path.dirname(gitInfo.workspaceRoot);
              const repoSlug = branchSlug(path.basename(gitInfo.workspaceRoot));
              return path.join(workspaceBase, `.fyp-worktrees-${repoSlug}`);
            })();
            const worktreePath = explicitWorktree
              ? path.resolve(explicitWorktree)
              : path.join(generatedBase, orchestrationId, `${i + 1}-${branchSlug(workerName)}`);
            const normRoots = normalizeRoots(roots);
            if (normRoots.length > 0 && !normRoots.some((r) => isUnderRoot(worktreePath, r))) {
              return reply.code(400).send({
                ok: false,
                error: "bad_worktree_path",
                worker: workerName,
                path: worktreePath,
                reason: "worktree path is outside allowed roots",
                hint: "Set `worktreeRoot` inside your configured workspace roots or expand `workspaces.roots` in config.toml.",
              });
            }
            try {
              fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
            } catch {
              // ignore; validateCwd below will surface a useful error
            }
            const parentDir = path.dirname(worktreePath);
            const vvParent = validateCwd(parentDir, roots);
            if (!vvParent.ok) {
              return reply.code(400).send({
                ok: false,
                error: "bad_worktree_path",
                worker: workerName,
                path: worktreePath,
                reason: vvParent.reason,
                hint: "Set `worktreeRoot` inside your configured workspace roots or expand `workspaces.roots` in config.toml.",
              });
            }

            const wt = await createGitWorktree({
              repoPath: gitInfo.workspaceRoot,
              worktreePath,
              branch,
              baseRef,
              lock: lockWorktrees,
              lockReason: `fromyourphone orchestration ${orchestrationId} (${workerName})`,
            });
            if (!wt.ok) {
              return reply.code(400).send({
                ok: false,
                error: "worktree_create_failed",
                worker: workerName,
                reason: wt.reason,
                message: wt.message,
              });
            }
            createdWorktrees.push({ repoPath: wt.repoPath, worktreePath: wt.worktreePath });
            workerCwd = wt.worktreePath;
            workerWorktreePath = wt.worktreePath;
            workerBranch = wt.branch;
            workerBaseRef = baseRef;
          } else if (toNonEmpty(w?.branch)) {
            return reply.code(400).send({
              ok: false,
              error: "worker_branch_requires_git_repo",
              worker: workerName,
              projectPath: workerProjectPath,
            });
          }
        }

        const sessionId = await createSessionDirect({
          tool: workerTool,
          profileId: workerProfileId,
          cwd: workerCwd,
          overrides: w?.overrides ?? {},
        });
        createdSessionIds.push(sessionId);
        deferredWorkerDispatch.push({ sessionId, taskPrompt, name: workerName });

        workerRows.push({
          workerIndex: i,
          name: workerName,
          role: workerRole,
          tool: workerTool,
          profileId: workerProfileId,
          systemPrompt: workerSystemPrompt,
          sessionId,
          projectPath: workerProjectPath,
          worktreePath: workerWorktreePath,
          branch: workerBranch,
          baseRef: workerBaseRef,
          taskPrompt,
        });
      }

      emitCreateProgress("spawning_orchestrator", "Creating orchestrator session.");
      const orchestratorSessionId = await createSessionDirect({
        tool: orchestratorTool,
        profileId: orchestratorProfileId,
        cwd: projectPath,
        overrides: orchestratorRaw?.overrides ?? body?.orchestratorOverrides ?? {},
        extraEnv: {
          FYP_API_BASE_URL: hookBaseUrl.replace(/\/$/, ""),
          FYP_API_TOKEN: cfg.token,
          FYP_ORCHESTRATION_ID: orchestrationId,
        },
      });
      orchestratorSessionIdCreated = orchestratorSessionId;
      createdSessionIds.push(orchestratorSessionId);

      emitCreateProgress("docs", "Writing orchestration docs scaffold (.agents + .fyp).");
      const docsScaffold = scaffoldOrchestrationDocs({
        orchestrationId,
        orchestrationName: name,
        objective: orchestrationObjective,
        dispatchMode,
        orchestratorSessionId,
        orchestratorTool,
        orchestratorProfileId,
        projectPath,
        workers: workerRows.map((w) => ({
          workerIndex: w.workerIndex,
          name: w.name,
          role: w.role,
          sessionId: w.sessionId,
          tool: w.tool,
          profileId: w.profileId,
          projectPath: w.projectPath,
          worktreePath: w.worktreePath,
          branch: w.branch,
          taskPrompt: w.taskPrompt,
          systemPrompt: w.systemPrompt,
        })),
      });
      if (docsScaffold.errors.length > 0) {
        const first = docsScaffold.errors[0];
        throw new Error(`agents_docs_write_failed:${first?.file ?? "unknown"}:${first?.message ?? "write_failed"}`);
      }

      emitCreateProgress("startup", "Waiting for session startup sequence.");
      await Promise.all([orchestratorSessionId, ...workerRows.map((w) => w.sessionId)].map((sid) => waitForSessionReady(sid)));

      const workerSummary = workerRows
        .map((w, i) => {
          const bits = [
            `- Worker ${i + 1}: ${w.name}`,
            `  role: ${w.role}`,
            `  sessionId: ${w.sessionId}`,
            `  tool/profile: ${w.tool} / ${w.profileId}`,
            `  project: ${w.projectPath}`,
          ];
          if (w.worktreePath) bits.push(`  worktree: ${w.worktreePath}`);
          if (w.branch) bits.push(`  branch: ${w.branch}`);
          bits.push(`  task: ${w.taskPrompt}`);
          return bits.join("\n");
        })
        .join("\n");
      const runtimeOrchestratorPrompt =
        orchestratorSystemPromptOverride ||
        (useDefaultHarnessPrompts
          ? buildOrchestratorSystemPrompt({
              objective: orchestrationObjective,
              workers: workerRows.map((w) => ({
            name: w.name,
            role: w.role,
            sessionId: w.sessionId,
            tool: w.tool,
            profileId: w.profileId,
            taskPrompt: w.taskPrompt,
            systemPrompt: w.systemPrompt,
          })),
          commandCatalog,
          dispatchMode,
        })
          : "");

      const sampleWorker = workerRows[0] ?? null;
      const sampleWorkerName = sampleWorker ? String(sampleWorker.name) : "worker-1";
      const sampleWorkerSession = sampleWorker ? String(sampleWorker.sessionId) : "<session-id>";
      const dispatchExamples =
        `Check orchestration status:\n` +
        `curl -sS "$FYP_API_BASE_URL/api/orchestrations/$FYP_ORCHESTRATION_ID" ` +
        `-H "Authorization: Bearer $FYP_API_TOKEN"\n\n` +
        `Fast dispatch without curl (emit this exact line in your own response):\n` +
        `FYP_DISPATCH_JSON: {"target":"all","text":"<prompt>"}\n` +
        `FYP_DISPATCH_JSON: {"target":${JSON.stringify(`worker:${sampleWorkerName}`)},"text":"<prompt>"}\n\n` +
        `Known worker targets:\n` +
        workerRows
          .map((w) => `- #${w.workerIndex + 1}: ${w.name} (session:${w.sessionId})`)
          .join("\n") +
        `\n\n` +
        `Dispatch a prompt to all workers:\n` +
        `curl -sS -X POST "$FYP_API_BASE_URL/api/orchestrations/$FYP_ORCHESTRATION_ID/dispatch" ` +
        `-H "Authorization: Bearer $FYP_API_TOKEN" -H "content-type: application/json" ` +
        `-d '{"target":"all","text":"<prompt>"}'\n\n` +
        `Dispatch by worker index:\n` +
        `curl -sS -X POST "$FYP_API_BASE_URL/api/orchestrations/$FYP_ORCHESTRATION_ID/dispatch" ` +
        `-H "Authorization: Bearer $FYP_API_TOKEN" -H "content-type: application/json" ` +
        `-d '{"target":"1","text":"<prompt>"}'\n\n` +
        `Dispatch to a specific worker by name (exact, slug, or normalized):\n` +
        `curl -sS -X POST "$FYP_API_BASE_URL/api/orchestrations/$FYP_ORCHESTRATION_ID/dispatch" ` +
        `-H "Authorization: Bearer $FYP_API_TOKEN" -H "content-type: application/json" ` +
        `-d '{"target":${JSON.stringify(`worker:${sampleWorkerName}`)},"text":"<prompt>"}'\n\n` +
        `Dispatch to a specific worker by session id:\n` +
        `curl -sS -X POST "$FYP_API_BASE_URL/api/orchestrations/$FYP_ORCHESTRATION_ID/dispatch" ` +
        `-H "Authorization: Bearer $FYP_API_TOKEN" -H "content-type: application/json" ` +
        `-d '{"target":"session:${sampleWorkerSession}","text":"<prompt>"}'\n\n` +
        `Send task tool endpoint (bootstrap-aware):\n` +
        `curl -sS -X POST "$FYP_API_BASE_URL/api/orchestrations/$FYP_ORCHESTRATION_ID/send-task" ` +
        `-H "Authorization: Bearer $FYP_API_TOKEN" -H "content-type: application/json" ` +
        `-d '{"target":${JSON.stringify(`worker:${sampleWorkerName}`)},"task":"<task prompt>","initialize":true,"interrupt":false,"forceInterrupt":false}'\n\n` +
        `Fast send-task directive from orchestrator output:\n` +
        `FYP_SEND_TASK_JSON: {"target":${JSON.stringify(`worker:${sampleWorkerName}`)},"task":"<task prompt>","initialize":true,"interrupt":false,"forceInterrupt":false}\n\n` +
        `Fast answer-question directive from orchestrator output:\n` +
        `FYP_ANSWER_QUESTION_JSON: {"attentionId":123,"optionId":"1","source":"orchestrator-auto"}\n\n` +
        `List pending approvals (inbox):\n` +
        `curl -sS "$FYP_API_BASE_URL/api/inbox?status=open&limit=80" ` +
        `-H "Authorization: Bearer $FYP_API_TOKEN"\n\n` +
        `Respond to an approval:\n` +
        `curl -sS -X POST "$FYP_API_BASE_URL/api/inbox/<attentionId>/respond" ` +
        `-H "Authorization: Bearer $FYP_API_TOKEN" -H "content-type: application/json" ` +
        `-d '{"optionId":"approve"}'\n\n` +
        `Dismiss an inbox item:\n` +
        `curl -sS -X POST "$FYP_API_BASE_URL/api/inbox/<attentionId>/dismiss" ` +
        `-H "Authorization: Bearer $FYP_API_TOKEN" -H "content-type: application/json" ` +
        `-d '{"meta":{"source":"orchestrator"}}'\n\n` +
        `Direct worker message fallback (session route):\n` +
        `curl -sS -X POST "$FYP_API_BASE_URL/api/sessions/${sampleWorkerSession}/input" ` +
        `-H "Authorization: Bearer $FYP_API_TOKEN" -H "content-type: application/json" ` +
        `-d '{"text":"<prompt>\\r"}'\n\n` +
        `Read worker session events:\n` +
        `curl -sS "$FYP_API_BASE_URL/api/sessions/${sampleWorkerSession}/events?limit=80" ` +
        `-H "Authorization: Bearer $FYP_API_TOKEN"`;

      const orchestratorContext = buildOrchestratorStartupPrompt({
        runtimeSystemPrompt: runtimeOrchestratorPrompt,
        orchestrationId,
        orchestrationName: name,
        objective: orchestrationObjective,
        projectPath,
        orchestratorTool,
        orchestratorProfileId,
        dispatchMode,
        workerSummary,
        dispatchExamples,
      });
      const orchestratorKickoff = [
        "USER OBJECTIVE KICKOFF",
        orchestrationObjective,
        "",
        dispatchMode === "orchestrator-first"
          ? "FIRST ACTION: Dispatch initial worker prompts now (or verify auto-dispatch receipts) and continue orchestration."
          : "FIRST ACTION: Verify workers started and continue orchestration review.",
      ].join("\n");
      const workerBootstraps = workerRows.map((w) => ({
        sessionId: w.sessionId,
        workerIndex: w.workerIndex,
        workerName: w.name,
        workerRole: w.role,
        workerProfileId: w.profileId,
        workerSystemPrompt: w.systemPrompt,
        rootPath: toNonEmpty(w.worktreePath) || toNonEmpty(w.projectPath) || projectPath,
        bootstrap: buildWorkerStartupPrompt({
          orchestrationId,
          orchestrationName: name,
          objective: orchestrationObjective,
          orchestratorSessionId,
          workerName: w.name,
          workerRole: w.role,
          workerProfileId: w.profileId,
          workerIndex: w.workerIndex,
          workerCount: workerRows.length,
          dispatchMode,
          workerSystemPrompt: w.systemPrompt,
          taskPrompt: w.taskPrompt,
          taskStartsNow: dispatchMode === "worker-first",
        }),
      }));
      const runtimeDocs = persistRuntimeBootstrapDocs({
        orchestrationId,
        projectPath,
        orchestratorBootstrap: orchestratorContext,
        workers: workerBootstraps.map((w) => ({
          workerIndex: w.workerIndex,
          workerName: w.workerName,
          workerRole: w.workerRole,
          workerProfileId: w.workerProfileId,
          workerSystemPrompt: w.workerSystemPrompt,
          rootPath: w.rootPath,
          bootstrap: w.bootstrap,
        })),
      });
      if (runtimeDocs.errors.length > 0) {
        const first = runtimeDocs.errors[0];
        throw new Error(`runtime_bootstrap_docs_write_failed:${first?.file ?? "unknown"}:${first?.message ?? "write_failed"}`);
      }
      const autoDispatchInitialPrompts =
        dispatchMode === "orchestrator-first" &&
        (typeof body?.autoDispatchInitialPrompts === "boolean" ? Boolean(body.autoDispatchInitialPrompts) : true);
      const pendingInitialDispatch =
        dispatchMode === "orchestrator-first" && !autoDispatchInitialPrompts
          ? deferredWorkerDispatch.map((w) => w.sessionId)
          : [];

      // Important ordering: persist orchestration before sending bootstrap input to the
      // orchestrator so early FYP_DISPATCH_JSON lines can be resolved/routed immediately.
      store.createOrchestration({
        id: orchestrationId,
        name,
        projectPath,
        orchestratorSessionId,
        workers: workerRows,
      });
      orchestrationRecordCreated = true;
      const taskId = ensureTaskForOrchestration({
        orchestrationId,
        name,
        orchestratorSessionId,
        workers: workerRows.map((w) => ({ sessionId: w.sessionId, name: w.name, workerIndex: w.workerIndex })),
      });
      orchestrationTaskId = taskId;
      store.pruneOrphanTasks();
      ensureOrchestrationSyncState(orchestrationId);
      const autoState = ensureOrchestrationAutomationState(orchestrationId);
      autoState.policy = normalizeOrchestrationAutomationPolicy(automationPolicy, autoState.policy);
      store.appendEvent(orchestratorSessionId, "orchestration.created", {
        orchestrationId,
        name,
        projectPath,
        workerSessionIds: workerRows.map((w) => w.sessionId),
        dispatchMode,
        deferredInitialDispatch: pendingInitialDispatch,
        automation: { ...autoState.policy },
        docs: {
          scaffoldWritten: docsScaffold.written.length,
          scaffoldSkipped: docsScaffold.skipped.length,
          runtimeWritten: runtimeDocs.written.length,
          runtimeSkipped: runtimeDocs.skipped.length,
        },
      });

      await waitForSessionWarmup(orchestratorSessionId, {
        settleMs: 360,
        previewProbeMs: 9000,
        requireInteractive: true,
      });
      await sendInputDirect(orchestratorSessionId, normalizePromptInput(orchestratorContext));
      // Recovery: if startup input lands too early for a specific CLI initialization sequence,
      // inject the same bootstrap once alongside the first user message for this orchestrator.
      firstUserBootstrapFallback.set(orchestratorSessionId, {
        text: [orchestratorContext, "", orchestratorKickoff].join("\n"),
        queuedAt: Date.now(),
        forceOnFirstInput: true,
        kickoffLabel: "USER KICKOFF MESSAGE",
      });
      scheduleBootstrapFallbackRetry(orchestratorSessionId);
      await sendInputDirect(orchestratorSessionId, normalizePromptInput(orchestratorKickoff));

      emitCreateProgress("startup", "Sending worker bootstrap prompts.");
      await Promise.all(
        workerBootstraps.map(async (w) => {
          await waitForSessionWarmup(w.sessionId, {
            settleMs: 260,
            previewProbeMs: 9000,
            requireInteractive: true,
          });
          await sendInputDirect(w.sessionId, normalizePromptInput(w.bootstrap));
          firstUserBootstrapFallback.set(w.sessionId, {
            text: w.bootstrap,
            queuedAt: Date.now(),
            forceOnFirstInput: true,
            kickoffLabel: "ORCHESTRATOR DISPATCH MESSAGE",
          });
          scheduleBootstrapFallbackRetry(w.sessionId);
        }),
      );

      if (autoDispatchInitialPrompts) {
        emitCreateProgress("dispatching", "Auto-dispatching initial worker prompts.");
        const maxAttempts = 4;
        const retryDelayMs = (attempt: number): number => {
          if (attempt <= 2) return 1400;
          if (attempt === 3) return 3200;
          return 7000;
        };
        const tryAutoDispatchAttempt = async (
          recNow: { orchestration: any; workers: any[] } | null,
          items: Array<{ sessionId: string; taskPrompt: string; name: string }>,
          attempt: number,
        ): Promise<Array<{ sessionId: string; taskPrompt: string; name: string }>> => {
          if (!recNow) return items.slice();
          const retryLater: Array<{ sessionId: string; taskPrompt: string; name: string }> = [];
          for (const it of items) {
            const run = await dispatchOrchestrationText(orchestrationId, recNow, {
              text: `ORCHESTRATOR RELEASE (auto-dispatch attempt ${attempt})\n${it.taskPrompt}`,
              targetRaw: `session:${it.sessionId}`,
              interrupt: false,
              source: `startup.auto_dispatch.attempt_${attempt}`,
              kickoffLabel: "ORCHESTRATOR DISPATCH MESSAGE",
            });
            if (run.failed.length > 0) retryLater.push(it);
          }
          return retryLater;
        };
        const scheduleAutoDispatchRetry = (
          items: Array<{ sessionId: string; taskPrompt: string; name: string }>,
          attempt: number,
        ) => {
          if (!items.length || attempt > maxAttempts) return;
          const tm = setTimeout(() => {
            let recRetry: { orchestration: any; workers: any[] } | null = null;
            try {
              recRetry = store.getOrchestration(orchestrationId);
            } catch {
              recRetry = null;
            }
            if (!recRetry) return;
            void (async () => {
              const stillPending = await tryAutoDispatchAttempt(recRetry, items, attempt);
              if (stillPending.length > 0 && attempt < maxAttempts) {
                scheduleAutoDispatchRetry(stillPending, attempt + 1);
                return;
              }
              if (stillPending.length > 0) {
                emitCreateProgress("dispatch_warning", "Some workers did not receive first release; orchestrator should resend manually.", {
                  failedWorkers: stillPending.map((w) => w.name),
                  attempt,
                });
              }
            })().catch(() => undefined);
          }, retryDelayMs(attempt));
          tm.unref?.();
        };

        const recNow = store.getOrchestration(orchestrationId);
        const retryLater = await tryAutoDispatchAttempt(recNow, deferredWorkerDispatch, 1);
        if (retryLater.length > 0) scheduleAutoDispatchRetry(retryLater, 2);
      } else if (dispatchMode === "orchestrator-first") {
        const quickstart = [
          "ORCHESTRATOR QUICKSTART",
          "Send one dispatch line now to release workers.",
          'FYP_DISPATCH_JSON: {"target":"all","text":"<prompt>"}',
        ].join("\n");
        try {
          await sendInputDirect(orchestratorSessionId, normalizePromptInput(quickstart));
        } catch {
          // ignore
        }
      }

      broadcastGlobal({ type: "sessions.changed" });
      broadcastGlobal({ type: "workspaces.changed" });
      broadcastGlobal({ type: "orchestrations.changed" });
      broadcastGlobal({ type: "tasks.changed" });
      emitCreateProgress("running", "Orchestration is running.", {
        orchestratorSessionId,
        workerCount: workerRows.length,
      });

        return {
        ok: true,
        id: orchestrationId,
        taskId,
        name,
        projectPath,
        orchestratorSessionId,
        dispatchMode,
        autoDispatchInitialPrompts,
        automation: { ...autoState.policy },
        agentsDocs: {
          scaffold: { written: docsScaffold.written.length, skipped: docsScaffold.skipped.length },
          runtime: { written: runtimeDocs.written.length, skipped: runtimeDocs.skipped.length },
        },
        workers: workerRows.map((w) => ({
          name: w.name,
          role: w.role,
          sessionId: w.sessionId,
          projectPath: w.projectPath,
          worktreePath: w.worktreePath,
          branch: w.branch,
          baseRef: w.baseRef,
        })),
        };
      } catch (e: any) {
        emitCreateProgress("error", "Orchestration creation failed.", {
          error: typeof e?.message === "string" ? e.message : "orchestration_failed",
        });
        // Best effort rollback.
        if (orchestrationRecordCreated) {
          try {
            if (orchestrationTaskId && store.getTask(orchestrationTaskId)) store.deleteTask(orchestrationTaskId);
          } catch {
            // ignore
          }
          try {
            store.deleteOrchestration(orchestrationId);
          } catch {
            // ignore
          }
          orchestrationSyncState.delete(orchestrationId);
          orchestrationAutomationState.delete(orchestrationId);
          if (orchestratorSessionIdCreated) orchestrationDispatchEvidenceCache.delete(orchestratorSessionIdCreated);
        }
        for (const sid of createdSessionIds.slice().reverse()) {
          try {
            await deleteSessionDirect(sid);
          } catch {
            // ignore
          }
        }
        for (const wt of createdWorktrees.slice().reverse()) {
          try {
            await removeGitWorktreeRobust({ repoPath: wt.repoPath, worktreePath: wt.worktreePath, force: true });
          } catch {
            // ignore
          }
        }
        const message = typeof e?.message === "string" ? e.message : "orchestration_failed";
        return reply.code(400).send({ ok: false, error: "orchestration_failed", message });
      }
    } finally {
      releaseOrchestrationLock(createLockId, createLockOwner);
    }
  });

  // Tool-native session discovery (Codex + Claude + OpenCode).
  // This powers chat-history rendering and lets the phone UI resume/fork sessions created outside FYP.
  const opencodeToolSessionsCache = new Map<string, { ts: number; items: ToolSessionSummary[] }>();
  const orchestrationLocks = new Map<string, { op: string; owner: string; startedAt: number }>();
  type OrchestrationSyncMode = "off" | "manual" | "interval";
  type OrchestrationSyncPolicy = {
    mode: OrchestrationSyncMode;
    intervalMs: number;
    deliverToOrchestrator: boolean;
    minDeliveryGapMs: number;
  };
  type OrchestrationSyncState = {
    policy: OrchestrationSyncPolicy;
    inFlight: boolean;
    lastDigestAt: number | null;
    lastDeliveredAt: number | null;
    lastDigestHash: string | null;
    lastChangedWorkerCount: number;
    lastReason: string | null;
    lastError: string | null;
    lastRunAt: number | null;
    workerSnapshots: Record<string, OrchestrationWorkerSnapshot>;
  };
  type OrchestrationSyncDigest = ReturnType<typeof buildOrchestrationDigestModel>;
  const orchestrationSyncState = new Map<string, OrchestrationSyncState>();
  const orchestrationDispatchEvidenceCache = new Map<
    string,
    { latestEventId: number; sentSessionIds: Set<string> }
  >();
  type OrchestrationQuestionMode = "off" | "orchestrator";
  type OrchestrationSteeringMode = "off" | "passive_review" | "active_steering";
  type OrchestrationAutomationPolicy = {
    questionMode: OrchestrationQuestionMode;
    steeringMode: OrchestrationSteeringMode;
    questionTimeoutMs: number;
    yoloMode: boolean;
    reviewIntervalMs: number;
  };
  type OrchestrationAutomationState = {
    policy: OrchestrationAutomationPolicy;
    inFlightReview: boolean;
    lastReviewAt: number | null;
    lastQuestionDispatchAt: number | null;
    lastError: string | null;
    pendingAttentionIds: number[];
    questionDispatchCount: number;
    reviewCount: number;
  };
  const orchestrationAutomationState = new Map<string, OrchestrationAutomationState>();
  const orchestrationQuestionBatchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const orchestrationQuestionTimeoutTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const orchestrationWorkerSignalTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const orchestrationWorkerSignalLastSentAt = new Map<string, number>();
  const orchestrationWorkerDoneLatch = new Map<string, { at: number; reason: string }>();
  const ORCH_SYNC_MIN_INTERVAL_MS = 15_000;
  const ORCH_SYNC_MAX_INTERVAL_MS = 30 * 60 * 1000;
  const ORCH_SYNC_MIN_DELIVERY_GAP_MS = 10_000;
  const ORCH_SYNC_MAX_DELIVERY_GAP_MS = 10 * 60 * 1000;
  const ORCH_AUTOMATION_MIN_REVIEW_MS = 30_000;
  const ORCH_AUTOMATION_MAX_REVIEW_MS = 30 * 60 * 1000;
  const ORCH_AUTOMATION_MIN_TIMEOUT_MS = 30_000;
  const ORCH_AUTOMATION_MAX_TIMEOUT_MS = 20 * 60 * 1000;
  const ORCH_WORKER_SIGNAL_DEFAULT_GAP_MS = 15_000;
  const ORCH_WORKER_STALE_MS = 60_000;
  const ORCH_WORKER_STALE_SIGNAL_GAP_MS = 90_000;

  function orchestrationWorkerDoneLatchKey(orchestrationId: string, sessionId: string): string {
    return `${String(orchestrationId)}|${String(sessionId)}`;
  }

  function markWorkerDoneLatch(orchestrationId: string, sessionId: string, reason: string): void {
    orchestrationWorkerDoneLatch.set(orchestrationWorkerDoneLatchKey(orchestrationId, sessionId), {
      at: Date.now(),
      reason: String(reason || "done"),
    });
  }

  function clearWorkerDoneLatch(orchestrationId: string, sessionId: string): boolean {
    return orchestrationWorkerDoneLatch.delete(orchestrationWorkerDoneLatchKey(orchestrationId, sessionId));
  }

  function hasWorkerDoneLatch(orchestrationId: string, sessionId: string): boolean {
    return orchestrationWorkerDoneLatch.has(orchestrationWorkerDoneLatchKey(orchestrationId, sessionId));
  }

  function normalizeOrchestrationSyncInterval(raw: any, fallback = 120_000): number {
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(ORCH_SYNC_MAX_INTERVAL_MS, Math.max(ORCH_SYNC_MIN_INTERVAL_MS, n));
  }

  function normalizeOrchestrationDeliveryGap(raw: any, fallback = 45_000): number {
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(ORCH_SYNC_MAX_DELIVERY_GAP_MS, Math.max(ORCH_SYNC_MIN_DELIVERY_GAP_MS, n));
  }

  function defaultOrchestrationSyncPolicy(): OrchestrationSyncPolicy {
    return {
      mode: "manual",
      intervalMs: 120_000,
      // The user can still switch to collect-only mode. Default keeps explicit sync useful.
      deliverToOrchestrator: true,
      // Auto-sync should not spam the coordinator while workers are active.
      minDeliveryGapMs: 45_000,
    };
  }

  function ensureOrchestrationSyncState(id: string): OrchestrationSyncState {
    const cur = orchestrationSyncState.get(id);
    if (cur) return cur;
    const next: OrchestrationSyncState = {
      policy: defaultOrchestrationSyncPolicy(),
      inFlight: false,
      lastDigestAt: null,
      lastDeliveredAt: null,
      lastDigestHash: null,
      lastChangedWorkerCount: 0,
      lastReason: null,
      lastError: null,
      lastRunAt: null,
      workerSnapshots: {},
    };
    orchestrationSyncState.set(id, next);
    return next;
  }

  function orchestrationSyncView(id: string) {
    const cur = orchestrationSyncState.get(id);
    const policy = cur?.policy ?? defaultOrchestrationSyncPolicy();
    return {
      policy: { ...policy },
      inFlight: cur?.inFlight ?? false,
      lastDigestAt: cur?.lastDigestAt ?? null,
      lastDeliveredAt: cur?.lastDeliveredAt ?? null,
      lastDigestHash: cur?.lastDigestHash ?? null,
      lastChangedWorkerCount: cur?.lastChangedWorkerCount ?? 0,
      lastReason: cur?.lastReason ?? null,
      lastError: cur?.lastError ?? null,
      lastRunAt: cur?.lastRunAt ?? null,
    };
  }

  function normalizeAutomationReviewInterval(raw: any, fallback = 180_000): number {
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(ORCH_AUTOMATION_MAX_REVIEW_MS, Math.max(ORCH_AUTOMATION_MIN_REVIEW_MS, n));
  }

  function normalizeAutomationTimeout(raw: any, fallback = 120_000): number {
    const n = Math.floor(Number(raw));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(ORCH_AUTOMATION_MAX_TIMEOUT_MS, Math.max(ORCH_AUTOMATION_MIN_TIMEOUT_MS, n));
  }

  function defaultOrchestrationAutomationPolicy(): OrchestrationAutomationPolicy {
    return {
      questionMode: "off",
      steeringMode: "off",
      questionTimeoutMs: 120_000,
      yoloMode: false,
      reviewIntervalMs: 180_000,
    };
  }

  function ensureOrchestrationAutomationState(id: string): OrchestrationAutomationState {
    const cur = orchestrationAutomationState.get(id);
    if (cur) return cur;
    const next: OrchestrationAutomationState = {
      policy: defaultOrchestrationAutomationPolicy(),
      inFlightReview: false,
      lastReviewAt: null,
      lastQuestionDispatchAt: null,
      lastError: null,
      pendingAttentionIds: [],
      questionDispatchCount: 0,
      reviewCount: 0,
    };
    orchestrationAutomationState.set(id, next);
    return next;
  }

  function normalizeOrchestrationAutomationPolicy(raw: any, fallback?: OrchestrationAutomationPolicy): OrchestrationAutomationPolicy {
    const base = fallback ? { ...fallback } : defaultOrchestrationAutomationPolicy();
    const q = toNonEmpty(raw?.questionMode).toLowerCase();
    const s = toNonEmpty(raw?.steeringMode).toLowerCase();
    if (q === "off" || q === "orchestrator") base.questionMode = q as OrchestrationQuestionMode;
    if (s === "off" || s === "passive_review" || s === "active_steering") base.steeringMode = s as OrchestrationSteeringMode;
    if (raw?.questionTimeoutMs != null) base.questionTimeoutMs = normalizeAutomationTimeout(raw.questionTimeoutMs, base.questionTimeoutMs);
    if (raw?.reviewIntervalMs != null) base.reviewIntervalMs = normalizeAutomationReviewInterval(raw.reviewIntervalMs, base.reviewIntervalMs);
    if (raw?.yoloMode != null) base.yoloMode = Boolean(raw.yoloMode);
    return base;
  }

  function orchestrationAutomationView(id: string) {
    const st = orchestrationAutomationState.get(id);
    const policy = st?.policy ?? defaultOrchestrationAutomationPolicy();
    return {
      policy: { ...policy },
      inFlightReview: st?.inFlightReview ?? false,
      lastReviewAt: st?.lastReviewAt ?? null,
      lastQuestionDispatchAt: st?.lastQuestionDispatchAt ?? null,
      pendingQuestionCount: st?.pendingAttentionIds?.length ?? 0,
      questionDispatchCount: st?.questionDispatchCount ?? 0,
      reviewCount: st?.reviewCount ?? 0,
      lastError: st?.lastError ?? null,
    };
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function orchLockKey(id: string): string {
    return `orch:${id}`;
  }

  function tryAcquireOrchestrationLock(id: string, op: string): { ok: true; owner: string } | { ok: false; lock: any } {
    const key = orchLockKey(id);
    const now = Date.now();
    const cur = orchestrationLocks.get(key) ?? null;
    const staleMs = 30 * 60 * 1000;
    if (cur && now - cur.startedAt < staleMs) {
      return {
        ok: false,
        lock: {
          operation: cur.op,
          owner: cur.owner,
          startedAt: cur.startedAt,
          ageMs: now - cur.startedAt,
        },
      };
    }
    const owner = nanoid(8);
    orchestrationLocks.set(key, { op, owner, startedAt: now });
    return { ok: true, owner };
  }

  function releaseOrchestrationLock(id: string, owner: string): void {
    const key = orchLockKey(id);
    const cur = orchestrationLocks.get(key);
    if (!cur) return;
    if (cur.owner !== owner) return;
    orchestrationLocks.delete(key);
  }

  function findOrchestrationByOrchestratorSession(
    sessionId: string,
  ): null | { orchestrationId: string; rec: { orchestration: any; workers: any[] } } {
    let rows: Array<{ id: string }> = [];
    try {
      rows = store.listOrchestrations(500);
    } catch {
      return null;
    }
    for (const row of rows) {
      let rec: { orchestration: any; workers: any[] } | null = null;
      try {
        rec = store.getOrchestration(String(row.id));
      } catch {
        rec = null;
      }
      if (!rec) continue;
      if (String(rec.orchestration?.orchestratorSessionId ?? "") === sessionId) {
        return { orchestrationId: String(row.id), rec };
      }
    }
    return null;
  }

  function findOrchestrationByWorkerSession(sessionId: string): null | { orchestrationId: string; rec: { orchestration: any; workers: any[] }; worker: any } {
    let rows: Array<{ id: string }> = [];
    try {
      rows = store.listOrchestrations(500);
    } catch {
      return null;
    }
    for (const row of rows) {
      let rec: { orchestration: any; workers: any[] } | null = null;
      try {
        rec = store.getOrchestration(String(row.id));
      } catch {
        rec = null;
      }
      if (!rec) continue;
      const worker = rec.workers.find((w) => String(w.sessionId) === sessionId);
      if (worker) return { orchestrationId: String(row.id), rec, worker };
    }
    return null;
  }

  function workerSignalKey(orchestrationId: string, sessionId: string, trigger: string): string {
    return `${orchestrationId}|${sessionId}|${trigger}`;
  }

  function queueWorkerAutomationSignal(
    sessionId: string,
    trigger: string,
    opts?: {
      delayMs?: number;
      minGapMs?: number;
      runSync?: boolean;
      runReview?: boolean;
      forceSync?: boolean;
      forceReview?: boolean;
      deliverToOrchestrator?: boolean;
    },
  ) {
    const found = findOrchestrationByWorkerSession(sessionId);
    if (!found) return;
    const orchestrationId = found.orchestrationId;
    const delayMs = Math.max(0, Math.floor(Number(opts?.delayMs ?? 320)));
    const minGapMs = Math.max(0, Math.floor(Number(opts?.minGapMs ?? ORCH_WORKER_SIGNAL_DEFAULT_GAP_MS)));
    const runSync = opts?.runSync !== false;
    const runReview = opts?.runReview !== false;
    const forceSync = opts?.forceSync === true;
    const forceReview = opts?.forceReview === true;
    const deliverToOrchestrator =
      typeof opts?.deliverToOrchestrator === "boolean" ? opts.deliverToOrchestrator : undefined;
    const key = workerSignalKey(orchestrationId, sessionId, trigger);

    const last = orchestrationWorkerSignalLastSentAt.get(key) ?? 0;
    if (Date.now() - last < minGapMs) return;
    if (orchestrationWorkerSignalTimers.has(key)) return;

    const tm = setTimeout(() => {
      orchestrationWorkerSignalTimers.delete(key);
      orchestrationWorkerSignalLastSentAt.set(key, Date.now());
      if (runSync) {
        void runOrchestrationSync(orchestrationId, {
          trigger: `worker.${trigger}`,
          force: forceSync,
          deliverToOrchestrator,
          suppressLockError: true,
        }).catch(() => undefined);
      }
      if (runReview) {
        void runOrchestrationSteeringReview(orchestrationId, {
          trigger: `worker.${trigger}`,
          force: forceReview,
          suppressLockError: true,
        }).catch(() => undefined);
      }
    }, delayMs);
    tm.unref?.();
    orchestrationWorkerSignalTimers.set(key, tm);
  }

  function dispatchFromOrchestratorDirective(
    orchestrationId: string,
    rec: { orchestration: any; workers: any[] },
    directive: ParsedDispatchDirective,
    fallbackSource: string,
  ) {
    return dispatchOrchestrationText(orchestrationId, rec, {
      text: directive.text,
      targetRaw: directive.target,
      interrupt: directive.interrupt,
      forceInterrupt: directive.forceInterrupt,
      includeBootstrapIfPresent: directive.includeBootstrapIfPresent,
      source: directive.source || fallbackSource,
      kickoffLabel: "ORCHESTRATOR DIRECTIVE MESSAGE",
    });
  }

  function submitQuestionAnswerDirective(answer: ParsedQuestionAnswerDirective) {
    return app.inject({
      method: "POST",
      url: `/api/inbox/${encodeURIComponent(String(answer.attentionId))}/respond`,
      headers: {
        authorization: `Bearer ${cfg.token}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({
        optionId: answer.optionId,
        source: answer.source,
        meta: answer.meta,
      }),
    });
  }

  function parseOrchestratorControlDirectivesForSession(sessionId: string, chunk: string) {
    return parseOrchestratorControlDirectives({
      sessionId,
      chunk,
      carryStore: orchestratorDispatchDirectiveCarry,
      recentStore: orchestratorDispatchDirectiveRecent,
      dedupeWindowMs: ORCH_DIRECTIVE_DEDUPE_WINDOW_MS,
      normalizeChunk: (value) => collapseBackspaces(stripAnsi(String(value ?? ""))).replace(/\r\n/g, "\n").replace(/\r/g, "\n"),
    });
  }

  type HarnessCommandExecutionMode =
    | "system.sync"
    | "system.review"
    | "orchestrator.input"
    | "worker.send_task"
    | "worker.dispatch";

  function normalizeStringListInput(v: unknown): string[] {
    if (Array.isArray(v)) return v.map((x) => toNonEmpty(x)).filter(Boolean);
    const one = toNonEmpty(v);
    return one ? [one] : [];
  }

  function normalizePriority(v: unknown, fallback = "HIGH"): "HIGH" | "NORMAL" | "LOW" {
    const t = toNonEmpty(v).toUpperCase();
    if (t === "LOW") return "LOW";
    if (t === "NORMAL" || t === "MEDIUM") return "NORMAL";
    if (t === "HIGH" || t === "CRITICAL" || t === "P0") return "HIGH";
    return fallback === "LOW" || fallback === "NORMAL" ? fallback : "HIGH";
  }

  type ValidatedHarnessCommandInput = {
    target: string;
    task: string;
    rawPrompt: string;
    scope: string[];
    verify: string[];
    notYourJob: string[];
    doneWhen: string[];
    extra: string;
    notes: string;
    priority: "HIGH" | "NORMAL" | "LOW";
    interrupt?: boolean;
    initialize?: boolean;
    includeBootstrap?: boolean;
    runNow?: boolean;
    force?: boolean;
    deliverToOrchestrator?: boolean;
    questionMode?: string;
    steeringMode?: string;
    questionTimeoutMs?: number;
    reviewIntervalMs?: number;
    yoloMode?: boolean;
    idempotencyKey?: string;
  };

  function parseOptionalBoolean(v: unknown): boolean | undefined | null {
    if (typeof v === "undefined") return undefined;
    if (typeof v === "boolean") return v;
    return null;
  }

  function clampList(values: string[], maxItems: number, maxLen: number): string[] {
    const out: string[] = [];
    for (const value of values) {
      const t = String(value ?? "").trim();
      if (!t) continue;
      out.push(t.length > maxLen ? t.slice(0, maxLen) : t);
      if (out.length >= maxItems) break;
    }
    return out;
  }

  function validateHarnessCommandInput(body: any): { ok: true; value: ValidatedHarnessCommandInput } | { ok: false; reason: string } {
    const target = toNonEmpty(body?.target).slice(0, 160);
    const task = toNonEmpty(body?.task || body?.text || body?.objective).slice(0, 5000);
    const rawPrompt = toNonEmpty(body?.rawPrompt).slice(0, 8000);
    const scope = clampList(normalizeStringListInput(body?.scope), 40, 260);
    const verify = clampList(normalizeStringListInput(body?.verify), 40, 260);
    const notYourJob = clampList(normalizeStringListInput(body?.notYourJob), 30, 260);
    const doneWhen = clampList(normalizeStringListInput(body?.doneWhen), 30, 260);
    const extra = toNonEmpty(body?.extra).slice(0, 3000);
    const notes = toNonEmpty(body?.notes).slice(0, 3000);
    const priority = normalizePriority(body?.priority, "NORMAL");
    const idempotencyKey = toNonEmpty(body?.idempotencyKey).slice(0, 180);

    if (body?.target != null && !target) return { ok: false, reason: "invalid target field" };
    if (body?.task != null && !task && !rawPrompt) return { ok: false, reason: "invalid task field" };
    if (body?.rawPrompt != null && !rawPrompt) return { ok: false, reason: "invalid rawPrompt field" };

    const boolFields: Array<keyof Pick<ValidatedHarnessCommandInput, "interrupt" | "initialize" | "includeBootstrap" | "runNow" | "force" | "deliverToOrchestrator" | "yoloMode">> = [
      "interrupt",
      "initialize",
      "includeBootstrap",
      "runNow",
      "force",
      "deliverToOrchestrator",
      "yoloMode",
    ];
    const parsedBools: Partial<ValidatedHarnessCommandInput> = {};
    for (const key of boolFields) {
      const parsed = parseOptionalBoolean(body?.[key]);
      if (parsed === null) return { ok: false, reason: `invalid boolean field: ${key}` };
      if (typeof parsed === "boolean") parsedBools[key] = parsed as any;
    }

    const questionMode = toNonEmpty(body?.questionMode).slice(0, 40);
    const steeringMode = toNonEmpty(body?.steeringMode).slice(0, 40);
    const toMs = (v: unknown): number | undefined | null => {
      if (typeof v === "undefined") return undefined;
      const n = Number(v);
      if (!Number.isFinite(n)) return null;
      return Math.max(0, Math.floor(n));
    };
    const questionTimeoutMs = toMs(body?.questionTimeoutMs);
    if (questionTimeoutMs === null) return { ok: false, reason: "invalid questionTimeoutMs field" };
    const reviewIntervalMs = toMs(body?.reviewIntervalMs);
    if (reviewIntervalMs === null) return { ok: false, reason: "invalid reviewIntervalMs field" };

    return {
      ok: true,
      value: {
        target,
        task,
        rawPrompt,
        scope,
        verify,
        notYourJob,
        doneWhen,
        extra,
        notes,
        priority,
        ...(typeof questionMode === "string" && questionMode ? { questionMode } : {}),
        ...(typeof steeringMode === "string" && steeringMode ? { steeringMode } : {}),
        ...(typeof questionTimeoutMs === "number" ? { questionTimeoutMs } : {}),
        ...(typeof reviewIntervalMs === "number" ? { reviewIntervalMs } : {}),
        ...(typeof idempotencyKey === "string" && idempotencyKey ? { idempotencyKey } : {}),
        ...parsedBools,
      },
    };
  }

  function commandExecutionModeForId(commandId: string): {
    mode: HarnessCommandExecutionMode;
    defaultTarget: string;
    includeBootstrapIfPresent: boolean;
    defaultPriority: "HIGH" | "NORMAL" | "LOW";
  } {
    const syncCommands = new Set(["sync-status"]);
    const reviewCommands = new Set(["review-hard"]);
    const orchestratorCommands = new Set([
      "replan",
      "handoff",
      "release-readiness",
      "incident-drill",
      "communication-audit",
    ]);
    const sendTaskCommands = new Set([
      "diag-evidence",
      "test-tdd",
      "verify-completion",
      "review-request",
      "security-threat-model",
      "threat-model-stride",
      "attack-tree-map",
      "security-vuln-repro",
      "security-requirements",
      "mitigation-map",
      "security-remediation",
      "security-sast",
      "dependency-risk-audit",
      "auth-hardening",
      "error-path-audit",
      "backend-hardening",
      "resilience-chaos-check",
      "data-integrity-audit",
      "perf-regression-lab",
      "perf-budget-gate",
      "contract-audit",
      "contract-drift-check",
      "integration-gate",
      "coord-task",
      "scope-lock",
      "conflict-resolve",
      "ownership-audit",
      "frontend-pass",
      "frontend-mobile-gate",
      "design-parity-matrix",
      "motion-reduced-check",
      "accessibility-hard-check",
      "flake-hunt",
      "rollback-drill",
      "team-launch",
    ]);

    if (syncCommands.has(commandId)) {
      return {
        mode: "system.sync",
        defaultTarget: "all",
        includeBootstrapIfPresent: false,
        defaultPriority: "NORMAL",
      };
    }
    if (reviewCommands.has(commandId)) {
      return {
        mode: "system.review",
        defaultTarget: "all",
        includeBootstrapIfPresent: false,
        defaultPriority: "HIGH",
      };
    }
    if (orchestratorCommands.has(commandId)) {
      return {
        mode: "orchestrator.input",
        defaultTarget: "orchestrator",
        includeBootstrapIfPresent: false,
        defaultPriority: "NORMAL",
      };
    }
    if (sendTaskCommands.has(commandId)) {
      return {
        mode: "worker.send_task",
        defaultTarget: "all",
        includeBootstrapIfPresent: true,
        defaultPriority: "HIGH",
      };
    }
    return {
      mode: "worker.dispatch",
      defaultTarget: "all",
      includeBootstrapIfPresent: false,
      defaultPriority: "NORMAL",
    };
  }

  function buildHarnessCommandWorkerPacket(input: {
    commandId: string;
    command: AgentCommandDef;
    body: any;
    mode: HarnessCommandExecutionMode;
  }): string {
    const task = toNonEmpty(input.body?.task || input.body?.text || input.body?.objective || input.command.summary);
    const scope = normalizeStringListInput(input.body?.scope);
    const notYourJob = normalizeStringListInput(input.body?.notYourJob);
    const doneWhen = normalizeStringListInput(input.body?.doneWhen);
    const verify = normalizeStringListInput(input.body?.verify);
    const priority = normalizePriority(input.body?.priority, input.mode === "worker.send_task" ? "HIGH" : "NORMAL");
    const extra = toNonEmpty(input.body?.extra || input.body?.notes || "");
    const packetLines = [
      `COMMAND: ${input.commandId}`,
      `TASK: ${task || input.command.summary}`,
      `SCOPE: ${scope.join(" ; ") || "Worker-owned files relevant to this command."}`,
      `NOT-YOUR-JOB: ${notYourJob.join(" ; ") || "Do not expand scope without explicit orchestrator approval."}`,
      `DONE-WHEN: ${doneWhen.join(" ; ") || "Deliver concrete evidence and completion state for this command."}`,
      `VERIFY: ${verify.join(" ; ") || "Run targeted verification and include command output snippets."}`,
      `PRIORITY: ${priority}`,
      `WHEN-TO-USE: ${input.command.whenToUse}`,
    ];
    if (extra) packetLines.push(`NOTES: ${extra}`);
    return packetLines.join("\n");
  }

  function buildHarnessCommandOrchestratorPacket(input: {
    commandId: string;
    command: AgentCommandDef;
    body: any;
  }): string {
    const task = toNonEmpty(input.body?.task || input.body?.text || input.body?.objective || input.command.summary);
    const scope = normalizeStringListInput(input.body?.scope);
    const verify = normalizeStringListInput(input.body?.verify);
    const extra = toNonEmpty(input.body?.extra || input.body?.notes || "");
    const lines = [
      `ORCHESTRATION COMMAND: ${input.commandId}`,
      `OBJECTIVE: ${task || input.command.summary}`,
      `SCOPE HINTS: ${scope.join(" ; ") || "Use current orchestration scope."}`,
      `EXPECTATION: ${input.command.whenToUse}`,
      `OUTPUT FORMAT:`,
      "COMPLETED: [with evidence]",
      "PENDING: [with reason]",
      "RISKS: [key risks]",
      "NEXT: [actionable next steps]",
    ];
    if (verify.length > 0) lines.push(`VERIFY REQUEST: ${verify.join(" ; ")}`);
    if (extra) lines.push(`NOTES: ${extra}`);
    return lines.join("\n");
  }

  function pruneHarnessCommandExecutionCache(now = Date.now()): void {
    try {
      store.pruneHarnessCommandReplay({
        olderThanTs: now - HARNESS_COMMAND_IDEMPOTENCY_TTL_MS,
        maxRows: 300,
        keepRows: 220,
      });
    } catch {
      // ignore
    }
    for (const [k, v] of harnessCommandExecutionCache.entries()) {
      if (now - Number(v.ts ?? 0) > HARNESS_COMMAND_IDEMPOTENCY_TTL_MS) harnessCommandExecutionCache.delete(k);
    }
    if (harnessCommandExecutionCache.size <= 300) return;
    const entries = Array.from(harnessCommandExecutionCache.entries()).sort((a, b) => Number(a[1].ts) - Number(b[1].ts));
    let drop = harnessCommandExecutionCache.size - 220;
    for (const [k] of entries) {
      harnessCommandExecutionCache.delete(k);
      drop -= 1;
      if (drop <= 0) break;
    }
  }

  function looksLikeWorkerCompletionCue(text: string): boolean {
    const t = String(text ?? "").trim();
    if (!t) return false;
    return /\b(?:completed:|pending:|risks:|next:|final summary|handoff|task complete(?:d)?|done-when)\b/i.test(t);
  }

  function looksLikeWorkerQuestionCue(text: string): boolean {
    const t = String(text ?? "").trim();
    if (!t) return false;
    const hasQuestionPacket = /(?:^|\n)\s*question:\s*/i.test(t) && /(?:^|\n)\s*options:\s*/i.test(t) && /(?:^|\n)\s*blocking:\s*/i.test(t);
    const directDecisionAsk =
      /\bneed(?:s)?\s+(?:decision|input|approval)\b/i.test(t) ||
      /\brequest(?:ing)?\s+(?:decision|input|approval)\b/i.test(t) ||
      /\bchoose\s+one\b/i.test(t) ||
      /\bwhich\s+option\b/i.test(t);
    return hasQuestionPacket || directDecisionAsk;
  }

  function queueStaleWorkerSignals(orchestrationId: string, now = Date.now()): void {
    const rec = store.getOrchestration(orchestrationId);
    if (!rec) return;
    if (String(rec.orchestration.status ?? "active") !== "active") return;

    const counts = store.getOpenAttentionCounts();
    for (const worker of rec.workers) {
      const sessionId = String(worker.sessionId);
      const sess = store.getSession(sessionId);
      if (!sess) continue;
      if (!isStoreSessionRunning(sess)) continue;
      const attention = Number(counts[sessionId] ?? 0);
      if (attention === 0 && hasWorkerDoneLatch(orchestrationId, sessionId)) continue;
      const previewState = lastPreview.get(sessionId) ?? null;
      const lastEvent = latestSessionEventRef(sessionId);
      const activity = deriveWorkerActivity({
        running: true,
        attention,
        previewTs: previewState?.ts ?? null,
        lastEventTs: lastEvent?.ts ?? null,
        sessionUpdatedAt: Number(sess.updatedAt ?? 0) || null,
        now,
      });
      if (!activity.stale) continue;
      queueWorkerAutomationSignal(sessionId, "idle.60s", {
        delayMs: 180,
        minGapMs: ORCH_WORKER_STALE_SIGNAL_GAP_MS,
        runSync: true,
        runReview: false,
        deliverToOrchestrator: false,
      });
    }
  }

  function isAutoQuestionKind(kind: string): boolean {
    const k = String(kind || "");
    if (!k) return false;
    if (k === "claude.permission") return true;
    if (k === "codex.approval") return true;
    if (k.startsWith("codex.native.approval.")) return true;
    if (k === "codex.native.user_input") return true;
    return false;
  }

  function clearAttentionTimeoutTimer(attentionId: number) {
    const tm = orchestrationQuestionTimeoutTimers.get(attentionId);
    if (!tm) return;
    try {
      clearTimeout(tm);
    } catch {
      // ignore
    }
    orchestrationQuestionTimeoutTimers.delete(attentionId);
  }

  function appendOrchestrationEvent(orchestrationId: string, kind: string, data: any) {
    const rec = store.getOrchestration(orchestrationId);
    if (!rec) return;
    const sid = String(rec.orchestration.orchestratorSessionId);
    const evId = store.appendEvent(sid, kind, data);
    if (evId !== -1) {
      broadcastEvent(sid, { id: evId, ts: Date.now(), kind, data });
    }
  }

  function removePendingOrchestrationQuestion(orchestrationId: string, attentionId: number) {
    const st = orchestrationAutomationState.get(orchestrationId);
    if (!st) return;
    st.pendingAttentionIds = st.pendingAttentionIds.filter((id) => id !== attentionId);
  }

  function markAttentionHandledForAutomation(attentionId: number, resolution: "sent" | "dismissed", meta?: any) {
    clearAttentionTimeoutTimer(attentionId);
    const item = store.getAttentionItem(attentionId);
    if (!item) return;
    const found = findOrchestrationByWorkerSession(String(item.sessionId));
    if (!found) return;
    removePendingOrchestrationQuestion(found.orchestrationId, attentionId);
    appendOrchestrationEvent(found.orchestrationId, "orchestration.question.resolved", {
      orchestrationId: found.orchestrationId,
      attentionId,
      workerSessionId: item.sessionId,
      workerName: String(found.worker?.name ?? ""),
      kind: item.kind,
      resolution,
      meta: meta ?? {},
      ts: Date.now(),
    });
    void runOrchestrationSteeringReview(found.orchestrationId, {
      trigger: "attention.resolved",
      force: false,
      suppressLockError: true,
    }).catch(() => undefined);
    void runOrchestrationSync(found.orchestrationId, {
      trigger: "attention.resolved",
      force: false,
      suppressLockError: true,
    }).catch(() => undefined);
    broadcastGlobal({ type: "orchestrations.changed" });
  }

  function scheduleOrchestrationQuestionBatch(orchestrationId: string, reason: string) {
    if (orchestrationQuestionBatchTimers.has(orchestrationId)) return;
    const tm = setTimeout(() => {
      orchestrationQuestionBatchTimers.delete(orchestrationId);
      void dispatchOrchestrationQuestionBatch(orchestrationId, reason).catch(() => undefined);
    }, 1200);
    tm.unref?.();
    orchestrationQuestionBatchTimers.set(orchestrationId, tm);
  }

  function scheduleQuestionTimeout(orchestrationId: string, attentionId: number, timeoutMs: number) {
    clearAttentionTimeoutTimer(attentionId);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return;
    const tm = setTimeout(() => {
      orchestrationQuestionTimeoutTimers.delete(attentionId);
      const item = store.getAttentionItem(attentionId);
      if (!item || item.status !== "open") return;
      removePendingOrchestrationQuestion(orchestrationId, attentionId);
      store.addAttentionAction({
        attentionId,
        sessionId: String(item.sessionId),
        action: "auto_timeout",
        data: { orchestrationId, reason: "orchestrator_no_decision_in_time", timeoutMs },
      });
      appendOrchestrationEvent(orchestrationId, "orchestration.question.timeout", {
        orchestrationId,
        attentionId,
        workerSessionId: item.sessionId,
        kind: item.kind,
        timeoutMs,
      });
      broadcastGlobal({ type: "inbox.changed", sessionId: item.sessionId });
      broadcastGlobal({ type: "orchestrations.changed" });
    }, timeoutMs);
    tm.unref?.();
    orchestrationQuestionTimeoutTimers.set(attentionId, tm);
  }

  function queueAttentionForOrchestrator(sessionId: string, attentionId: number, kind: string) {
    const found = findOrchestrationByWorkerSession(sessionId);
    if (!found) return;
    if (!isAutoQuestionKind(kind)) return;
    const st = ensureOrchestrationAutomationState(found.orchestrationId);
    if (st.policy.questionMode !== "orchestrator") return;
    if (!st.pendingAttentionIds.includes(attentionId)) st.pendingAttentionIds.push(attentionId);
    st.lastError = null;
    appendOrchestrationEvent(found.orchestrationId, "orchestration.question.open", {
      orchestrationId: found.orchestrationId,
      attentionId,
      workerSessionId: sessionId,
      workerName: String(found.worker?.name ?? ""),
      kind,
    });
    scheduleQuestionTimeout(found.orchestrationId, attentionId, st.policy.questionTimeoutMs);
    scheduleOrchestrationQuestionBatch(found.orchestrationId, "attention.opened");
    if (st.policy.steeringMode !== "off") {
      void runOrchestrationSteeringReview(found.orchestrationId, {
        trigger: "attention.opened",
        force: false,
        suppressLockError: true,
      }).catch(() => undefined);
    }
    void runOrchestrationSync(found.orchestrationId, {
      trigger: "attention.opened",
      force: false,
      suppressLockError: true,
    }).catch(() => undefined);
    broadcastGlobal({ type: "orchestrations.changed" });
  }

  async function dispatchOrchestrationQuestionBatch(orchestrationId: string, reason: string): Promise<void> {
    const rec = store.getOrchestration(orchestrationId);
    if (!rec) return;
    const st = ensureOrchestrationAutomationState(orchestrationId);
    if (st.policy.questionMode !== "orchestrator") return;
    const orchestratorSessionId = String(rec.orchestration.orchestratorSessionId);

    const openItems = st.pendingAttentionIds
      .map((id) => store.getAttentionItem(id))
      .filter((it): it is NonNullable<typeof it> => Boolean(it && it.status === "open"));
    if (!openItems.length) return;

    const workerBySession = new Map(rec.workers.map((w) => [String(w.sessionId), w]));
    const lines: string[] = [];
    for (const it of openItems) {
      const worker = workerBySession.get(String(it.sessionId));
      if (!worker) continue;
      const options = Array.isArray(it.options) ? it.options : [];
      const optLine = options
        .slice(0, 8)
        .map((o: any) => `${String(o?.id ?? "")}: ${String(o?.label ?? "").slice(0, 80)}`)
        .filter(Boolean)
        .join(" | ");
      lines.push(
        [
          `- attentionId: ${it.id}`,
          `  worker: ${String(worker.name)} (${String(it.sessionId)})`,
          `  kind: ${String(it.kind)}`,
          `  title: ${String(it.title)}`,
          `  body: ${String(it.body).slice(0, 260)}`,
          `  options: ${optLine || "(none)"}`,
        ].join("\n"),
      );
    }
    if (!lines.length) return;

    const decisionPolicy = st.policy.yoloMode
      ? "YOLO mode is enabled. You may resolve higher-risk items if necessary, but still prefer safe options."
      : "High-risk actions must be escalated to user. Do not approve destructive actions automatically.";

    const prompt =
      `AUTOMATION QUESTION BATCH (${reason})\n` +
      `You are handling worker questions for orchestration ${orchestrationId}.\n` +
      `Question scope: workers only. Do not route orchestrator self-questions here.\n` +
      `${decisionPolicy}\n` +
      `If uncertain, do not answer; leave open for user.\n` +
      `If a worker appears completed and no follow-up is needed, prefer NO-DISPATCH and keep standby.\n` +
      `When answering, pick one option id per attention item.\n\n` +
      `Questions:\n${lines.join("\n\n")}\n\n` +
      `To answer an item, call:\n` +
      `curl -sS -X POST "$FYP_API_BASE_URL/api/inbox/<attentionId>/respond" ` +
      `-H "Authorization: Bearer $FYP_API_TOKEN" -H "content-type: application/json" ` +
      `-d '{"optionId":"<id>","meta":{"source":"orchestrator-auto","orchestrationId":"${orchestrationId}"}}'\n\n` +
      `After resolving what you can, summarize briefly what was answered, what stayed open, and where you chose NO-DISPATCH.`;

    try {
      await sendInputDirect(orchestratorSessionId, normalizePromptInput(prompt));
      st.lastQuestionDispatchAt = Date.now();
      st.questionDispatchCount += 1;
      appendOrchestrationEvent(orchestrationId, "orchestration.question.batch_dispatched", {
        orchestrationId,
        reason,
        attentionIds: openItems.map((i) => Number(i.id)),
        count: openItems.length,
      });
    } catch (e: any) {
      st.lastError = typeof e?.message === "string" ? e.message : "dispatch_failed";
      appendOrchestrationEvent(orchestrationId, "orchestration.question.dispatch_failed", {
        orchestrationId,
        reason,
        error: st.lastError,
      });
    }
    broadcastGlobal({ type: "orchestrations.changed" });
  }

  async function runOrchestrationSteeringReview(
    orchestrationId: string,
    opts?: { trigger?: string; force?: boolean; suppressLockError?: boolean },
  ): Promise<{ sent: boolean; reason: string }> {
    const rec = store.getOrchestration(orchestrationId);
    if (!rec) return { sent: false, reason: "not_found" };
    if (String(rec.orchestration.status) !== "active") return { sent: false, reason: "not_active" };
    const st = ensureOrchestrationAutomationState(orchestrationId);
    if (st.policy.steeringMode === "off") return { sent: false, reason: "steering_off" };
    if (st.inFlightReview) return { sent: false, reason: "in_flight" };
    const trigger = toNonEmpty(opts?.trigger) || "interval";
    const force = opts?.force === true;

    const lk = tryAcquireOrchestrationLock(orchestrationId, "automation-review");
    if (!lk.ok) {
      if (opts?.suppressLockError) return { sent: false, reason: "locked" };
      return { sent: false, reason: "locked" };
    }
    const owner = lk.owner;
    st.inFlightReview = true;
    try {
      const counts = store.getOpenAttentionCounts();
      const orchestratorAttention = Number(counts[rec.orchestration.orchestratorSessionId] ?? 0);
      if (!force && orchestratorAttention > 0) return { sent: false, reason: "orchestrator_pending_attention" };

      const syncSt = ensureOrchestrationSyncState(orchestrationId);
      const digest = buildOrchestrationDigestForSync(orchestrationId, `steering.${trigger}`, syncSt.workerSnapshots);
      if (!digest) return { sent: false, reason: "digest_unavailable" };

      const steeringMode = st.policy.steeringMode;
      const modeRule =
        steeringMode === "passive_review"
          ? "Passive review mode: do not interrupt workers unless there is a blocker, clear mistake, or safety issue."
          : "Active steering mode: you may send targeted follow-up prompts to workers when it improves delivery.";

      const prompt =
        `PERIODIC ORCHESTRATOR REVIEW (${trigger})\n` +
        `Orchestration: ${orchestrationId}\n` +
        `${modeRule}\n` +
        `Your review must avoid unnecessary interruptions.\n` +
        `If everything is on-track, reply with a short standby summary and no dispatch.\n` +
        `If intervention is needed, dispatch targeted messages only.\n\n` +
        `Current worker digest:\n${digest.text}\n\n` +
        `Reminder: You can dispatch with /api/orchestrations/$FYP_ORCHESTRATION_ID/dispatch.`;

      await sendInputDirect(String(rec.orchestration.orchestratorSessionId), normalizePromptInput(prompt));
      st.lastReviewAt = Date.now();
      st.reviewCount += 1;
      st.lastError = null;
      appendOrchestrationEvent(orchestrationId, "orchestration.steering.review_dispatched", {
        orchestrationId,
        trigger,
        steeringMode,
      });
      broadcastGlobal({ type: "orchestrations.changed" });
      return { sent: true, reason: "sent" };
    } catch (e: any) {
      st.lastError = typeof e?.message === "string" ? e.message : "review_failed";
      appendOrchestrationEvent(orchestrationId, "orchestration.steering.review_failed", {
        orchestrationId,
        trigger,
        error: st.lastError,
      });
      return { sent: false, reason: "review_failed" };
    } finally {
      st.inFlightReview = false;
      releaseOrchestrationLock(orchestrationId, owner);
    }
  }

  function latestSessionEventRef(sessionId: string): { id: number; kind: string; ts: number } | null {
    try {
      const ev = store.getEvents(sessionId, { limit: 1, cursor: null }).items.at(-1);
      if (!ev) return null;
      return { id: Number(ev.id), kind: String(ev.kind), ts: Number(ev.ts) };
    } catch {
      return null;
    }
  }

  function buildOrchestrationDigestForSync(
    id: string,
    trigger: string,
    previousSnapshots: Record<string, OrchestrationWorkerSnapshot>,
  ): OrchestrationSyncDigest | null {
    const rec = store.getOrchestration(id);
    if (!rec) return null;
    const counts = store.getOpenAttentionCounts();
    const orch = rec.orchestration;
    const generatedAt = Date.now();

    const workerStates = rec.workers.map((w, idx) => {
      const sid = String(w.sessionId);
      const sess = store.getSession(sid);
      const running = sess ? isStoreSessionRunning(sess) : false;
      const attention = counts[sid] ?? 0;
      const previewState = lastPreview.get(sid) ?? null;
      const baseDir =
        toNonEmpty(w.worktreePath) ||
        toNonEmpty(w.projectPath) ||
        (sess?.cwd ? toNonEmpty(sess.cwd) : "");
      const progress = baseDir
        ? readWorkerProgressMarkdown(baseDir, {
            workerIndex: Number(w.workerIndex),
            workerName: String(w.name),
          })
        : null;
      const mergedPreview = selectWorkerPreview({
        progressPreview: progress?.preview ?? null,
        progressUpdatedAt: progress?.updatedAt ?? null,
        livePreview: previewState?.line ?? null,
        livePreviewTs: previewState?.ts ?? null,
      }).preview;
      return {
        idx,
        name: String(w.name),
        sessionId: sid,
        running,
        attention,
        preview: mergedPreview,
        previewTs: previewState?.ts ?? null,
        branch: w.branch ? String(w.branch) : null,
        lastEvent: latestSessionEventRef(sid),
        progressUpdatedAt: progress?.updatedAt ?? null,
        checklistDone: progress?.checklistDone ?? 0,
        checklistTotal: progress?.checklistTotal ?? 0,
        progressRelPath: progress?.relPath ?? null,
      };
    });
    return buildOrchestrationDigestModel({
      orchestrationId: String(orch.id),
      name: String(orch.name),
      trigger,
      generatedAt,
      workers: workerStates,
      previousSnapshots,
    });
  }

  async function runOrchestrationSync(
    id: string,
    opts?: { trigger?: string; force?: boolean; deliverToOrchestrator?: boolean; suppressLockError?: boolean },
  ): Promise<{
    sent: boolean;
    delivered: boolean;
    reason: string;
    digest: OrchestrationSyncDigest | null;
  }> {
    const rec = store.getOrchestration(id);
    if (!rec) return { sent: false, delivered: false, reason: "not_found", digest: null };
    const state = ensureOrchestrationSyncState(id);
    const trigger = toNonEmpty(opts?.trigger) || "manual";
    const force = opts?.force === true;
    const deliverToOrchestrator =
      typeof opts?.deliverToOrchestrator === "boolean" ? opts.deliverToOrchestrator : state.policy.deliverToOrchestrator;

    if (state.inFlight) return { sent: false, delivered: false, reason: "in_flight", digest: null };

    const lk = tryAcquireOrchestrationLock(id, "sync");
    if (!lk.ok) {
      if (opts?.suppressLockError) return { sent: false, delivered: false, reason: "locked", digest: null };
      return { sent: false, delivered: false, reason: "locked", digest: null };
    }
    const owner = lk.owner;
    state.inFlight = true;
    state.lastRunAt = Date.now();
    state.lastReason = trigger;
    state.lastError = null;

    try {
      const digest = buildOrchestrationDigestForSync(id, trigger, state.workerSnapshots);
      if (!digest) {
        state.lastError = "not_found";
        return { sent: false, delivered: false, reason: "not_found", digest: null };
      }
      if (!force && state.lastDigestHash && digest.hash === state.lastDigestHash) {
        state.lastDigestAt = Date.now();
        state.lastChangedWorkerCount = digest.changedWorkerCount;
        state.workerSnapshots = digest.snapshots;
        return { sent: false, delivered: false, reason: "unchanged", digest };
      }

      state.lastDigestHash = digest.hash;
      state.lastDigestAt = Date.now();
      state.lastChangedWorkerCount = digest.changedWorkerCount;
      state.workerSnapshots = digest.snapshots;

      if (!deliverToOrchestrator) {
        return { sent: false, delivered: false, reason: "collect_only", digest };
      }

      const isIntervalRun = trigger === "interval";
      if (!force && isIntervalRun) {
        if (digest.changedWorkerCount === 0) {
          return { sent: false, delivered: false, reason: "unchanged", digest };
        }
        if (state.lastDeliveredAt && Date.now() - state.lastDeliveredAt < state.policy.minDeliveryGapMs) {
          return { sent: false, delivered: false, reason: "cooldown", digest };
        }
        const attentionCounts = store.getOpenAttentionCounts();
        const orchestratorAttention = Number(attentionCounts[rec.orchestration.orchestratorSessionId] ?? 0);
        if (orchestratorAttention > 0) {
          return { sent: false, delivered: false, reason: "orchestrator_pending_attention", digest };
        }
      }

      try {
        await sendInputDirect(rec.orchestration.orchestratorSessionId, normalizePromptInput(digest.text));
        state.lastDeliveredAt = Date.now();
        return { sent: true, delivered: true, reason: "sent", digest };
      } catch (e: any) {
        const msg = typeof e?.message === "string" ? e.message : "deliver_failed";
        state.lastError = msg;
        const reason = msg.includes("session_not_running") ? "orchestrator_not_running" : "deliver_failed";
        return { sent: false, delivered: false, reason, digest };
      }
    } finally {
      state.inFlight = false;
      releaseOrchestrationLock(id, owner);
      broadcastGlobal({ type: "orchestrations.changed" });
    }
  }

  function pruneOrchestrationSyncState() {
    for (const id of orchestrationSyncState.keys()) {
      if (!store.getOrchestration(id)) orchestrationSyncState.delete(id);
    }
    const activeOrchestratorSessionIds = new Set(
      store.listOrchestrations(500).map((row) => String(row.orchestratorSessionId)),
    );
    for (const [sid] of orchestrationDispatchEvidenceCache.entries()) {
      if (!activeOrchestratorSessionIds.has(String(sid))) orchestrationDispatchEvidenceCache.delete(sid);
    }
  }

  function pruneOrchestrationAutomationState() {
    for (const [id, st] of orchestrationAutomationState.entries()) {
      if (!store.getOrchestration(id)) {
        for (const aid of st.pendingAttentionIds) clearAttentionTimeoutTimer(aid);
        st.pendingAttentionIds = [];
        orchestrationAutomationState.delete(id);
        const tm = orchestrationQuestionBatchTimers.get(id);
        if (tm) {
          try {
            clearTimeout(tm);
          } catch {
            // ignore
          }
          orchestrationQuestionBatchTimers.delete(id);
        }
        const signalPrefix = `${id}|`;
        for (const [sigKey, sigTimer] of orchestrationWorkerSignalTimers.entries()) {
          if (!sigKey.startsWith(signalPrefix)) continue;
          try {
            clearTimeout(sigTimer);
          } catch {
            // ignore
          }
          orchestrationWorkerSignalTimers.delete(sigKey);
        }
        for (const sigKey of orchestrationWorkerSignalLastSentAt.keys()) {
          if (sigKey.startsWith(signalPrefix)) orchestrationWorkerSignalLastSentAt.delete(sigKey);
        }
        for (const latchKey of orchestrationWorkerDoneLatch.keys()) {
          if (latchKey.startsWith(signalPrefix)) orchestrationWorkerDoneLatch.delete(latchKey);
        }
      }
    }
  }

  const orchestrationSyncTicker = setInterval(() => {
    pruneOrchestrationSyncState();
    pruneOrchestrationAutomationState();
    const now = Date.now();
    for (const [id, st] of orchestrationSyncState.entries()) {
      if (st.policy.mode !== "interval") continue;
      if (st.inFlight) continue;
      const last = st.lastRunAt ?? 0;
      if (now - last < st.policy.intervalMs) continue;
      void runOrchestrationSync(id, {
        trigger: "interval",
        force: false,
        deliverToOrchestrator: st.policy.deliverToOrchestrator,
        suppressLockError: true,
      }).catch(() => undefined);
    }

    for (const [id, st] of orchestrationAutomationState.entries()) {
      if (st.policy.steeringMode !== "active_steering") continue;
      if (st.inFlightReview) continue;
      const last = st.lastReviewAt ?? 0;
      if (now - last < st.policy.reviewIntervalMs) continue;
      void runOrchestrationSteeringReview(id, {
        trigger: "interval",
        force: false,
        suppressLockError: true,
      }).catch(() => undefined);
    }

    // If a worker has no observable activity for >=60s, treat it as "needs input or done"
    // and trigger a lightweight sync/review cycle so the orchestrator can react.
    const staleScanIds = new Set<string>([
      ...orchestrationSyncState.keys(),
      ...orchestrationAutomationState.keys(),
    ]);
    for (const row of store.listOrchestrations(500)) staleScanIds.add(String(row.id));
    for (const id of staleScanIds) queueStaleWorkerSignals(id, now);
  }, 5_000);
  orchestrationSyncTicker.unref?.();

  async function removeGitWorktreeRobust(input: { repoPath: string; worktreePath: string; force?: boolean }): Promise<{ ok: true; attempts: number } | { ok: false; attempts: number; message: string }> {
    const maxAttempts = 3;
    for (let i = 0; i < maxAttempts; i++) {
      const r = await removeGitWorktree(input);
      if (r.ok) return { ok: true, attempts: i + 1 };
      // Extra recovery between retries: prune stale worktree metadata.
      try {
        await execCapture("git", ["-C", input.repoPath, "worktree", "prune"], { timeoutMs: 5_000 });
      } catch {
        // ignore
      }
      if (i < maxAttempts - 1) await sleep(120 * (i + 1));
      if (i === maxAttempts - 1) return { ok: false, attempts: i + 1, message: r.message };
    }
    return { ok: false, attempts: maxAttempts, message: "failed to remove worktree" };
  }
  async function listOpenCodeToolSessionsForPath(cwd: string, opts?: { refresh?: boolean }): Promise<ToolSessionSummary[]> {
    const key = path.resolve(cwd);
    const refresh = Boolean(opts?.refresh);
    const cached = !refresh ? opencodeToolSessionsCache.get(key) : null;
    const maxAgeMs = 3000;
    if (cached && Date.now() - cached.ts < maxAgeMs) return cached.items.slice();
    const cachedAny = opencodeToolSessionsCache.get(key) ?? null;
    const forcedMinAgeMs = 1500;
    if (refresh && cachedAny && Date.now() - cachedAny.ts < forcedMinAgeMs) return cachedAny.items.slice();

    let caps: any = null;
    try {
      caps = await detector.get();
    } catch {
      caps = null;
    }
    if (!caps?.opencode?.installed) return [];

    const spec = tools.opencode;
    const args = [...spec.args, "session", "list", "--format", "json"];
    const r = await execCaptureViaFile(spec.command, args, { timeoutMs: 14_000, cwd: key });
    if (!r.ok) return [];

    const items = parseOpenCodeSessionList(stripAnsi(r.stdout));
    opencodeToolSessionsCache.set(key, { ts: Date.now(), items });
    return items.slice();
  }
  app.get("/api/tool-sessions", async (req, reply) => {
    const q = (req.query ?? {}) as any;
    const tool = typeof q?.tool === "string" ? String(q.tool).trim() : "";
    const under = typeof q?.under === "string" ? String(q.under).trim() : "";
    const refresh = q?.refresh === "1" || q?.refresh === "true" || q?.refresh === "yes";
    const limit = Math.min(500, Math.max(20, Math.floor(Number(q?.limit ?? 160) || 160)));
    const maxAgeDays = Math.min(3650, Math.max(0, Math.floor(Number(q?.maxAgeDays ?? 30) || 30)));
    const includeStale = q?.includeStale === "1" || q?.includeStale === "true" || q?.includeStale === "yes";

    let items = toolIndex.list({ refresh });
    if (tool === "codex" || tool === "claude") items = items.filter((s) => s.tool === tool);
    if (tool === "opencode") items = [];

    if (under) {
      const vv = validateCwd(under, roots);
      if (!vv.ok) return reply.code(400).send({ error: "bad_path", reason: vv.reason });
      const root = vv.cwd;
      items = items.filter((s) => isUnderRoot(s.cwd, root));

      // OpenCode sessions are listed per project directory; we only fetch them when the
      // caller scopes by `under=...` (workspace) for performance and relevance.
      if (!tool || tool === "opencode") {
        try {
          const oc = await listOpenCodeToolSessionsForPath(root, { refresh });
          items = items.concat(oc.filter((s) => isUnderRoot(s.cwd, root)));
        } catch {
          // ignore
        }
      }
    }

    // Deduplicate by tool+session id and keep the most recently updated record.
    const dedup = new Map<string, (typeof items)[number]>();
    for (const it of items) {
      const k = `${String(it.tool)}:${String(it.id)}`;
      const cur = dedup.get(k);
      if (!cur || Number(it.updatedAt ?? 0) >= Number(cur.updatedAt ?? 0)) dedup.set(k, it);
    }
    items = Array.from(dedup.values());

    if (!includeStale && maxAgeDays > 0) {
      const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
      items = items.filter((s) => Number(s.updatedAt ?? 0) >= cutoff);
    }

    items.sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0));
    const total = items.length;
    items = items.slice(0, limit);
    return {
      ok: true,
      items,
      meta: {
        total,
        returned: items.length,
        limit,
        maxAgeDays: includeStale ? 0 : maxAgeDays,
        hasMore: total > items.length,
      },
    };
  });

  app.get("/api/tool-sessions/:tool/:id/messages", async (req, reply) => {
    const params = (req.params ?? {}) as any;
    const tool = params.tool as any;
    const id = typeof params.id === "string" ? String(params.id) : "";
    const q = (req.query ?? {}) as any;
    const refresh = q?.refresh === "1" || q?.refresh === "true" || q?.refresh === "yes";
    const limit = Number(q?.limit ?? 160);
    if (tool !== "codex" && tool !== "claude" && tool !== "opencode") return reply.code(400).send({ error: "bad_tool" });
    if (!id) return reply.code(400).send({ error: "bad_id" });

    if (tool === "opencode") {
      let caps: any = null;
      try {
        caps = await detector.get();
      } catch {
        caps = null;
      }
      if (!caps?.opencode?.installed) return reply.code(400).send({ error: "tool_not_installed" });

      const spec = tools.opencode;
      const r = await execCaptureViaFile(spec.command, [...spec.args, "export", id], { timeoutMs: 22_000 });
      if (!r.ok) {
        const msg = (r.stderr || r.stdout || r.error || "").trim().slice(0, 420);
        return reply.code(404).send({ error: "not_found", message: msg || "export failed" });
      }
      const parsed = parseOpenCodeExport(stripAnsi(r.stdout), { limit, idFallback: id });
      if (!parsed.session) return reply.code(404).send({ error: "not_found" });
      return { ok: true, session: parsed.session, messages: parsed.messages ?? [] };
    }

    const sess = toolIndex.get(tool, id, { refresh });
    if (!sess) return reply.code(404).send({ error: "not_found" });
    const messages = toolIndex.getMessages(tool, id, { refresh, limit });
    return { ok: true, session: sess, messages: messages ?? [] };
  });

  // Codex Native mode (Codex App Server): structured threads/turns for chat-first UIs.
  app.get("/api/codex-native/threads", async (req, reply) => {
    const q = (req.query ?? {}) as any;
    const limit = Number(q?.limit ?? 80);
    const cursor = typeof q?.cursor === "string" ? q.cursor : null;
    const archived = q?.archived === "1" || q?.archived === "true" || q?.archived === "yes";
    try {
      await codexApp.ensureStarted();
      const r: any = await codexApp.call("thread/list", {
        cursor,
        limit: Math.min(200, Math.max(10, Math.floor(limit || 80))),
        archived: archived ? true : null,
      });
      return { ok: true, data: r?.data ?? [], nextCursor: r?.nextCursor ?? null };
    } catch (e: any) {
      return reply.code(400).send({ ok: false, error: "codex_native_unavailable", message: String(e?.message ?? e) });
    }
  });

  app.get("/api/codex-native/threads/:id", async (req, reply) => {
    const params = (req.params ?? {}) as any;
    const threadId = typeof params.id === "string" ? String(params.id) : "";
    if (!threadId) return reply.code(400).send({ ok: false, error: "bad_thread_id" });
    try {
      await codexApp.ensureStarted();
      const r: any = await codexApp.call("thread/read", { threadId, includeTurns: true });
      return { ok: true, thread: r?.thread ?? null };
    } catch (e: any) {
      const msg = String(e?.message ?? e ?? "");
      // New/native threads can exist before first user message; Codex may reject includeTurns
      // until the thread is materialized. Return an empty thread instead of surfacing an error.
      if (
        /not materialized yet|includeturns is unavailable|thread not loaded|thread not found|no such thread|unknown thread/i.test(
          msg,
        )
      ) {
        return {
          ok: true,
          thread: {
            id: threadId,
            turns: [],
          },
        };
      }
      return reply.code(400).send({ ok: false, error: "codex_native_unavailable", message: String(e?.message ?? e) });
    }
  });

  app.get("/api/inbox", async (req) => {
    const q = req.query as any;
    const limit = Number(q?.limit ?? 120);
    const workspaceKeyRaw = typeof q?.workspaceKey === "string" ? q.workspaceKey : null;
    const workspaceKey =
      workspaceKeyRaw && !workspaceKeyRaw.startsWith("dir:") ? workspaceKeyRaw : null;
    const cwd =
      workspaceKeyRaw && workspaceKeyRaw.startsWith("dir:") ? workspaceKeyRaw.slice("dir:".length) : null;
    const sessionId = typeof q?.sessionId === "string" ? q.sessionId : null;
    const items = store.listInbox({ limit, workspaceKey, cwd, sessionId });
    const out = items.map((it) => ({
      taskId: store.getTaskMemberBySession(it.sessionId)?.taskId ?? null,
      ...it,
      session: store.getSession(it.sessionId),
    }));
    return { ok: true, items: out };
  });

  app.post("/api/inbox/:id/respond", async (req, reply) => {
    const id = Number((req.params as any).id);
    if (!Number.isFinite(id)) return reply.code(400).send({ error: "bad_id" });
    const body = (req.body ?? {}) as any;
    const optionId = typeof body.optionId === "string" ? body.optionId : "";
    const meta =
      body?.meta && typeof body.meta === "object" && !Array.isArray(body.meta)
        ? body.meta
        : {};
    const actionSource = typeof body?.source === "string" && body.source.trim() ? body.source.trim() : null;
    const item = store.getAttentionItem(id);
    if (!item) return reply.code(404).send({ error: "not_found" });
    const sess = store.getSession(item.sessionId);
    if (!sess) return reply.code(404).send({ error: "session_not_found" });
    const opts = Array.isArray(item.options) ? item.options : [];
    const opt = opts.find((o: any) => String(o?.id) === optionId) ?? null;
    const send = opt && typeof opt.send === "string" ? opt.send : "";
    const decision = opt && typeof opt.decision === "object" ? opt.decision : null;
    const rpc = opt && typeof opt.rpc === "object" ? opt.rpc : null;
    const userInput = opt && typeof opt.userInput === "object" ? opt.userInput : null;
    if (!send && !decision && !rpc && !userInput) return reply.code(400).send({ error: "bad_option" });

    if (userInput && String(item.kind || "").startsWith("codex.native.user_input")) {
      const st = codexNativeUserInputByAttentionId.get(id);
      if (!st) return reply.code(409).send({ error: "no_state" });

      const qid = typeof (userInput as any)?.questionId === "string" ? String((userInput as any).questionId) : "";
      const answersRaw = Array.isArray((userInput as any)?.answers) ? (userInput as any).answers : [];
      const answers = answersRaw.map((x: any) => String(x ?? "")).filter(Boolean);
      if (qid) st.answers[qid] = answers.length ? answers : [""]; // best-effort

      st.idx = Math.min(st.questions.length, Math.max(0, (st.idx ?? 0) + 1));

      const nextQ = st.idx < st.questions.length ? st.questions[st.idx] : null;
      if (nextQ) {
        const qHeader =
          typeof nextQ?.header === "string" && nextQ.header ? String(nextQ.header) : "Codex needs input";
        const qText =
          typeof nextQ?.question === "string" && nextQ.question ? String(nextQ.question) : "Select an option to continue.";
        const rawOpts = Array.isArray(nextQ?.options) ? nextQ.options : [];
        const nextId = typeof nextQ?.id === "string" ? String(nextQ.id) : "";
        const nextOptions: any[] = rawOpts.length
          ? rawOpts.slice(0, 10).map((o: any, idx: number) => ({
              id: String(idx + 1),
              label: String(o?.label ?? `Option ${idx + 1}`),
              userInput: { questionId: nextId, answers: [String(o?.label ?? "")] },
            }))
          : [{ id: "n", label: "Not supported (needs text input)", userInput: { questionId: nextId, answers: [""] } }];

        try {
          store.updateAttentionItem(id, { title: qHeader, body: qText, options: nextOptions });
        } catch {
          // ignore
        }
        broadcastGlobal({ type: "inbox.changed", sessionId: item.sessionId });
        return { ok: true, pending: true };
      }

      // Completed: respond to Codex App Server.
      const out: Record<string, { answers: string[] }> = {};
      for (const [k, v] of Object.entries(st.answers)) out[k] = { answers: Array.isArray(v) ? v : [] };
      try {
        codexApp.respond(st.requestId, { answers: out });
      } catch {
        // ignore
      }
      codexNativeUserInputByAttentionId.delete(id);

      const evId = store.appendEvent(item.sessionId, "inbox.respond", { attentionId: id, optionId, send: "" });
      broadcastEvent(item.sessionId, { id: evId, ts: Date.now(), kind: "inbox.respond", data: { attentionId: id, optionId, send: "" } });
      store.addAttentionAction({
        attentionId: id,
        sessionId: item.sessionId,
        action: "respond",
        data: {
          optionId,
          source: actionSource ?? null,
          meta,
        },
      });
      store.setAttentionStatus(id, "sent");
      markAttentionHandledForAutomation(id, "sent", {
        optionId,
        source: actionSource ?? null,
        meta,
      });
      broadcastGlobal({ type: "inbox.changed", sessionId: item.sessionId });
      return { ok: true, event: { id: evId, ts: Date.now(), kind: "inbox.respond", data: { attentionId: id, optionId, send: "" } } };
    }

    if (send) {
      try {
        sessions.write(item.sessionId, send);
      } catch (e: any) {
        return reply.code(400).send({ error: "write_failed", message: String(e?.message ?? "write failed") });
      }
    } else if (decision) {
      // Claude hook: store the decision for the polling hook script.
      const rec = claudeHookRequests.get(item.signature);
      if (rec) rec.decision = decision;
      else claudeHookRequests.set(item.signature, { sessionId: item.sessionId, attentionId: id, createdAt: Date.now(), decision, deliveredAt: null });
    } else if (rpc) {
      const rid = (rpc as any)?.requestId;
      const result = (rpc as any)?.result ?? null;
      if (rid == null || result == null) return reply.code(400).send({ error: "bad_rpc" });
      try {
        codexApp.respond(rid, result);
      } catch (e: any) {
        return reply.code(400).send({ error: "rpc_failed", message: String(e?.message ?? "rpc failed") });
      }
      codexNativeRpcByAttentionId.delete(id);
    }

    const evId = store.appendEvent(item.sessionId, "inbox.respond", { attentionId: id, optionId, send });
    broadcastEvent(item.sessionId, { id: evId, ts: Date.now(), kind: "inbox.respond", data: { attentionId: id, optionId, send } });
    store.addAttentionAction({
      attentionId: id,
      sessionId: item.sessionId,
      action: "respond",
      data: {
        optionId,
        source: actionSource ?? null,
        meta,
      },
    });
    store.setAttentionStatus(id, "sent");
    markAttentionHandledForAutomation(id, "sent", {
      optionId,
      source: actionSource ?? null,
      meta,
    });
    broadcastGlobal({ type: "inbox.changed", sessionId: item.sessionId });
    return { ok: true, event: { id: evId, ts: Date.now(), kind: "inbox.respond", data: { attentionId: id, optionId, send } } };
  });

  app.post("/api/inbox/:id/dismiss", async (req, reply) => {
    const id = Number((req.params as any).id);
    if (!Number.isFinite(id)) return reply.code(400).send({ error: "bad_id" });
    const body = (req.body ?? {}) as any;
    const meta =
      body?.meta && typeof body.meta === "object" && !Array.isArray(body.meta)
        ? body.meta
        : {};
    const actionSource = typeof body?.source === "string" && body.source.trim() ? body.source.trim() : null;
    const item = store.getAttentionItem(id);
    if (!item) return reply.code(404).send({ error: "not_found" });
    const evId = store.appendEvent(item.sessionId, "inbox.dismiss", { attentionId: id });
    broadcastEvent(item.sessionId, { id: evId, ts: Date.now(), kind: "inbox.dismiss", data: { attentionId: id } });
    store.addAttentionAction({
      attentionId: id,
      sessionId: item.sessionId,
      action: "dismiss",
      data: {
        source: actionSource ?? null,
        meta,
      },
    });
    store.setAttentionStatus(id, "dismissed");
    markAttentionHandledForAutomation(id, "dismissed", {
      source: actionSource ?? null,
      meta,
    });
    broadcastGlobal({ type: "inbox.changed", sessionId: item.sessionId });
    return { ok: true, event: { id: evId, ts: Date.now(), kind: "inbox.dismiss", data: { attentionId: id } } };
  });

  app.get("/api/sessions", async (req) => {
    const counts = store.getOpenAttentionCounts();
    const q = (req.query ?? {}) as any;
    const includeInternal = q?.includeInternal === "1" || q?.includeInternal === "true" || q?.includeInternal === "yes";
    const limit = Math.min(2000, Math.max(20, Math.floor(Number(q?.limit ?? 250) || 250)));
    return store
      .listSessions(limit)
      .map((s) => {
      const member = store.getTaskMemberBySession(String(s.id));
      const task = member?.taskId ? store.getTask(member.taskId) : null;
      if (!includeInternal && task?.visibility === "internal") return null;
      return {
        ...s,
        running: isStoreSessionRunning(s),
        closing: closingSessions.has(String(s.id)),
        attention: counts[s.id] ?? 0,
        preview: lastPreview.get(s.id)?.line ?? null,
        taskId: task?.id ?? member?.taskId ?? null,
        taskRole: member?.role ?? null,
        taskMode: normalizeTaskMode(member?.modeOverride ?? task?.defaultMode ?? null),
        taskVisibility: task?.visibility ?? null,
      };
      })
      .filter(Boolean);
  });

  app.delete("/api/sessions/:id", async (req, reply) => {
    const id = (req.params as any).id as string;
    const q = (req.query ?? {}) as any;
    const force = q?.force === "1" || q?.force === "true" || q?.force === "yes";
    if (!id) return reply.code(400).send({ ok: false, error: "bad_id" });
    if (closingSessions.has(id)) return reply.code(409).send({ ok: false, error: "closing" });

    const sess = store.getSession(id);
    if (!sess) return reply.code(404).send({ ok: false, error: "not_found" });

    const running = isStoreSessionRunning(sess);
    if (running && !force) return reply.code(409).send({ ok: false, error: "running" });

    closingSessions.add(id);
    notifySessionSockets(id, { type: "session.closing", ts: Date.now() });
    try {
      const out = await closeSessionLifecycle({ sessionId: id, storeSession: sess, force: force || running, deleteRecord: true });
      maybePruneOrphanTasks({ force: true });
      broadcastGlobal({ type: "sessions.changed" });
      broadcastGlobal({ type: "workspaces.changed" });
      broadcastGlobal({ type: "inbox.changed", sessionId: id });
      broadcastGlobal({ type: "tasks.changed" });
      return { ok: true, wasRunning: out.wasRunning, force: force || running };
    } catch (e: any) {
      return reply.code(500).send({ ok: false, error: "delete_failed", message: String(e?.message ?? "delete_failed") });
    } finally {
      closingSessions.delete(id);
    }
  });

  app.post("/api/sessions", async (req, reply) => {
    const body = (req.body ?? {}) as any;
    const tool = body.tool as ToolId;
    const profileId = typeof body.profileId === "string" ? body.profileId : `${tool}.default`;
    const requestedCwd = typeof body.cwd === "string" ? body.cwd : null;
    const savePreset = typeof body.savePreset === "boolean" ? body.savePreset : true;
    const toolActionRaw = typeof body.toolAction === "string" ? body.toolAction : null;
    const toolAction = toolActionRaw === "resume" || toolActionRaw === "fork" ? toolActionRaw : null;
    const toolSessionId = typeof body.toolSessionId === "string" ? body.toolSessionId.trim() : "";
    const wantsToolSession = Boolean(toolAction && toolSessionId);
    const transportRaw = typeof body.transport === "string" ? body.transport.trim() : "";
    const transport =
      tool === "codex" && (transportRaw === "codex-app-server" || transportRaw === "native" || transportRaw === "codex-native")
        ? "codex-app-server"
        : "pty";
    const taskIdInput = typeof body.taskId === "string" ? body.taskId.trim() : "";
    const taskRoleInput = typeof body.taskRole === "string" ? body.taskRole.trim() : "";
    const taskRole =
      taskRoleInput === "parent" || taskRoleInput === "child" || taskRoleInput === "helper" ? taskRoleInput : "solo";
    const taskTitleInput = typeof body.taskTitle === "string" ? body.taskTitle.trim() : "";
    const taskInternal = body?.taskInternal === true;
    const taskDefaultHidden = body?.taskDefaultHidden === true;

    if ((toolActionRaw || toolSessionId) && !wantsToolSession) {
      return reply.code(400).send({ error: "bad_tool_session" });
    }
    if (wantsToolSession && tool !== "codex" && tool !== "claude" && tool !== "opencode") {
      return reply.code(400).send({ error: "unsupported", field: "toolAction", value: toolAction });
    }
    if (tool !== "codex" && tool !== "claude" && tool !== "opencode") {
      return reply.code(400).send({ error: "invalid tool" });
    }

    const caps = await detector.get();
    const toolCaps =
      tool === "codex" ? caps.codex : tool === "claude" ? caps.claude : caps.opencode;
    if (!(toolCaps as any).installed) return reply.code(400).send({ error: "tool_not_installed" });

    let toolSess: any | null = null;
    if ((tool === "codex" || tool === "claude") && wantsToolSession && !(tool === "codex" && transport === "codex-app-server")) {
      toolSess = toolIndex.get(tool as any, toolSessionId, { refresh: false }) ?? toolIndex.get(tool as any, toolSessionId, { refresh: true });
      if (!toolSess) return reply.code(404).send({ error: "tool_session_not_found" });
    }

    const desiredCwd = requestedCwd ?? (toolSess?.cwd ?? null);
    const cwdOk = desiredCwd ? validateCwd(desiredCwd, roots) : null;
    if (cwdOk && !cwdOk.ok) return reply.code(400).send({ error: "bad_cwd", reason: cwdOk.reason });
    let cwd = cwdOk && cwdOk.ok ? cwdOk.cwd : undefined;
    if (!cwd) {
      const v = validateCwd(process.cwd(), roots);
      cwd = v.ok ? v.cwd : roots[0] ?? process.cwd();
    }

    const profile = profiles[profileId];
    const extraEnv: Record<string, string> = {};

    // Profile-provided env
    if (profile && profile.tool === tool) {
      if ((profile as any).env && typeof (profile as any).env === "object") {
        for (const [k, v] of Object.entries((profile as any).env as any)) extraEnv[String(k)] = String(v);
      }
    }

    const overrides = (body.overrides ?? {}) as any;

    // Merge profile tool-native settings with per-session overrides.
    const effectiveProfile =
      profile && profile.tool === tool
        ? (structuredClone(profile) as any)
        : ({
            tool,
            title: `${tool} (custom)`,
            startup: [],
            sendSuffix: "\r",
          } as any);

    function readDirs(v: any): string[] {
      if (!Array.isArray(v)) return [];
      return v.map((x) => String(x)).filter(Boolean);
    }

    function validateDirsOr400(dirs: string[]): { ok: true; dirs: string[] } | { ok: false; resp: any } {
      const out: string[] = [];
      for (const d of dirs) {
        const vv = validateCwd(d, roots);
        if (!vv.ok) return { ok: false, resp: reply.code(400).send({ error: "bad_dir", dir: d, reason: vv.reason }) as any };
        out.push(vv.cwd);
      }
      return { ok: true, dirs: Array.from(new Set(out)) };
    }

    if (tool === "codex") {
      effectiveProfile.codex = effectiveProfile.codex ?? {};
      const o = overrides.codex ?? {};
      if (typeof o.model === "string") effectiveProfile.codex.model = o.model;
      if (typeof o.sandbox === "string") effectiveProfile.codex.sandbox = o.sandbox;
      if (typeof o.askForApproval === "string") effectiveProfile.codex.askForApproval = o.askForApproval;
      if (typeof o.fullAuto === "boolean") effectiveProfile.codex.fullAuto = o.fullAuto;
      if (typeof o.bypassApprovalsAndSandbox === "boolean")
        effectiveProfile.codex.bypassApprovalsAndSandbox = o.bypassApprovalsAndSandbox;
      if (typeof o.search === "boolean") effectiveProfile.codex.search = o.search;
      if (typeof o.noAltScreen === "boolean") effectiveProfile.codex.noAltScreen = o.noAltScreen;
      const mergedDirs = [
        ...(effectiveProfile.codex.addDir ?? []),
        ...readDirs(o.addDir),
      ];
      const vd = validateDirsOr400(mergedDirs);
      if (!vd.ok) return vd.resp;
      effectiveProfile.codex.addDir = vd.dirs;

      if (effectiveProfile.codex.sandbox && !caps.codex.sandboxModes.includes(effectiveProfile.codex.sandbox)) {
        return reply.code(400).send({ error: "unsupported", field: "codex.sandbox", value: effectiveProfile.codex.sandbox });
      }
      if (
        effectiveProfile.codex.askForApproval &&
        !caps.codex.approvalPolicies.includes(effectiveProfile.codex.askForApproval)
      ) {
        return reply
          .code(400)
          .send({ error: "unsupported", field: "codex.askForApproval", value: effectiveProfile.codex.askForApproval });
      }

      if (typeof effectiveProfile.codex.noAltScreen === "boolean" && effectiveProfile.codex.noAltScreen) {
        if (!caps.codex.supports.noAltScreen) {
          return reply.code(400).send({ error: "unsupported", field: "codex.noAltScreen", value: true });
        }
      }
      const codexModel = toNonEmpty(effectiveProfile.codex.model);
      if (codexModel) {
        if (!caps.codex.supports.model) {
          return reply.code(400).send({ error: "unsupported", field: "codex.model", value: codexModel });
        }
        effectiveProfile.codex.model = codexModel;
      } else {
        delete effectiveProfile.codex.model;
      }
    }

    if (tool === "claude") {
      effectiveProfile.claude = effectiveProfile.claude ?? {};
      const o = overrides.claude ?? {};
      if (typeof o.permissionMode === "string") effectiveProfile.claude.permissionMode = o.permissionMode;
      if (typeof o.dangerouslySkipPermissions === "boolean")
        effectiveProfile.claude.dangerouslySkipPermissions = o.dangerouslySkipPermissions;
      if (typeof o.model === "string") effectiveProfile.claude.model = o.model;
      const overrideAuthMode = toClaudeAuthMode(o.authMode);
      if (overrideAuthMode) effectiveProfile.claude.authMode = overrideAuthMode;
      const mergedDirs = [
        ...(effectiveProfile.claude.addDir ?? []),
        ...readDirs(o.addDir),
      ];
      const vd = validateDirsOr400(mergedDirs);
      if (!vd.ok) return vd.resp;
      effectiveProfile.claude.addDir = vd.dirs;

      if (
        effectiveProfile.claude.permissionMode &&
        caps.claude.permissionModes.length > 0 &&
        !caps.claude.permissionModes.includes(effectiveProfile.claude.permissionMode)
      ) {
        return reply
          .code(400)
          .send({ error: "unsupported", field: "claude.permissionMode", value: effectiveProfile.claude.permissionMode });
      }
      const claudeModel = toNonEmpty(effectiveProfile.claude.model);
      if (claudeModel) {
        if (!caps.claude.supports.model) {
          return reply.code(400).send({ error: "unsupported", field: "claude.model", value: claudeModel });
        }
        effectiveProfile.claude.model = claudeModel;
      } else {
        delete effectiveProfile.claude.model;
      }
      const authMode = toClaudeAuthMode(effectiveProfile.claude.authMode);
      if (authMode) effectiveProfile.claude.authMode = authMode;
      else delete effectiveProfile.claude.authMode;
    }

    if (tool === "opencode") {
      effectiveProfile.opencode = effectiveProfile.opencode ?? {};
      const o = overrides.opencode ?? {};
      if (typeof o.model === "string") effectiveProfile.opencode.model = o.model;
      if (typeof o.agent === "string") effectiveProfile.opencode.agent = o.agent;
      if (typeof o.prompt === "string") effectiveProfile.opencode.prompt = o.prompt;
      if (typeof o.continue === "boolean") effectiveProfile.opencode.continue = o.continue;
      if (typeof o.session === "string") effectiveProfile.opencode.session = o.session;
      if (typeof o.fork === "boolean") effectiveProfile.opencode.fork = o.fork;
      if (typeof o.hostname === "string") effectiveProfile.opencode.hostname = o.hostname;
      if (typeof o.port === "number") effectiveProfile.opencode.port = o.port;
    }

    // Link FYP sessions to tool-native session IDs so we can render chat history.
    // - Claude: we can force a deterministic UUID with --session-id for new sessions.
    // - Codex: we discover the created session log shortly after spawn.
    // - OpenCode: resume/fork uses `--session`/`--fork` and we store that id.
    let toolSessionIdForStore: string | null = null;
    if (wantsToolSession) toolSessionIdForStore = toolSessionId;
    else if (tool === "claude") toolSessionIdForStore = randomUUID();

    if (wantsToolSession && tool === "opencode") {
      effectiveProfile.opencode = effectiveProfile.opencode ?? {};
      effectiveProfile.opencode.session = toolSessionId;
      effectiveProfile.opencode.continue = false;
      effectiveProfile.opencode.fork = toolAction === "fork";
    }

    const built = buildArgsForSession({
      tool,
      baseArgs: [],
      profile: effectiveProfile,
      cwd,
    });
    const codexExcludedAtSpawn =
      tool === "codex" && transport === "pty" && !toolSessionIdForStore && cwd ? snapshotCodexSessionIds(cwd) : null;
    const opencodeExcludedAtSpawn =
      tool === "opencode" && !toolSessionIdForStore && cwd ? await snapshotOpenCodeSessionIds(cwd) : null;

    if (wantsToolSession) {
      if (tool === "codex") built.args = [toolAction!, toolSessionId, ...built.args];
      if (tool === "claude") {
        built.args.push("--resume", toolSessionId);
        if (toolAction === "fork") built.args.push("--fork-session");
      }
    } else if (tool === "claude" && toolSessionIdForStore) {
      built.args.push("--session-id", toolSessionIdForStore);
    }

    // OpenCode supports a positional "project" path. Use cwd if provided.
    if (tool === "opencode" && cwd) built.args.unshift(cwd);

    const id = nanoid(12);

    // Codex Native mode: use Codex App Server (structured protocol) instead of a PTY/TUI.
    if (tool === "codex" && transport === "codex-app-server") {
      let approvalPolicy: any = effectiveProfile?.codex?.askForApproval ?? null;
      let sandbox: any = effectiveProfile?.codex?.sandbox ?? null;
      const codexNativeModel = toNonEmpty(effectiveProfile?.codex?.model) || null;
      if (effectiveProfile?.codex?.fullAuto) approvalPolicy = "never";
      if (effectiveProfile?.codex?.bypassApprovalsAndSandbox) {
        approvalPolicy = "never";
        sandbox = "danger-full-access";
      }

      try {
        await codexApp.ensureStarted();
      } catch (e: any) {
        return reply.code(400).send({ error: "codex_app_server_unavailable", message: String(e?.message ?? e) });
      }

      let resp: any = null;
      try {
        if (wantsToolSession) {
          if (toolAction === "resume") {
            resp = await codexApp.call("thread/resume", {
              threadId: toolSessionId,
              cwd,
              approvalPolicy,
              sandbox,
              model: codexNativeModel,
              modelProvider: null,
              config: null,
              baseInstructions: null,
              developerInstructions: null,
              personality: null,
            });
          } else {
            resp = await codexApp.call("thread/fork", {
              threadId: toolSessionId,
              cwd,
              approvalPolicy,
              sandbox,
              model: codexNativeModel,
              modelProvider: null,
              config: null,
              baseInstructions: null,
              developerInstructions: null,
            });
          }
        } else {
          resp = await codexApp.call("thread/start", {
            cwd,
            approvalPolicy,
            sandbox,
            model: codexNativeModel,
            modelProvider: null,
            config: null,
            baseInstructions: null,
            developerInstructions: null,
            personality: null,
            ephemeral: null,
            dynamicTools: null,
            experimentalRawEvents: false,
          });
        }
      } catch (e: any) {
        return reply.code(400).send({ error: "codex_native_failed", message: String(e?.message ?? e) });
      }

      const threadId = typeof resp?.thread?.id === "string" ? String(resp.thread.id) : "";
      if (!threadId) return reply.code(500).send({ error: "codex_native_no_thread" });

      codexNativeThreadToSession.set(threadId, id);
      if (!codexNativeThreadRun.has(threadId)) codexNativeThreadRun.set(threadId, { running: false, turnId: null });
      const model = typeof resp?.model === "string" ? String(resp.model) : "";
      const modelProvider = typeof resp?.modelProvider === "string" ? String(resp.modelProvider) : "";
      const reasoningEffort = typeof resp?.reasoningEffort === "string" ? String(resp.reasoningEffort) : null;
      codexNativeThreadMeta.set(threadId, { model, modelProvider, reasoningEffort });

      log("session created (codex native)", { id, tool, profileId, transport, cwd: cwd ?? null, threadId });

      store.createSession({
        id,
        tool,
        profileId,
        transport: "codex-app-server",
        toolSessionId: threadId,
        cwd: cwd ?? null,
        workspaceKey: null,
        workspaceRoot: null,
        treePath: null,
      });
      const taskId = ensureTaskForSession({
        sessionId: id,
        role: taskRole as any,
        ordinal: 0,
        taskId: taskIdInput || undefined,
        title: taskTitleInput || null,
        isInternal: taskInternal,
        defaultHidden: taskDefaultHidden,
      });

      const createdEventId = store.appendEvent(id, "session.created", {
        tool,
        profileId,
        transport: "codex-app-server",
        cwd: cwd ?? null,
        toolAction: wantsToolSession ? toolAction : null,
        toolSessionId: wantsToolSession ? toolSessionId : threadId,
        overrides: overrides ?? {},
        savePreset,
        workspaceKey: null,
        workspaceRoot: null,
        treePath: null,
      });
      broadcastEvent(id, { id: createdEventId, ts: Date.now(), kind: "session.created", data: { tool, profileId, cwd: cwd ?? null } });
      broadcastGlobal({ type: "sessions.changed" });

      if (cwd && savePreset) {
        try {
          store.upsertWorkspacePreset({ path: cwd, tool, profileId, overrides: overrides ?? {} });
          broadcastGlobal({ type: "workspaces.changed" });
        } catch {
          // ignore
        }
      }

      if (cwd) {
        void (async () => {
          let workspaceKey: string | null = null;
          let workspaceRoot: string | null = null;
          let treePath: string | null = null;
          try {
            const gr = await resolveGitForPath(cwd);
            if (gr.ok) {
              workspaceKey = gr.workspaceKey;
              workspaceRoot = gr.workspaceRoot;
              treePath = gr.treeRoot;
            }
          } catch {
            // ignore
          }

          if (!workspaceKey && !workspaceRoot && !treePath) return;
          try {
            const cur = store.getSession(id);
            if (!cur) return;
            store.setSessionMeta({
              id,
              workspaceKey,
              workspaceRoot,
              treePath,
              label: cur.label ?? null,
            });
            const evId = store.appendEvent(id, "session.git", { workspaceKey, workspaceRoot, treePath });
            if (evId !== -1) {
              broadcastEvent(id, {
                id: evId,
                ts: Date.now(),
                kind: "session.git",
                data: { workspaceKey, workspaceRoot, treePath },
              });
            }
            broadcastGlobal({ type: "sessions.changed" });
            broadcastGlobal({ type: "workspaces.changed" });

            if (savePreset && workspaceKey) {
              const presetPaths = new Set<string>([workspaceKey]);
              if (workspaceRoot) presetPaths.add(workspaceRoot);
              for (const pp of presetPaths) store.upsertWorkspacePreset({ path: pp, tool, profileId, overrides: overrides ?? {} });
              broadcastGlobal({ type: "workspaces.changed" });
            }
          } catch {
            // ignore
          }
        })();
      }

      broadcastGlobal({ type: "tasks.changed" });
      return { id, taskId };
    }

    // Claude Code: install PermissionRequest hook (session-local via --settings) so approvals show in Inbox.
    if (tool === "claude" && claudeHooksEnabled && caps.claude.supports.settings) {
      const scriptPath = ensureClaudePermissionHookScript();
      if (scriptPath) {
        const hookKey = nanoid(32);
        claudeHookSessions.set(id, { key: hookKey });
        extraEnv.FYP_HOOK_BASE_URL = hookBaseUrl;
        extraEnv.FYP_HOOK_KEY = hookKey;
        extraEnv.FYP_SESSION_ID = id;
        const cmd = `${shQuote(process.execPath)} ${shQuote(scriptPath)}`;
        const settings = {
          hooks: {
            PermissionRequest: [
              {
                matcher: "*",
                hooks: [{ type: "command", command: cmd, timeout: 600 }],
              },
            ],
          },
        };
        built.args.push("--settings", JSON.stringify(settings));
      }
    }

    const spawnedAt = Date.now();
    const claudeAuthMode = tool === "claude" ? resolveClaudeAuthMode(effectiveProfile?.claude) : undefined;
    try {
      sessions.createSession({
        id,
        tool,
        profileId,
        cwd,
        extraArgs: built.args,
        env: extraEnv,
        claudeAuthMode,
      });
    } catch (e: any) {
      claudeHookSessions.delete(id);
      return reply.code(400).send({
        error: "spawn_failed",
        message: typeof e?.message === "string" ? e.message : "failed to spawn tool",
      });
    }

    log("session created", { id, tool, profileId, cwd: cwd ?? null, toolSessionId: toolSessionIdForStore });

    // Persist the session immediately so hook callbacks (Claude) and websockets can
    // associate events with it. Git resolution can be slow; do that async later.
    store.createSession({
      id,
      tool,
      profileId,
      toolSessionId: toolSessionIdForStore,
      cwd: cwd ?? null,
      workspaceKey: null,
      workspaceRoot: null,
      treePath: null,
    });
    const taskId = ensureTaskForSession({
      sessionId: id,
      role: taskRole as any,
      ordinal: 0,
      taskId: taskIdInput || undefined,
      title: taskTitleInput || null,
      isInternal: taskInternal,
      defaultHidden: taskDefaultHidden,
    });

    if (tool === "codex" && !toolSessionIdForStore && cwd) {
      if (codexExcludedAtSpawn) codexLinkExcludedIds.set(id, codexExcludedAtSpawn);
      scheduleCodexToolSessionLink(id, cwd, spawnedAt, { excludedIds: codexExcludedAtSpawn ?? undefined });
    }
    if (tool === "opencode" && !toolSessionIdForStore && cwd) {
      if (opencodeExcludedAtSpawn) opencodeLinkExcludedIds.set(id, opencodeExcludedAtSpawn);
      scheduleOpenCodeToolSessionLink(id, cwd, spawnedAt, { excludedIds: opencodeExcludedAtSpawn ?? undefined });
    }

    const createdEventId = store.appendEvent(id, "session.created", {
      tool,
      profileId,
      cwd: cwd ?? null,
      toolAction: wantsToolSession ? toolAction : null,
      toolSessionId: wantsToolSession ? toolSessionId : toolSessionIdForStore,
      args: built.args,
      notes: built.notes,
      overrides: overrides ?? {},
      savePreset,
      workspaceKey: null,
      workspaceRoot: null,
      treePath: null,
    });
    broadcastEvent(id, { id: createdEventId, ts: Date.now(), kind: "session.created", data: { tool, profileId, cwd: cwd ?? null } });
    attachBroadcast(id, tool);
    attachExitTracking(id);
    broadcastGlobal({ type: "sessions.changed" });

    // Save per-workspace defaults (non-permanent tool config; just FYP presets).
    if (cwd && savePreset) {
      try {
        // Write the cwd preset immediately; git-workspace presets are written after resolution.
        store.upsertWorkspacePreset({ path: cwd, tool, profileId, overrides: overrides ?? {} });
        broadcastGlobal({ type: "workspaces.changed" });
      } catch {
        // ignore
      }
    }

    // Resolve git workspace metadata asynchronously (reduces create latency and avoids
    // missing early Claude hook callbacks due to slow git commands).
    if (cwd) {
      void (async () => {
        let workspaceKey: string | null = null;
        let workspaceRoot: string | null = null;
        let treePath: string | null = null;
        try {
          const gr = await resolveGitForPath(cwd);
          if (gr.ok) {
            workspaceKey = gr.workspaceKey;
            workspaceRoot = gr.workspaceRoot;
            treePath = gr.treeRoot;
          }
        } catch {
          // ignore
        }

        if (!workspaceKey && !workspaceRoot && !treePath) return;
        try {
          const cur = store.getSession(id);
          if (!cur) return;
          store.setSessionMeta({
            id,
            workspaceKey,
            workspaceRoot,
            treePath,
            label: cur.label ?? null,
          });
          const evId = store.appendEvent(id, "session.git", { workspaceKey, workspaceRoot, treePath });
          if (evId !== -1) {
            broadcastEvent(id, {
              id: evId,
              ts: Date.now(),
              kind: "session.git",
              data: { workspaceKey, workspaceRoot, treePath },
            });
          }
          broadcastGlobal({ type: "sessions.changed" });
          broadcastGlobal({ type: "workspaces.changed" });

          // Also persist git-workspace presets so worktrees share defaults.
          if (savePreset && workspaceKey) {
            const presetPaths = new Set<string>([workspaceKey]);
            if (workspaceRoot) presetPaths.add(workspaceRoot);
            for (const pp of presetPaths) store.upsertWorkspacePreset({ path: pp, tool, profileId, overrides: overrides ?? {} });
            broadcastGlobal({ type: "workspaces.changed" });
          }
        } catch {
          // ignore
        }
      })();
    }

    if (profile && profile.tool === tool) {
      try {
        const writes = macroToWrites(profile.startup as any);
        for (const w of writes) sessions.write(id, w);
        const evId = store.appendEvent(id, "profile.startup", { profileId });
        broadcastEvent(id, { id: evId, ts: Date.now(), kind: "profile.startup", data: { profileId } });
      } catch {
        const evId = store.appendEvent(id, "profile.startup_failed", { profileId });
        broadcastEvent(id, { id: evId, ts: Date.now(), kind: "profile.startup_failed", data: { profileId } });
      }
    }

    broadcastGlobal({ type: "tasks.changed" });
    return { id, taskId };
  });

  app.get("/api/sessions/:id", async (req, reply) => {
    const id = (req.params as any).id as string;
    const s = store.getSession(id);
    if (!s) return reply.code(404).send({ error: "not found" });
    const transport = sessionTransport(s);
    const st = transport === "pty" ? sessions.getStatus(id) : null;
    const running = isStoreSessionRunning(s);
    const member = store.getTaskMemberBySession(id);
    const task = member?.taskId ? store.getTask(member.taskId) : null;
    return {
      ...s,
      closing: closingSessions.has(id),
      taskId: task?.id ?? member?.taskId ?? null,
      taskRole: member?.role ?? null,
      taskMode: normalizeTaskMode(member?.modeOverride ?? task?.defaultMode ?? null),
      taskVisibility: task?.visibility ?? null,
      status: st ?? { running, pid: null, exitCode: s.exitCode, signal: s.signal },
    };
  });

  app.patch("/api/sessions/:id/mode", async (req, reply) => {
    const id = (req.params as any).id as string;
    if (!id) return reply.code(400).send({ ok: false, error: "bad_id" });
    const s = store.getSession(id);
    if (!s) return reply.code(404).send({ ok: false, error: "not_found" });

    const body = (req.body ?? {}) as any;
    const modeRaw = String(body?.mode ?? "").trim();
    if (modeRaw !== "wrap" && modeRaw !== "terminal") return reply.code(400).send({ ok: false, error: "bad_mode" });
    if (modeRaw === "terminal" && !terminalModeEnabled) {
      return reply.code(409).send({ ok: false, error: "terminal_mode_disabled", message: "Raw terminal mode is disabled on this server." });
    }

    const mode = normalizeTaskMode(modeRaw);
    const existing = store.getTaskMemberBySession(id);
    const taskId =
      existing?.taskId ??
      ensureTaskForSession({
        sessionId: id,
        role: "solo",
        ordinal: 0,
        title: s.label ?? null,
      });

    store.setTaskMemberModeOverride(taskId, id, mode);
    broadcastGlobal({ type: "tasks.changed" });
    broadcastGlobal({ type: "sessions.changed" });
    return { ok: true, id, taskId, mode, terminalModeEnabled };
  });

  app.patch("/api/sessions/:id/meta", async (req, reply) => {
    const id = (req.params as any).id as string;
    const s = store.getSession(id);
    if (!s) return reply.code(404).send({ error: "not found" });
    const body = (req.body ?? {}) as any;

    let label: string | null | undefined = undefined;
    if (body && Object.prototype.hasOwnProperty.call(body, "label")) {
      label = typeof body.label === "string" ? body.label.trim() : null;
      if (label === "") label = null;
    }

    let pinnedSlot: number | null | undefined = undefined;
    if (body && Object.prototype.hasOwnProperty.call(body, "pinnedSlot")) {
      if (body.pinnedSlot == null) pinnedSlot = null;
      else pinnedSlot = Number(body.pinnedSlot);
      if (pinnedSlot != null) {
        if (!Number.isFinite(pinnedSlot) || Math.floor(pinnedSlot) !== pinnedSlot || pinnedSlot < 1 || pinnedSlot > 6) {
          return reply.code(400).send({ error: "bad_pinnedSlot" });
        }
      }
    }

    if (label === undefined && pinnedSlot === undefined) return { ok: true };

    try {
      if (label !== undefined) store.setSessionLabel(id, label);
      if (pinnedSlot !== undefined) store.setSessionPinnedSlot(id, pinnedSlot);
    } catch (e: any) {
      return reply.code(400).send({ error: "update_failed", message: String(e?.message ?? "") });
    }

    const evId = store.appendEvent(id, "session.meta", { label: label ?? undefined, pinnedSlot: pinnedSlot ?? undefined });
    broadcastEvent(id, { id: evId, ts: Date.now(), kind: "session.meta", data: { label, pinnedSlot } });
    broadcastGlobal({ type: "sessions.changed" });
    broadcastGlobal({ type: "workspaces.changed" });
    return { ok: true, event: { id: evId, ts: Date.now(), kind: "session.meta", data: { label, pinnedSlot } } };
  });

  app.post("/api/sessions/:id/input", async (req, reply) => {
    const id = (req.params as any).id as string;
    const body = (req.body ?? {}) as any;
    const rawText = typeof body.text === "string" ? body.text : "";
    if (closingSessions.has(id)) return reply.code(409).send({ error: "session_closing" });
    const sess = store.getSession(id);
    if (!sess) return reply.code(404).send({ error: "not found" });
    // Each explicit input turn should reset directive carry/recent state so any new
    // directives in this turn can fire exactly once without inheriting stale echoes.
    orchestratorDispatchDirectiveCarry.delete(id);
    orchestratorDispatchDirectiveRecent.delete(id);
    const fallbackApplied = applyBootstrapFallbackForInput(id, rawText, { kickoffLabel: "USER KICKOFF MESSAGE" });
    let text = fallbackApplied.text;
    const injectedBootstrap = fallbackApplied.injectedBootstrap;
    const evId = store.appendEvent(id, "input", {
      text: rawText,
      injectedBootstrap,
    });
    broadcastEvent(id, { id: evId, ts: Date.now(), kind: "input", data: { text: rawText, injectedBootstrap } });
    const transport = sessionTransport(sess);
    if (transport === "codex-app-server" && sess.tool === "codex") {
      const threadId = sess.toolSessionId ? String(sess.toolSessionId) : "";
      if (!threadId) return reply.code(409).send({ error: "no_thread" });
      // Ensure mapping exists for live notifications.
      codexNativeThreadToSession.set(threadId, id);
      try {
        await codexApp.ensureStarted();
      } catch (e: any) {
        return reply.code(400).send({ error: "codex_app_server_unavailable", message: String(e?.message ?? e) });
      }

      let cleaned = String(text ?? "");
      if (cleaned.endsWith("\r\n")) cleaned = cleaned.slice(0, -2);
      else if (cleaned.endsWith("\r")) cleaned = cleaned.slice(0, -1);

      const wantsPlan = String(sess.profileId ?? "").toLowerCase().includes("plan");
      const meta = codexNativeThreadMeta.get(threadId) ?? null;
      const collaborationMode =
        wantsPlan && meta?.model
          ? { mode: "plan", settings: { model: meta.model, reasoning_effort: null, developer_instructions: null } }
          : null;

      try {
        const r: any = await codexApp.call("turn/start", {
          threadId,
          input: [{ type: "text", text: cleaned, text_elements: [] }],
          collaborationMode,
        });
        const turnId = typeof r?.turn?.id === "string" ? String(r.turn.id) : null;
        codexNativeThreadRun.set(threadId, { running: true, turnId });
        broadcastGlobal({ type: "sessions.changed" });
        broadcastGlobal({ type: "workspaces.changed" });
      } catch (e: any) {
        return reply.code(400).send({ error: "codex_native_failed", message: String(e?.message ?? e) });
      }
    } else {
      const st = sessions.getStatus(id);
      if (!st || !st.running) {
        return reply
          .code(409)
          .send({ error: "session_not_running", message: "Session stopped. Resume or start a new session to send messages." });
      }
      sessions.write(id, text);
      if (sess.tool === "codex" && !sess.toolSessionId && sess.cwd) {
        scheduleCodexToolSessionLink(id, sess.cwd, Date.now(), { excludedIds: getCodexLinkExcludedIds(id) });
      }
      if (sess.tool === "opencode" && !sess.toolSessionId && sess.cwd) {
        scheduleOpenCodeToolSessionLink(id, sess.cwd, Date.now(), { excludedIds: getOpenCodeLinkExcludedIds(id) });
      }
    }

    const orchestratedBy = findOrchestrationByOrchestratorSession(id);
    if (orchestratedBy) {
      const directives = parseOrchestratorControlDirectivesForSession(id, rawText);
      for (const d of directives.dispatches) {
        await dispatchFromOrchestratorDirective(
          orchestratedBy.orchestrationId,
          orchestratedBy.rec,
          d,
          "orchestrator.input.directive",
        );
      }
      for (const qa of directives.questionAnswers) {
        await submitQuestionAnswerDirective(qa);
      }
    }

    return { ok: true, event: { id: evId, ts: Date.now(), kind: "input", data: { text: rawText, injectedBootstrap } } };
  });

  app.post("/api/sessions/:id/restart", async (req, reply) => {
    const id = (req.params as any).id as string;
    if (!id) return reply.code(400).send({ error: "bad_id" });
    if (closingSessions.has(id)) return reply.code(409).send({ error: "session_closing" });
    const sess = store.getSession(id);
    if (!sess) return reply.code(404).send({ error: "not_found" });
    const transport = sessionTransport(sess);
    if (transport !== "pty") return reply.code(400).send({ error: "unsupported_transport" });
    const st = sessions.getStatus(id);
    if (st?.running) return reply.code(409).send({ error: "running" });

    const tool = sess.tool as ToolId;
    if (tool !== "codex" && tool !== "claude" && tool !== "opencode") return reply.code(400).send({ error: "invalid_tool" });

    const body = (req.body ?? {}) as any;
    const toolActionRaw = typeof body.toolAction === "string" ? body.toolAction : null;
    const toolAction = toolActionRaw === "resume" || toolActionRaw === "fork" ? toolActionRaw : null;
    const overrideToolSessionId = typeof body.toolSessionId === "string" ? body.toolSessionId.trim() : "";

    const storedToolSessionId = typeof sess.toolSessionId === "string" ? String(sess.toolSessionId).trim() : "";
    const created = (() => {
      try {
        return store.getLatestEvent(id, "session.created")?.data ?? null;
      } catch {
        return null;
      }
    })();

    const createdToolSessionId =
      created && typeof created.toolSessionId === "string" ? String(created.toolSessionId).trim() : "";
    const toolSessionId = overrideToolSessionId || storedToolSessionId || createdToolSessionId;

    const inferredAction = toolAction ?? (toolSessionId ? "resume" : null);
    const wantsToolSession = Boolean(inferredAction && toolSessionId);

    const overrideCwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    const createdCwd = created && typeof created.cwd === "string" ? String(created.cwd).trim() : "";
    const storedCwd = typeof sess.cwd === "string" ? String(sess.cwd).trim() : "";
    const desiredCwd = overrideCwd || storedCwd || createdCwd || null;

    const cwdOk = desiredCwd ? validateCwd(desiredCwd, roots) : null;
    if (cwdOk && !cwdOk.ok) return reply.code(400).send({ error: "bad_cwd", reason: cwdOk.reason });
    let cwd = cwdOk && cwdOk.ok ? cwdOk.cwd : undefined;
    if (!cwd) {
      const v = validateCwd(process.cwd(), roots);
      cwd = v.ok ? v.cwd : roots[0] ?? process.cwd();
    }

    const profileId = typeof body.profileId === "string" ? body.profileId : String(sess.profileId ?? `${tool}.default`);
    const baseProfile = profiles[profileId];

    const caps = await detector.get();
    const toolCaps = tool === "codex" ? caps.codex : tool === "claude" ? caps.claude : caps.opencode;
    if (!(toolCaps as any).installed) return reply.code(400).send({ error: "tool_not_installed" });

    const extraEnv: Record<string, string> = {};
    if (baseProfile && baseProfile.tool === tool && (baseProfile as any).env && typeof (baseProfile as any).env === "object") {
      for (const [k, v] of Object.entries((baseProfile as any).env as any)) extraEnv[String(k)] = String(v);
    }

    const overridesFromHistory =
      created && created.overrides && typeof created.overrides === "object" ? (created.overrides as any) : {};
    const overrides = body.overrides && typeof body.overrides === "object" ? (body.overrides as any) : overridesFromHistory;

    const effectiveProfile =
      baseProfile && baseProfile.tool === tool
        ? (structuredClone(baseProfile) as any)
        : ({
            tool,
            title: `${tool} (custom)`,
            startup: [],
            sendSuffix: "\r",
          } as any);

    function readDirs(v: any): string[] {
      if (!Array.isArray(v)) return [];
      return v.map((x) => String(x)).filter(Boolean);
    }

    function validateDirsOr400(dirs: string[]): { ok: true; dirs: string[] } | { ok: false; resp: any } {
      const out: string[] = [];
      for (const d of dirs) {
        const vv = validateCwd(d, roots);
        if (!vv.ok) return { ok: false, resp: reply.code(400).send({ error: "bad_dir", dir: d, reason: vv.reason }) as any };
        out.push(vv.cwd);
      }
      return { ok: true, dirs: Array.from(new Set(out)) };
    }

    if (tool === "codex") {
      effectiveProfile.codex = effectiveProfile.codex ?? {};
      const o = overrides?.codex ?? {};
      if (typeof o.model === "string") effectiveProfile.codex.model = o.model;
      if (typeof o.sandbox === "string") effectiveProfile.codex.sandbox = o.sandbox;
      if (typeof o.askForApproval === "string") effectiveProfile.codex.askForApproval = o.askForApproval;
      if (typeof o.fullAuto === "boolean") effectiveProfile.codex.fullAuto = o.fullAuto;
      if (typeof o.bypassApprovalsAndSandbox === "boolean")
        effectiveProfile.codex.bypassApprovalsAndSandbox = o.bypassApprovalsAndSandbox;
      if (typeof o.search === "boolean") effectiveProfile.codex.search = o.search;
      if (typeof o.noAltScreen === "boolean") effectiveProfile.codex.noAltScreen = o.noAltScreen;
      const mergedDirs = [...(effectiveProfile.codex.addDir ?? []), ...readDirs(o.addDir)];
      const vd = validateDirsOr400(mergedDirs);
      if (!vd.ok) return vd.resp;
      effectiveProfile.codex.addDir = vd.dirs;

      if (effectiveProfile.codex.sandbox && !caps.codex.sandboxModes.includes(effectiveProfile.codex.sandbox)) {
        return reply.code(400).send({ error: "unsupported", field: "codex.sandbox", value: effectiveProfile.codex.sandbox });
      }
      if (
        effectiveProfile.codex.askForApproval &&
        !caps.codex.approvalPolicies.includes(effectiveProfile.codex.askForApproval)
      ) {
        return reply
          .code(400)
          .send({ error: "unsupported", field: "codex.askForApproval", value: effectiveProfile.codex.askForApproval });
      }
      if (typeof effectiveProfile.codex.noAltScreen === "boolean" && effectiveProfile.codex.noAltScreen) {
        if (!caps.codex.supports.noAltScreen) {
          return reply.code(400).send({ error: "unsupported", field: "codex.noAltScreen", value: true });
        }
      }
      const codexModel = toNonEmpty(effectiveProfile.codex.model);
      if (codexModel) {
        if (!caps.codex.supports.model) {
          return reply.code(400).send({ error: "unsupported", field: "codex.model", value: codexModel });
        }
        effectiveProfile.codex.model = codexModel;
      } else {
        delete effectiveProfile.codex.model;
      }
    }

    if (tool === "claude") {
      effectiveProfile.claude = effectiveProfile.claude ?? {};
      const o = overrides?.claude ?? {};
      if (typeof o.permissionMode === "string") effectiveProfile.claude.permissionMode = o.permissionMode;
      if (typeof o.dangerouslySkipPermissions === "boolean")
        effectiveProfile.claude.dangerouslySkipPermissions = o.dangerouslySkipPermissions;
      if (typeof o.model === "string") effectiveProfile.claude.model = o.model;
      const overrideAuthMode = toClaudeAuthMode(o.authMode);
      if (overrideAuthMode) effectiveProfile.claude.authMode = overrideAuthMode;
      const mergedDirs = [...(effectiveProfile.claude.addDir ?? []), ...readDirs(o.addDir)];
      const vd = validateDirsOr400(mergedDirs);
      if (!vd.ok) return vd.resp;
      effectiveProfile.claude.addDir = vd.dirs;

      if (
        effectiveProfile.claude.permissionMode &&
        caps.claude.permissionModes.length > 0 &&
        !caps.claude.permissionModes.includes(effectiveProfile.claude.permissionMode)
      ) {
        return reply
          .code(400)
          .send({ error: "unsupported", field: "claude.permissionMode", value: effectiveProfile.claude.permissionMode });
      }
      const claudeModel = toNonEmpty(effectiveProfile.claude.model);
      if (claudeModel) {
        if (!caps.claude.supports.model) {
          return reply.code(400).send({ error: "unsupported", field: "claude.model", value: claudeModel });
        }
        effectiveProfile.claude.model = claudeModel;
      } else {
        delete effectiveProfile.claude.model;
      }
      const authMode = toClaudeAuthMode(effectiveProfile.claude.authMode);
      if (authMode) effectiveProfile.claude.authMode = authMode;
      else delete effectiveProfile.claude.authMode;
    }

    if (tool === "opencode") {
      effectiveProfile.opencode = effectiveProfile.opencode ?? {};
      const o = overrides?.opencode ?? {};
      if (typeof o.model === "string") effectiveProfile.opencode.model = o.model;
      if (typeof o.agent === "string") effectiveProfile.opencode.agent = o.agent;
      if (typeof o.prompt === "string") effectiveProfile.opencode.prompt = o.prompt;
      if (typeof o.continue === "boolean") effectiveProfile.opencode.continue = o.continue;
      if (typeof o.session === "string") effectiveProfile.opencode.session = o.session;
      if (typeof o.fork === "boolean") effectiveProfile.opencode.fork = o.fork;
      if (typeof o.hostname === "string") effectiveProfile.opencode.hostname = o.hostname;
      if (typeof o.port === "number") effectiveProfile.opencode.port = o.port;
    }

    // If no tool session is linked yet, Claude benefits from deterministic IDs so history can be loaded later.
    let toolSessionIdForStore: string | null = storedToolSessionId || null;
    if (!wantsToolSession && tool === "claude" && !toolSessionIdForStore) toolSessionIdForStore = randomUUID();

    if (wantsToolSession && tool === "opencode") {
      effectiveProfile.opencode = effectiveProfile.opencode ?? {};
      effectiveProfile.opencode.session = toolSessionId;
      effectiveProfile.opencode.continue = false;
      effectiveProfile.opencode.fork = inferredAction === "fork";
      toolSessionIdForStore = toolSessionId;
    }

    const built = buildArgsForSession({
      tool,
      baseArgs: [],
      profile: effectiveProfile,
      cwd,
    });
    const codexExcludedAtRestart =
      tool === "codex" && !toolSessionIdForStore && cwd ? snapshotCodexSessionIds(cwd) : null;
    const opencodeExcludedAtRestart =
      tool === "opencode" && !toolSessionIdForStore && cwd ? await snapshotOpenCodeSessionIds(cwd) : null;

    if (wantsToolSession) {
      if (tool === "codex") built.args = [inferredAction!, toolSessionId, ...built.args];
      if (tool === "claude") {
        built.args.push("--resume", toolSessionId);
        if (inferredAction === "fork") built.args.push("--fork-session");
      }
    } else if (tool === "claude" && toolSessionIdForStore) {
      built.args.push("--session-id", toolSessionIdForStore);
    }

    // OpenCode supports a positional "project" path. Use cwd if provided.
    if (tool === "opencode" && cwd) built.args.unshift(cwd);

    // Claude Code: install PermissionRequest hook (session-local via --settings) so approvals show in Inbox.
    if (tool === "claude" && claudeHooksEnabled && caps.claude.supports.settings) {
      const scriptPath = ensureClaudePermissionHookScript();
      if (scriptPath) {
        const hookKey = nanoid(32);
        claudeHookSessions.set(id, { key: hookKey });
        extraEnv.FYP_HOOK_BASE_URL = hookBaseUrl;
        extraEnv.FYP_HOOK_KEY = hookKey;
        extraEnv.FYP_SESSION_ID = id;
        const cmd = `${shQuote(process.execPath)} ${shQuote(scriptPath)}`;
        const settings = {
          hooks: {
            PermissionRequest: [
              {
                matcher: "*",
                hooks: [{ type: "command", command: cmd, timeout: 600 }],
              },
            ],
          },
        };
        built.args.push("--settings", JSON.stringify(settings));
      }
    }

    // Best-effort: clear transient buffers so old TUI fragments don't produce stale overlays.
    cleanupSessionTransientState(id);
    // Ensure any previous PTY handle is released before respawn.
    sessions.forget(id);

    const claudeAuthMode = tool === "claude" ? resolveClaudeAuthMode(effectiveProfile?.claude) : undefined;
    try {
      sessions.createSession({
        id,
        tool,
        profileId,
        cwd,
        extraArgs: built.args,
        env: extraEnv,
        claudeAuthMode,
      });
    } catch (e: any) {
      claudeHookSessions.delete(id);
      return reply.code(400).send({
        error: "spawn_failed",
        message: typeof e?.message === "string" ? e.message : "failed to spawn tool",
      });
    }

    attachBroadcast(id, tool);
    attachExitTracking(id);

    // Reset exit metadata now that a new run started.
    try {
      store.setSessionExit(id, null, null);
      if (toolSessionIdForStore && toolSessionIdForStore !== storedToolSessionId) store.setSessionToolSessionId(id, toolSessionIdForStore);
    } catch {
      // ignore
    }

    if (tool === "codex" && !toolSessionIdForStore && cwd) {
      if (codexExcludedAtRestart) codexLinkExcludedIds.set(id, codexExcludedAtRestart);
      scheduleCodexToolSessionLink(id, cwd, Date.now(), { excludedIds: codexExcludedAtRestart ?? undefined });
    }
    if (tool === "opencode" && !toolSessionIdForStore && cwd) {
      if (opencodeExcludedAtRestart) opencodeLinkExcludedIds.set(id, opencodeExcludedAtRestart);
      scheduleOpenCodeToolSessionLink(id, cwd, Date.now(), { excludedIds: opencodeExcludedAtRestart ?? undefined });
    }

    const evId = store.appendEvent(id, "session.restart", {
      tool,
      profileId,
      cwd: cwd ?? null,
      toolAction: wantsToolSession ? inferredAction : null,
      toolSessionId: wantsToolSession ? toolSessionId : toolSessionIdForStore,
      args: built.args,
      notes: built.notes,
      overrides: overrides ?? {},
    });
    if (evId !== -1) {
      broadcastEvent(id, { id: evId, ts: Date.now(), kind: "session.restart", data: { tool, profileId, cwd: cwd ?? null } });
    }
    notifySessionSockets(id, { type: "session.restarted", ts: Date.now() });
    broadcastGlobal({ type: "sessions.changed" });
    broadcastGlobal({ type: "workspaces.changed" });

    return { ok: true };
  });

  app.post("/api/sessions/:id/interrupt", async (req, reply) => {
    const id = (req.params as any).id as string;
    if (closingSessions.has(id)) return reply.code(409).send({ error: "session_closing" });
    const sess = store.getSession(id);
    if (!sess) return reply.code(404).send({ error: "not found" });
    const evId = store.appendEvent(id, "interrupt", {});
    broadcastEvent(id, { id: evId, ts: Date.now(), kind: "interrupt", data: {} });
    const transport = sessionTransport(sess);
    if (transport === "codex-app-server" && sess.tool === "codex") {
      const threadId = sess.toolSessionId ? String(sess.toolSessionId) : "";
      const turnId = threadId ? codexNativeThreadRun.get(threadId)?.turnId ?? null : null;
      if (threadId && turnId) {
        try {
          await codexApp.ensureStarted();
          await codexApp.call("turn/interrupt", { threadId, turnId });
        } catch {
          // ignore
        }
      }
    } else {
      sessions.interrupt(id);
    }
    return { ok: true, event: { id: evId, ts: Date.now(), kind: "interrupt", data: {} } };
  });

  app.post("/api/sessions/:id/stop", async (req, reply) => {
    const id = (req.params as any).id as string;
    if (closingSessions.has(id)) return reply.code(409).send({ error: "session_closing" });
    const sess = store.getSession(id);
    if (!sess) return reply.code(404).send({ error: "not found" });
    const evId = store.appendEvent(id, "stop", {});
    broadcastEvent(id, { id: evId, ts: Date.now(), kind: "stop", data: {} });
    const transport = sessionTransport(sess);
    if (transport === "codex-app-server" && sess.tool === "codex") {
      const threadId = sess.toolSessionId ? String(sess.toolSessionId) : "";
      const turnId = threadId ? codexNativeThreadRun.get(threadId)?.turnId ?? null : null;
      if (threadId && turnId) {
        try {
          await codexApp.ensureStarted();
          await codexApp.call("turn/interrupt", { threadId, turnId });
        } catch {
          // ignore
        }
      }
    } else {
      sessions.stop(id);
    }
    return { ok: true, event: { id: evId, ts: Date.now(), kind: "stop", data: {} } };
  });

  app.post("/api/sessions/:id/kill", async (req, reply) => {
    const id = (req.params as any).id as string;
    if (closingSessions.has(id)) return reply.code(409).send({ error: "session_closing" });
    const sess = store.getSession(id);
    if (!sess) return reply.code(404).send({ error: "not found" });
    const evId = store.appendEvent(id, "kill", {});
    broadcastEvent(id, { id: evId, ts: Date.now(), kind: "kill", data: {} });
    const transport = sessionTransport(sess);
    if (transport === "codex-app-server" && sess.tool === "codex") {
      const threadId = sess.toolSessionId ? String(sess.toolSessionId) : "";
      const turnId = threadId ? codexNativeThreadRun.get(threadId)?.turnId ?? null : null;
      if (threadId && turnId) {
        try {
          await codexApp.ensureStarted();
          await codexApp.call("turn/interrupt", { threadId, turnId });
        } catch {
          // ignore
        }
      }
    } else {
      sessions.kill(id);
    }
    return { ok: true, event: { id: evId, ts: Date.now(), kind: "kill", data: {} } };
  });

  app.post("/api/sessions/:id/resize", async (req, reply) => {
    const id = (req.params as any).id as string;
    const body = (req.body ?? {}) as any;
    const colsRaw = Number(body.cols);
    const rowsRaw = Number(body.rows);
    if (closingSessions.has(id)) return reply.code(409).send({ error: "session_closing" });
    const sess = store.getSession(id);
    if (!sess) return reply.code(404).send({ error: "not found" });
    const cols = Math.floor(colsRaw);
    const rows = Math.floor(rowsRaw);
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return reply.code(400).send({ error: "invalid_size" });
    if (cols < 12 || rows < 6) return reply.code(400).send({ error: "invalid_size" });
    const transport = sessionTransport(sess);
    if (transport === "pty") sessions.resize(id, Math.min(400, cols), Math.min(220, rows));
    return { ok: true };
  });

  app.get("/api/sessions/:id/transcript", async (req, reply) => {
    const id = (req.params as any).id as string;
    if (!store.getSession(id)) return reply.code(404).send({ error: "not found" });
    flushOutput(id);
    const q = req.query as any;
    const limit = Math.min(2000, Math.max(50, Number(q?.limit ?? 400)));
    const cursor = Number.isFinite(Number(q?.cursor)) ? Number(q.cursor) : null;
    return store.getTranscript(id, { limit, cursor });
  });

  app.get("/api/sessions/:id/events", async (req, reply) => {
    const id = (req.params as any).id as string;
    if (!store.getSession(id)) return reply.code(404).send({ error: "not found" });
    const q = req.query as any;
    const limit = Math.min(500, Math.max(20, Number(q?.limit ?? 120)));
    const cursor = Number.isFinite(Number(q?.cursor)) ? Number(q.cursor) : null;
    return store.getEvents(id, { limit, cursor });
  });

  app.get("/ws/sessions/:id", { websocket: true }, (socket: WebSocket, req) => {
    const id = (req.params as any).id as string;
    const openSess = store.getSession(id);
    if (!openSess || closingSessions.has(id)) {
      try {
        socket.close();
      } catch {
        // ignore
      }
      return;
    }

    const set = sockets.get(id) ?? new Set<WebSocket>();
    set.add(socket);
    sockets.set(id, set);
    log("ws session open", { sessionId: id, ip: (req as any).ip ?? null });
    wsLog("session open", id);
    socket.on("error", (err: any) => wsLog("session error", id, String(err?.message ?? err)));
    socket.on("close", (code: number, reason: any) =>
      wsLog("session close", id, code, reason && typeof reason.toString === "function" ? reason.toString() : ""),
    );

    // Send a small replay for instant context.
    flushOutput(id);
    const replay = store.getTranscript(id, { limit: 400, cursor: null });
    for (const item of replay.items) wsSend(socket, { type: "output", chunk: item.chunk, ts: item.ts });
    const evReplay = store.getEvents(id, { limit: 120, cursor: null });
    for (const e of evReplay.items) wsSend(socket, { type: "event", event: e });
    const assist = assistState.get(id)?.assist ?? null;
    wsSend(socket, { type: "assist", assist, ts: Date.now() });

    socket.on("message", (raw: any) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg?.type === "ping") {
          wsSend(socket, { type: "pong", ts: Date.now(), clientTs: Number(msg.ts ?? 0) || null });
          return;
        }
        if (closingSessions.has(id)) {
          wsSend(socket, { type: "session.closing", ts: Date.now() });
          return;
        }
        const sess = store.getSession(id);
        if (!sess) {
          wsSend(socket, { type: "session.closed", ts: Date.now() });
          try {
            socket.close();
          } catch {
            // ignore
          }
          return;
        }
        const transport = sessionTransport(sess);
        if (msg?.type === "input" && typeof msg.text === "string") {
          const evId = store.appendEvent(id, "input", { text: msg.text });
          broadcastEvent(id, { id: evId, ts: Date.now(), kind: "input", data: { text: msg.text } });
          if (transport === "codex-app-server" && sess.tool === "codex") {
            const threadId = sess.toolSessionId ? String(sess.toolSessionId) : "";
            if (threadId) codexNativeThreadToSession.set(threadId, id);
            let cleaned = String(msg.text ?? "");
            if (cleaned.endsWith("\r\n")) cleaned = cleaned.slice(0, -2);
            else if (cleaned.endsWith("\r")) cleaned = cleaned.slice(0, -1);
            const wantsPlan = String(sess.profileId ?? "").toLowerCase().includes("plan");
            const meta = threadId ? codexNativeThreadMeta.get(threadId) ?? null : null;
            const collaborationMode =
              wantsPlan && meta?.model
                ? { mode: "plan", settings: { model: meta.model, reasoning_effort: null, developer_instructions: null } }
                : null;
            void (async () => {
              if (!threadId) return;
              try {
                await codexApp.ensureStarted();
                const r: any = await codexApp.call("turn/start", {
                  threadId,
                  input: [{ type: "text", text: cleaned, text_elements: [] }],
                  collaborationMode,
                });
                const turnId = typeof r?.turn?.id === "string" ? String(r.turn.id) : null;
                codexNativeThreadRun.set(threadId, { running: true, turnId });
                broadcastGlobal({ type: "sessions.changed" });
                broadcastGlobal({ type: "workspaces.changed" });
              } catch (e: any) {
                wsSend(socket, {
                  type: "input.error",
                  message: String(e?.message ?? "failed to send input"),
                  ts: Date.now(),
                });
              }
            })();
          } else {
            const st = sessions.getStatus(id);
            if (!st || !st.running) {
              wsSend(socket, { type: "session.stopped", ts: Date.now() });
              return;
            }
            sessions.write(id, msg.text);
            try {
              if (sess.tool === "codex" && !sess.toolSessionId && sess.cwd) {
                scheduleCodexToolSessionLink(id, sess.cwd, Date.now(), { excludedIds: getCodexLinkExcludedIds(id) });
              }
              if (sess.tool === "opencode" && !sess.toolSessionId && sess.cwd) {
                scheduleOpenCodeToolSessionLink(id, sess.cwd, Date.now(), { excludedIds: getOpenCodeLinkExcludedIds(id) });
              }
            } catch {
              // ignore
            }
          }
        }
        if (msg?.type === "resize") {
          const cols = Math.floor(Number((msg as any).cols));
          const rows = Math.floor(Number((msg as any).rows));
          if (Number.isFinite(cols) && Number.isFinite(rows) && cols >= 12 && rows >= 6) {
            if (transport === "pty") sessions.resize(id, Math.min(400, cols), Math.min(220, rows));
          }
        }
        if (msg?.type === "interrupt") {
          const evId = store.appendEvent(id, "interrupt", {});
          broadcastEvent(id, { id: evId, ts: Date.now(), kind: "interrupt", data: {} });
          if (transport === "codex-app-server" && sess.tool === "codex") {
            const threadId = sess.toolSessionId ? String(sess.toolSessionId) : "";
            const turnId = threadId ? codexNativeThreadRun.get(threadId)?.turnId ?? null : null;
            if (threadId && turnId) {
              void (async () => {
                try {
                  await codexApp.ensureStarted();
                  await codexApp.call("turn/interrupt", { threadId, turnId });
                } catch {
                  // ignore
                }
              })();
            }
          } else {
            sessions.interrupt(id);
          }
        }
        if (msg?.type === "stop") {
          const evId = store.appendEvent(id, "stop", {});
          broadcastEvent(id, { id: evId, ts: Date.now(), kind: "stop", data: {} });
          if (transport === "codex-app-server" && sess.tool === "codex") {
            const threadId = sess.toolSessionId ? String(sess.toolSessionId) : "";
            const turnId = threadId ? codexNativeThreadRun.get(threadId)?.turnId ?? null : null;
            if (threadId && turnId) {
              void (async () => {
                try {
                  await codexApp.ensureStarted();
                  await codexApp.call("turn/interrupt", { threadId, turnId });
                } catch {
                  // ignore
                }
              })();
            }
          } else {
            sessions.stop(id);
          }
        }
        if (msg?.type === "kill") {
          const evId = store.appendEvent(id, "kill", {});
          broadcastEvent(id, { id: evId, ts: Date.now(), kind: "kill", data: {} });
          if (transport === "codex-app-server" && sess.tool === "codex") {
            const threadId = sess.toolSessionId ? String(sess.toolSessionId) : "";
            const turnId = threadId ? codexNativeThreadRun.get(threadId)?.turnId ?? null : null;
            if (threadId && turnId) {
              void (async () => {
                try {
                  await codexApp.ensureStarted();
                  await codexApp.call("turn/interrupt", { threadId, turnId });
                } catch {
                  // ignore
                }
              })();
            }
          } else {
            sessions.kill(id);
          }
        }
      } catch {
        // ignore
      }
    });

    socket.on("close", () => {
      const s = sockets.get(id);
      if (!s) return;
      s.delete(socket);
      if (s.size === 0) sockets.delete(id);
      log("ws session close", { sessionId: id, ip: (req as any).ip ?? null });
    });
  });

  app.get("/ws/global", { websocket: true }, (socket: WebSocket) => {
    wsLog("global open");
    globalSockets.add(socket);
    log("ws global open");
    socket.on("error", (err: any) => wsLog("global error", String(err?.message ?? err)));
    // Lightweight initial sync. UI can fetch details via HTTP.
    wsSend(socket, { type: "sessions.changed" });
    wsSend(socket, { type: "workspaces.changed" });
    wsSend(socket, { type: "inbox.changed" });
    wsSend(socket, { type: "tasks.changed" });
    socket.on("message", (raw: any) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg?.type === "ping") wsSend(socket, { type: "pong", ts: Date.now(), clientTs: Number(msg.ts ?? 0) || null });
      } catch {
        // ignore
      }
    });
    socket.on("close", () => {
      wsLog("global close");
      globalSockets.delete(socket);
      log("ws global close");
    });
  });

  app.addHook("onClose", async () => {
    try {
      clearInterval(orchestrationSyncTicker);
    } catch {
      // ignore
    }
    for (const tm of orchestrationQuestionBatchTimers.values()) {
      try {
        clearTimeout(tm);
      } catch {
        // ignore
      }
    }
    orchestrationQuestionBatchTimers.clear();
    for (const tm of orchestrationQuestionTimeoutTimers.values()) {
      try {
        clearTimeout(tm);
      } catch {
        // ignore
      }
    }
    orchestrationQuestionTimeoutTimers.clear();
    for (const tm of orchestrationWorkerSignalTimers.values()) {
      try {
        clearTimeout(tm);
      } catch {
        // ignore
      }
    }
    orchestrationWorkerSignalTimers.clear();
    orchestrationWorkerSignalLastSentAt.clear();
    for (const sid of outputBuf.keys()) flushOutput(sid);
    try {
      codexApp.stop();
    } catch {
      // ignore
    }
    sessions.dispose();
    store.close();
  });

  return app;
}

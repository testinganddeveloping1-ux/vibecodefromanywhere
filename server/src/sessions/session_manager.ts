import type { IPty } from "node-pty";
import pty from "node-pty";
import { nanoid } from "nanoid";

let ptyWriteNoiseFilterInstalled = false;

function installPtyWriteNoiseFilter() {
  if (ptyWriteNoiseFilterInstalled) return;
  ptyWriteNoiseFilterInstalled = true;
  const orig = console.error.bind(console);
  console.error = (...args: any[]) => {
    const head = String(args?.[0] ?? "");
    const err = args?.[1] as any;
    const code = String(err?.code ?? "");
    if (head === "Unhandled pty write error" && (code === "EBADF" || code === "EIO" || code === "ECONNRESET")) {
      return;
    }
    orig(...args);
  };
}

export type ToolId = "codex" | "claude" | "opencode";

export type ToolCommand = {
  command: string;
  args: string[];
};

export type SessionStatus = {
  running: boolean;
  pid: number | null;
  exitCode: number | null;
  signal: number | null;
};

export type Session = {
  id: string;
  tool: ToolId;
  profileId: string;
  pty: IPty;
  codexSubmitWithTab: boolean;
  status: SessionStatus;
  outputListeners: Set<(chunk: string) => void>;
  exitListeners: Set<(status: SessionStatus) => void>;
};

export type SessionManagerOptions = {
  token: string;
  tools: Record<ToolId, ToolCommand>;
  cwd?: string;
};

export class SessionManager {
  private sessions = new Map<string, Session>();
  private closingSessions = new Set<string>();
  // Codex requires CR then (later) LF to reliably submit prompts. We serialize these
  // writes per-session so interleaved HTTP/WS inputs can't reorder the synthetic LF.
  private codexWriteQueues = new Map<string, { draining: boolean; queue: string[] }>();
  private codexSubmitWithTabDefault: boolean;
  private opts: SessionManagerOptions;

  constructor(opts: SessionManagerOptions) {
    this.opts = opts;
    const raw = String(process.env.FYP_CODEX_SUBMIT_WITH_TAB ?? "").trim().toLowerCase();
    this.codexSubmitWithTabDefault = raw === "" ? true : !(raw === "0" || raw === "false" || raw === "no");
    installPtyWriteNoiseFilter();
  }

  createSession(input: {
    id?: string;
    tool: ToolId;
    profileId: string;
    cwd?: string;
    extraArgs?: string[];
    env?: Record<string, string>;
    claudeAuthMode?: "subscription" | "api";
  }): string {
    const id = input.id ?? nanoid(12);
    if (this.sessions.has(id)) throw new Error(`session already exists: ${id}`);
    const tool = input.tool;
    const spec = this.opts.tools[tool];
    const args = [...spec.args, ...(input.extraArgs ?? [])];

    const inheritedEnv: Record<string, string> = {
      ...(process.env as any),
    };

    // If FYP is launched from inside another agent/tool harness, the parent process may
    // include environment variables that "pin" Codex to a specific thread/session id.
    // That breaks multi-session behavior and tool-session discovery.
    //
    // Important: we only strip these from the inherited env; a user can still explicitly
    // set them via profile env (`profiles.*.env`) if they really want.
    if (tool === "codex") {
      delete (inheritedEnv as any).CODEX_THREAD_ID;
      delete (inheritedEnv as any).CODEX_SESSION_ID;
      delete (inheritedEnv as any).CODEX_CI;
    }

    // Claude defaults to subscription auth mode unless explicitly set to API mode.
    // This avoids accidentally inheriting host-level API/proxy env and charging API billing.
    const claudeAuthMode: "subscription" | "api" =
      tool === "claude" && input.claudeAuthMode === "api" ? "api" : "subscription";
    if (tool === "claude" && claudeAuthMode !== "api") {
      delete (inheritedEnv as any).ANTHROPIC_API_KEY;
      delete (inheritedEnv as any).ANTHROPIC_AUTH_TOKEN;
      delete (inheritedEnv as any).ANTHROPIC_BASE_URL;
      delete (inheritedEnv as any).ANTHROPIC_MODEL;
      delete (inheritedEnv as any).ANTHROPIC_DEFAULT_OPUS_MODEL;
      delete (inheritedEnv as any).ANTHROPIC_DEFAULT_SONNET_MODEL;
      delete (inheritedEnv as any).ANTHROPIC_DEFAULT_HAIKU_MODEL;
      delete (inheritedEnv as any).CLAUDE_CODE_SUBAGENT_MODEL;
      delete (inheritedEnv as any).CLAUDE_CODE_USE_BEDROCK;
      delete (inheritedEnv as any).AWS_BEARER_TOKEN_BEDROCK;
    }

    const env: Record<string, string> = {
      ...inheritedEnv,
      ...(input.env ?? {}),
      TERM: "xterm-256color",
    };

    // Enforce Claude auth mode after merging explicit env overrides.
    if (tool === "claude" && claudeAuthMode !== "api") {
      delete (env as any).ANTHROPIC_API_KEY;
      delete (env as any).ANTHROPIC_AUTH_TOKEN;
      delete (env as any).ANTHROPIC_BASE_URL;
      delete (env as any).ANTHROPIC_MODEL;
      delete (env as any).ANTHROPIC_DEFAULT_OPUS_MODEL;
      delete (env as any).ANTHROPIC_DEFAULT_SONNET_MODEL;
      delete (env as any).ANTHROPIC_DEFAULT_HAIKU_MODEL;
      delete (env as any).CLAUDE_CODE_SUBAGENT_MODEL;
      delete (env as any).CLAUDE_CODE_USE_BEDROCK;
      delete (env as any).AWS_BEARER_TOKEN_BEDROCK;
    }

    const p = pty.spawn(spec.command, args, {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd: input.cwd ?? this.opts.cwd ?? process.cwd(),
      env: {
        ...env,
      },
    });

    const sess: Session = {
      id,
      tool,
      profileId: input.profileId,
      pty: p,
      codexSubmitWithTab: this.codexSubmitWithTabDefault,
      status: { running: true, pid: p.pid ?? null, exitCode: null, signal: null },
      outputListeners: new Set(),
      exitListeners: new Set(),
    };

    p.onData((d) => {
      // Newer Codex terminal UIs can require Tab+Enter for submission.
      // We detect the hint once and switch to that submit mode automatically.
      if (sess.tool === "codex") {
        const plain = String(d ?? "").toLowerCase();
        if (!sess.codexSubmitWithTab && plain.includes("tab to queue message")) {
          sess.codexSubmitWithTab = true;
        }
      }
      for (const fn of sess.outputListeners) fn(d);
    });

    // `node-pty` can emit transport-level errors (EBADF/ECONNRESET) while a PTY is
    // being torn down. Treat them as non-fatal session shutdown noise.
    try {
      (p as any).on?.("error", () => {
        // ignore
      });
    } catch {
      // ignore
    }

    p.onExit((e) => {
      sess.status.running = false;
      sess.status.exitCode = typeof e.exitCode === "number" ? e.exitCode : null;
      sess.status.signal = typeof e.signal === "number" ? e.signal : null;
      for (const fn of sess.exitListeners) fn({ ...sess.status });
    });

    this.sessions.set(id, sess);
    if (tool === "codex") this.codexWriteQueues.set(id, { draining: false, queue: [] });
    return id;
  }

  getStatus(id: string): SessionStatus | null {
    return this.sessions.get(id)?.status ?? null;
  }

  async close(id: string, opts?: { force?: boolean; graceMs?: number }): Promise<{ existed: boolean; wasRunning: boolean }> {
    const sess = this.sessions.get(id);
    if (!sess) return { existed: false, wasRunning: false };

    const force = opts?.force !== false;
    const graceMs = Math.min(10_000, Math.max(100, Number(opts?.graceMs ?? 1400)));
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const waitStopped = async (timeoutMs: number) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const cur = this.sessions.get(id);
        if (!cur || !cur.status.running) return;
        await sleep(40);
      }
    };

    const wasRunning = Boolean(sess.status.running);
    this.closingSessions.add(id);
    try {
      if (sess.status.running) {
        // During shutdown prefer process-level SIGINT and avoid PTY writes to reduce EBADF races.
        this.interrupt(id, { signalOnly: true });
        await waitStopped(graceMs);
      }

      if (force) {
        const cur = this.sessions.get(id);
        if (cur?.status.running) {
          this.kill(id);
          await waitStopped(900);
        }
      }

      // Always forget to clear listeners/queues and release PTY references.
      this.forget(id);
      return { existed: true, wasRunning };
    } finally {
      this.closingSessions.delete(id);
    }
  }

  forget(id: string): void {
    const sess = this.sessions.get(id);
    if (!sess) return;
    try {
      sess.outputListeners.clear();
      sess.exitListeners.clear();
    } catch {
      // ignore
    }
    try {
      sess.pty.kill();
    } catch {
      // ignore
    }
    // Fallback: if PTY kill didn't terminate the process promptly, force-kill by PID.
    try {
      if (sess.status.running && sess.status.pid) process.kill(sess.status.pid, "SIGKILL");
    } catch {
      // ignore
    }
    this.sessions.delete(id);
    this.codexWriteQueues.delete(id);
    this.closingSessions.delete(id);
  }

  onOutput(id: string, fn: (chunk: string) => void): () => void {
    const sess = this.must(id);
    sess.outputListeners.add(fn);
    return () => sess.outputListeners.delete(fn);
  }

  onExit(id: string, fn: (status: SessionStatus) => void): () => void {
    const sess = this.must(id);
    sess.exitListeners.add(fn);
    return () => sess.exitListeners.delete(fn);
  }

  write(id: string, data: string): void {
    const sess = this.must(id);
    if (!sess.status.running || this.closingSessions.has(id)) return;
    if (sess.tool !== "codex") {
      try {
        sess.pty.write(String(data ?? ""));
      } catch {
        // Session may have just exited/closed between routing and write.
        // Ignore to avoid noisy unhandled EBADF/EIO races.
      }
      return;
    }

    const rec = this.codexWriteQueues.get(id);
    if (!rec) {
      // Shouldn't happen, but don't crash if the queue was GC'd for some reason.
      try {
        sess.pty.write(String(data ?? ""));
      } catch {
        // Ignore short race windows while session is tearing down.
      }
      return;
    }
    rec.queue.push(String(data ?? ""));
    if (rec.draining) return;
    rec.draining = true;
    void this.drainCodexWrites(id);
  }

  resize(id: string, cols: number, rows: number): void {
    this.must(id).pty.resize(cols, rows);
  }

  interrupt(id: string, opts?: { signalOnly?: boolean }): void {
    const sess = this.must(id);
    if (!sess.status.running) return;
    const signalOnly = opts?.signalOnly === true;

    // Default interactive behavior: write ^C first (what a real terminal does).
    // Some TUIs disable ISIG (raw mode) though, so ^C may become just input instead of SIGINT.
    if (!signalOnly) {
      try {
        sess.pty.write("\u0003");
      } catch {
        // ignore
      }
    }

    // Second (fallback): if it's still running shortly after, send SIGINT to the child PID.
    // Delaying avoids duplicate signals in normal interactive mode. For signal-only shutdown
    // path, dispatch immediately to avoid PTY write races while descriptors are closing.
    const pid = sess.status.pid;
    setTimeout(() => {
      if (!sess.status.running) return;
      try {
        if (pid) process.kill(pid, "SIGINT");
      } catch {
        // ignore
      }
    }, signalOnly ? 0 : 80).unref?.();
  }

  stop(id: string): void {
    // SIGTERM isn't available on node-pty reliably cross-platform; Ctrl+C is the closest.
    this.interrupt(id);
  }

  kill(id: string): void {
    const sess = this.must(id);
    try {
      if (sess.status.pid) process.kill(sess.status.pid, "SIGKILL");
    } catch {
      // ignore
    }
  }

  dispose(): void {
    for (const s of this.sessions.values()) {
      try {
        s.pty.kill();
      } catch {
        // ignore
      }
    }
    this.sessions.clear();
    this.codexWriteQueues.clear();
    this.closingSessions.clear();
  }

  private must(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`unknown session: ${id}`);
    return s;
  }

  private async drainCodexWrites(id: string) {
    const rec = this.codexWriteQueues.get(id);
    if (!rec) return;

    // Codex is sensitive to very-fast "type+enter" sequences delivered as one stream chunk.
    // We add tiny delays so the TUI reliably treats this as a real keypress sequence:
    // - type text
    // - press Enter (CR)
    // - linefeed (LF) shortly after
    const textToCrDelayMs = 15;
    const tabToCrDelayMs = 20;
    const crToLfDelayMs = 25;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const safeWrite = (sess: Session, data: string): boolean => {
      if (!sess.status.running || this.closingSessions.has(id)) return false;
      try {
        sess.pty.write(data);
        return true;
      } catch {
        return false;
      }
    };

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const sess = this.sessions.get(id);
        if (!sess || !sess.status.running || this.closingSessions.has(id)) break;
        const next = rec.queue.shift();
        if (next == null) break;

        const s = String(next);
        if (!s) continue;

        let i = 0;
        while (i < s.length) {
          const j = s.indexOf("\r", i);
          if (j === -1) {
            const tail = s.slice(i);
            if (tail && !safeWrite(sess, tail)) break;
            break;
          }

          const head = s.slice(i, j);
          if (head && !safeWrite(sess, head)) break;

          // Enter key: CR then LF (separate writes, with tiny delays).
          // In "tab to queue message" mode, submit with Tab then Enter.
          // Give the TUI a beat to process the typed text before Enter.
          if (head) await sleep(textToCrDelayMs);
          if (sess.codexSubmitWithTab) {
            if (!safeWrite(sess, "\t")) break;
            await sleep(tabToCrDelayMs);
          }
          if (!safeWrite(sess, "\r")) break;
          await sleep(crToLfDelayMs);

          const cur = this.sessions.get(id);
          if (!cur || !cur.status.running) break;
          if (!safeWrite(cur, "\n")) break;

          i = j + 1;
          // If caller already sent CRLF, skip the LF to avoid doubling.
          if (s[i] === "\n") i += 1;
        }
      }
    } finally {
      const cur = this.codexWriteQueues.get(id);
      if (cur) cur.draining = false;
      const sess = this.sessions.get(id);
      // If new items arrived while we were finishing up, drain again.
      const again = this.codexWriteQueues.get(id);
      if (
        again &&
        again.queue.length > 0 &&
        !again.draining &&
        sess?.status.running &&
        !this.closingSessions.has(id)
      ) {
        again.draining = true;
        void this.drainCodexWrites(id);
      } else if (again && (!sess || !sess.status.running || this.closingSessions.has(id))) {
        again.queue.length = 0;
      }
    }
  }
}

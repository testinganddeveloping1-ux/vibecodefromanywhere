import type { IPty } from "node-pty";
import pty from "node-pty";
import { nanoid } from "nanoid";

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
  // Codex requires CR then (later) LF to reliably submit prompts. We serialize these
  // writes per-session so interleaved HTTP/WS inputs can't reorder the synthetic LF.
  private codexWriteQueues = new Map<string, { draining: boolean; queue: string[] }>();
  private opts: SessionManagerOptions;

  constructor(opts: SessionManagerOptions) {
    this.opts = opts;
  }

  createSession(input: { id?: string; tool: ToolId; profileId: string; cwd?: string; extraArgs?: string[]; env?: Record<string, string> }): string {
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

    const env: Record<string, string> = {
      ...inheritedEnv,
      ...(input.env ?? {}),
      TERM: "xterm-256color",
    };

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
      status: { running: true, pid: p.pid ?? null, exitCode: null, signal: null },
      outputListeners: new Set(),
      exitListeners: new Set(),
    };

    p.onData((d) => {
      for (const fn of sess.outputListeners) fn(d);
    });

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
    this.sessions.delete(id);
    this.codexWriteQueues.delete(id);
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
    if (sess.tool !== "codex") {
      sess.pty.write(data);
      return;
    }

    const rec = this.codexWriteQueues.get(id);
    if (!rec) {
      // Shouldn't happen, but don't crash if the queue was GC'd for some reason.
      sess.pty.write(String(data ?? ""));
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

  interrupt(id: string): void {
    const sess = this.must(id);
    if (!sess.status.running) return;

    // First: write ^C (what a real terminal does). This is the least surprising for interactive TUIs.
    // Some TUIs disable ISIG (raw mode) though, so ^C may become just input instead of SIGINT.
    try {
      sess.pty.write("\u0003");
    } catch {
      // ignore
    }

    // Second (fallback): if it's still running shortly after, send SIGINT to the child PID.
    // Delaying avoids EBADF write noise when SIGINT makes the process exit immediately.
    const pid = sess.status.pid;
    setTimeout(() => {
      if (!sess.status.running) return;
      try {
        if (pid) process.kill(pid, "SIGINT");
      } catch {
        // ignore
      }
    }, 80).unref?.();
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
    const crToLfDelayMs = 25;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const sess = this.sessions.get(id);
        if (!sess || !sess.status.running) break;
        const next = rec.queue.shift();
        if (next == null) break;

        const s = String(next);
        if (!s) continue;

        let i = 0;
        while (i < s.length) {
          const j = s.indexOf("\r", i);
          if (j === -1) {
            const tail = s.slice(i);
            if (tail) sess.pty.write(tail);
            break;
          }

          const head = s.slice(i, j);
          if (head) sess.pty.write(head);

          // Enter key: CR then LF (separate writes, with tiny delays).
          // Give the TUI a beat to process the typed text before Enter.
          if (head) await sleep(textToCrDelayMs);
          sess.pty.write("\r");
          await sleep(crToLfDelayMs);

          const cur = this.sessions.get(id);
          if (!cur || !cur.status.running) break;
          cur.pty.write("\n");

          i = j + 1;
          // If caller already sent CRLF, skip the LF to avoid doubling.
          if (s[i] === "\n") i += 1;
        }
      }
    } finally {
      const cur = this.codexWriteQueues.get(id);
      if (cur) cur.draining = false;
      // If new items arrived while we were finishing up, drain again.
      const again = this.codexWriteQueues.get(id);
      if (again && again.queue.length > 0 && !again.draining) {
        again.draining = true;
        void this.drainCodexWrites(id);
      }
    }
  }
}

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

    const p = pty.spawn(spec.command, args, {
      name: "xterm-256color",
      cols: 100,
      rows: 30,
      cwd: input.cwd ?? this.opts.cwd ?? process.cwd(),
      env: {
        ...process.env,
        ...(input.env ?? {}),
        TERM: "xterm-256color",
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
    return id;
  }

  getStatus(id: string): SessionStatus | null {
    return this.sessions.get(id)?.status ?? null;
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
    this.must(id).pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    this.must(id).pty.resize(cols, rows);
  }

  interrupt(id: string): void {
    // Ctrl+C
    this.write(id, "\u0003");
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
  }

  private must(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`unknown session: ${id}`);
    return s;
  }
}

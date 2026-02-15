import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ToolSessionTool = "codex" | "claude";

export type ToolSessionSummary = {
  tool: ToolSessionTool;
  id: string; // tool-native session id (UUID)
  cwd: string; // project/workspace path
  createdAt: number | null;
  updatedAt: number; // ms since epoch
  title: string | null;
  preview: string | null;
  messageCount: number | null;
  gitBranch: string | null;
};

export type ToolSessionMessage = {
  role: "user" | "assistant";
  ts: number;
  text: string;
};

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function isUnderAnyRoot(p: string, roots: string[]): boolean {
  if (roots.length === 0) return true;
  for (const r of roots) {
    const rel = path.relative(r, p);
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return true;
  }
  return false;
}

function readFirstLine(filePath: string, maxBytes = 128 * 1024): string | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.allocUnsafe(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    if (n <= 0) return null;
    const s = buf.subarray(0, n).toString("utf8");
    const idx = s.indexOf("\n");
    return idx >= 0 ? s.slice(0, idx) : s;
  } catch {
    return null;
  } finally {
    try {
      if (fd != null) fs.closeSync(fd);
    } catch {
      // ignore
    }
  }
}

function readTail(filePath: string, maxBytes = 256 * 1024): string {
  let fd: number | null = null;
  try {
    const st = fs.statSync(filePath);
    const size = Number(st.size ?? 0);
    const start = Math.max(0, size - maxBytes);
    const len = Math.max(0, size - start);
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.allocUnsafe(len);
    const n = fs.readSync(fd, buf, 0, len, start);
    if (n <= 0) return "";
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return "";
  } finally {
    try {
      if (fd != null) fs.closeSync(fd);
    } catch {
      // ignore
    }
  }
}

function safeJsonParse(line: string): any | null {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

function takeText(s: string | null | undefined, max = 260): string | null {
  const v = typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
  if (!v) return null;
  return v.length > max ? v.slice(0, Math.max(0, max - 3)) + "..." : v;
}

function extractCodexPreviewFromTail(rawTail: string): { title: string | null; preview: string | null } {
  const lines = rawTail.split("\n").filter(Boolean);
  let lastAssistant: string | null = null;
  let lastUser: string | null = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    const obj = safeJsonParse(lines[i] ?? "");
    if (!obj) continue;

    // Preferred: full message records (response_item -> message -> role).
    if (obj.type === "response_item" && obj.payload?.type === "message") {
      const role = String(obj.payload?.role ?? "");
      if (role !== "assistant" && role !== "user") continue;
      const content = Array.isArray(obj.payload?.content) ? obj.payload.content : [];
      const parts: string[] = [];
      for (const it of content) {
        const t = typeof it?.text === "string" ? it.text : "";
        if (t) parts.push(t);
      }
      const joined = parts.join("").trim();
      if (!joined) continue;
      if (role === "assistant" && !lastAssistant) lastAssistant = joined;
      if (role === "user" && !lastUser) lastUser = joined;
    }

    // Fallback: "user_message" (shorter, but common and easy).
    if (obj.type === "event_msg" && obj.payload?.type === "user_message" && typeof obj.payload?.message === "string") {
      if (!lastUser) lastUser = obj.payload.message;
    }

    if (lastAssistant && lastUser) break;
  }

  const title = takeText(lastUser, 80);
  const preview = takeText(lastAssistant ?? lastUser, 240);
  return { title, preview };
}

function extractClaudeText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const it of content) {
    if (it && typeof it === "object") {
      if (it.type === "text" && typeof it.text === "string") parts.push(it.text);
      // Keep tool_use visible in previews even if there is no text.
      if (it.type === "tool_use" && typeof it.name === "string") {
        const cmd = typeof it.input?.command === "string" ? it.input.command : "";
        parts.push(cmd ? `[${it.name}] ${cmd}` : `[${it.name}]`);
      }
    }
  }
  return parts.join("\n").trim();
}

function extractClaudePreviewFromTail(rawTail: string): { title: string | null; preview: string | null } {
  const lines = rawTail.split("\n").filter(Boolean);
  let lastAssistant: string | null = null;
  let lastUser: string | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const obj = safeJsonParse(lines[i] ?? "");
    if (!obj) continue;
    if ((obj.type === "assistant" || obj.type === "user") && obj.message && typeof obj.message === "object") {
      const role = String(obj.message?.role ?? "");
      const text = extractClaudeText(obj.message?.content);
      if (!text) continue;
      if (role === "assistant" && !lastAssistant) lastAssistant = text;
      if (role === "user" && !lastUser) lastUser = text;
    }
    if (lastAssistant && lastUser) break;
  }
  const title = takeText(lastUser, 80);
  const preview = takeText(lastAssistant ?? lastUser, 240);
  return { title, preview };
}

function isoToMs(v: any): number | null {
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

function walkFiles(dir: string, out: string[], opts?: { maxFiles?: number }) {
  if (opts?.maxFiles && out.length >= opts.maxFiles) return;
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (opts?.maxFiles && out.length >= opts.maxFiles) return;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walkFiles(p, out, opts);
      continue;
    }
    if (ent.isFile() && p.endsWith(".jsonl")) out.push(p);
  }
}

export class ToolSessionIndex {
  private roots: string[];
  private ttlMs: number;
  private lastScanAt = 0;
  private summaries: ToolSessionSummary[] = [];
  private fileByKey = new Map<string, string>(); // `${tool}:${id}` -> filePath

  constructor(opts: { roots: string[]; ttlMs?: number }) {
    this.roots = opts.roots.map((r) => path.resolve(expandHome(r)));
    this.ttlMs = typeof opts.ttlMs === "number" && Number.isFinite(opts.ttlMs) ? Math.max(250, opts.ttlMs) : 2500;
  }

  list(opts?: { refresh?: boolean }): ToolSessionSummary[] {
    this.ensureFresh(Boolean(opts?.refresh));
    return this.summaries.slice();
  }

  get(tool: ToolSessionTool, id: string, opts?: { refresh?: boolean }): ToolSessionSummary | null {
    this.ensureFresh(Boolean(opts?.refresh));
    const key = `${tool}:${id}`;
    const fp = this.fileByKey.get(key);
    if (!fp) return null;
    return this.summaries.find((s) => s.tool === tool && s.id === id) ?? null;
  }

  getMessages(tool: ToolSessionTool, id: string, opts?: { limit?: number; refresh?: boolean }): ToolSessionMessage[] | null {
    this.ensureFresh(Boolean(opts?.refresh));
    const key = `${tool}:${id}`;
    const fp = this.fileByKey.get(key);
    if (!fp) return null;
    const limit = Math.min(400, Math.max(20, Number(opts?.limit ?? 160)));

    if (tool === "codex") return parseCodexMessages(fp, limit);
    if (tool === "claude") return parseClaudeMessages(fp, limit);
    return null;
  }

  private ensureFresh(force: boolean) {
    const now = Date.now();
    if (!force && now - this.lastScanAt < this.ttlMs) return;
    this.lastScanAt = now;
    this.rescan();
  }

  private rescan() {
    const next: ToolSessionSummary[] = [];
    const nextFiles = new Map<string, string>();

    // Codex sessions (jsonl logs)
    const codexBase = path.join(os.homedir(), ".codex", "sessions");
    if (fs.existsSync(codexBase)) {
      const files: string[] = [];
      walkFiles(codexBase, files, { maxFiles: 2000 });
      for (const fp of files) {
        const first = readFirstLine(fp);
        if (!first) continue;
        const obj = safeJsonParse(first);
        if (!obj || obj.type !== "session_meta" || !obj.payload || typeof obj.payload !== "object") continue;
        const id = typeof obj.payload.id === "string" ? obj.payload.id : "";
        const cwd = typeof obj.payload.cwd === "string" ? obj.payload.cwd : "";
        if (!id || !cwd) continue;
        const cwdAbs = path.resolve(expandHome(cwd));
        if (!isUnderAnyRoot(cwdAbs, this.roots)) continue;

        let updatedAt = 0;
        try {
          updatedAt = Math.floor(fs.statSync(fp).mtimeMs);
        } catch {
          updatedAt = Date.now();
        }

        const createdAt = isoToMs(obj.payload.timestamp) ?? isoToMs(obj.timestamp) ?? null;
        const tail = readTail(fp, 256 * 1024);
        const pv = extractCodexPreviewFromTail(tail);
        next.push({
          tool: "codex",
          id,
          cwd: cwdAbs,
          createdAt,
          updatedAt,
          title: pv.title,
          preview: pv.preview,
          messageCount: null,
          gitBranch: null,
        });
        nextFiles.set(`codex:${id}`, fp);
      }
    }

    // Claude sessions via per-project sessions-index.json (fast path)
    const claudeProjects = path.join(os.homedir(), ".claude", "projects");
    if (fs.existsSync(claudeProjects)) {
      let dirs: fs.Dirent[] = [];
      try {
        dirs = fs.readdirSync(claudeProjects, { withFileTypes: true });
      } catch {
        dirs = [];
      }
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        const idxPath = path.join(claudeProjects, d.name, "sessions-index.json");
        if (!fs.existsSync(idxPath)) continue;
        let idx: any = null;
        try {
          idx = JSON.parse(fs.readFileSync(idxPath, "utf8"));
        } catch {
          idx = null;
        }
        const entries = Array.isArray(idx?.entries) ? idx.entries : [];
        for (const e of entries) {
          const id = typeof e?.sessionId === "string" ? e.sessionId : "";
          const fullPath = typeof e?.fullPath === "string" ? e.fullPath : "";
          const projectPath = typeof e?.projectPath === "string" ? e.projectPath : "";
          if (!id || !fullPath || !projectPath) continue;
          const cwdAbs = path.resolve(expandHome(projectPath));
          if (!isUnderAnyRoot(cwdAbs, this.roots)) continue;
          const updatedAt = Number.isFinite(Number(e?.fileMtime)) ? Number(e.fileMtime) : Date.now();
          const createdAt = isoToMs(e?.created) ?? null;
          const title = typeof e?.firstPrompt === "string" ? takeText(e.firstPrompt, 80) : null;
          const messageCount = Number.isFinite(Number(e?.messageCount)) ? Number(e.messageCount) : null;
          const gitBranch = typeof e?.gitBranch === "string" ? e.gitBranch : null;

          let preview: string | null = null;
          try {
            const tail = readTail(fullPath, 256 * 1024);
            preview = extractClaudePreviewFromTail(tail).preview;
          } catch {
            preview = null;
          }

          next.push({
            tool: "claude",
            id,
            cwd: cwdAbs,
            createdAt,
            updatedAt,
            title,
            preview,
            messageCount,
            gitBranch,
          });
          nextFiles.set(`claude:${id}`, fullPath);
        }
      }
    }

    // Sort by recent activity.
    next.sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0));
    this.summaries = next;
    this.fileByKey = nextFiles;
  }
}

function parseCodexMessages(filePath: string, limit: number): ToolSessionMessage[] {
  // For responsiveness we parse the tail first (usually enough for chat history),
  // and only fall back to full-file if we can't extract anything.
  const tail = readTail(filePath, 512 * 1024);
  const parsed = parseCodexMessagesFromText(tail);
  if (parsed.length >= Math.min(40, limit)) return parsed.slice(-limit);

  // Full parse (still reasonable for typical session logs).
  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    raw = tail;
  }
  return parseCodexMessagesFromText(raw).slice(-limit);
}

function parseCodexMessagesFromText(raw: string): ToolSessionMessage[] {
  const out: ToolSessionMessage[] = [];
  const lines = raw.split("\n").filter(Boolean);
  for (const ln of lines) {
    const obj = safeJsonParse(ln);
    if (!obj) continue;
    if (obj.type !== "response_item" || obj.payload?.type !== "message") continue;
    const role = String(obj.payload?.role ?? "");
    if (role !== "user" && role !== "assistant") continue;
    const content = Array.isArray(obj.payload?.content) ? obj.payload.content : [];
    const parts: string[] = [];
    for (const it of content) {
      if (it && typeof it === "object") {
        if (typeof it.text === "string") parts.push(it.text);
      }
    }
    const text = parts.join("").trim();
    if (!text) continue;
    const ts = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : NaN;
    out.push({
      role,
      ts: Number.isFinite(ts) ? ts : Date.now(),
      text,
    });
  }
  return out;
}

function parseClaudeMessages(filePath: string, limit: number): ToolSessionMessage[] {
  const tail = readTail(filePath, 512 * 1024);
  const parsed = parseClaudeMessagesFromText(tail);
  if (parsed.length >= Math.min(40, limit)) return parsed.slice(-limit);

  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    raw = tail;
  }
  return parseClaudeMessagesFromText(raw).slice(-limit);
}

function parseClaudeMessagesFromText(raw: string): ToolSessionMessage[] {
  const out: ToolSessionMessage[] = [];
  const lines = raw.split("\n").filter(Boolean);
  for (const ln of lines) {
    const obj = safeJsonParse(ln);
    if (!obj) continue;
    if (obj.type !== "user" && obj.type !== "assistant") continue;
    if (!obj.message || typeof obj.message !== "object") continue;
    const role = String(obj.message?.role ?? "");
    if (role !== "user" && role !== "assistant") continue;
    const text = extractClaudeText(obj.message?.content);
    if (!text) continue;
    const ts = typeof obj.timestamp === "string" ? Date.parse(obj.timestamp) : NaN;
    out.push({ role, ts: Number.isFinite(ts) ? ts : Date.now(), text });
  }
  return out;
}

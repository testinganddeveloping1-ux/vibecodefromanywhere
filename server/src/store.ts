import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { ToolId } from "./sessions/session_manager.js";

export type StoreSessionRow = {
  id: string;
  tool: ToolId;
  profileId: string;
  toolSessionId: string | null;
  cwd: string | null;
  workspaceKey: string | null;
  workspaceRoot: string | null;
  treePath: string | null;
  label: string | null;
  pinnedSlot: number | null;
  createdAt: number;
  updatedAt: number;
  exitCode: number | null;
  signal: number | null;
};

export type TranscriptItem = { id: number; ts: number; chunk: string };
export type EventItem = { id: number; ts: number; kind: string; data: any };
export type WorkspacePresetRow = { path: string; tool: ToolId; profileId: string; overrides: any; updatedAt: number };
export type AttentionItemRow = {
  id: number;
  sessionId: string;
  ts: number;
  status: "open" | "sent" | "resolved" | "dismissed";
  kind: string;
  severity: "info" | "warn" | "danger";
  title: string;
  body: string;
  signature: string;
  options: any;
};

export type Store = ReturnType<typeof createStore>;

export function createStore(baseDir: string) {
  fs.mkdirSync(baseDir, { recursive: true });
  const dbPath = path.join(baseDir, "data.sqlite");
  const db = new Database(dbPath);

  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      tool TEXT NOT NULL,
      profileId TEXT NOT NULL,
      toolSessionId TEXT,
      cwd TEXT,
      workspaceKey TEXT,
      workspaceRoot TEXT,
      treePath TEXT,
      label TEXT,
      pinnedSlot INTEGER,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      exitCode INTEGER,
      signal INTEGER
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sessionId TEXT NOT NULL,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_sessionId ON events(sessionId, ts);

    CREATE TABLE IF NOT EXISTS output (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sessionId TEXT NOT NULL,
      ts INTEGER NOT NULL,
      chunk TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_output_sessionId ON output(sessionId, id);

    CREATE TABLE IF NOT EXISTS workspace_presets (
      path TEXT NOT NULL,
      tool TEXT NOT NULL,
      profileId TEXT NOT NULL,
      overrides TEXT NOT NULL,
      updatedAt INTEGER NOT NULL,
      PRIMARY KEY(path, tool)
    );

    CREATE TABLE IF NOT EXISTS attention_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sessionId TEXT NOT NULL,
      ts INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      status TEXT NOT NULL,
      kind TEXT NOT NULL,
      severity TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      signature TEXT NOT NULL,
      options TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_attention_session ON attention_items(sessionId, status, updatedAt);
    CREATE INDEX IF NOT EXISTS idx_attention_sig ON attention_items(signature, status);

    CREATE TABLE IF NOT EXISTS attention_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attentionId INTEGER NOT NULL,
      sessionId TEXT NOT NULL,
      ts INTEGER NOT NULL,
      action TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_attention_actions ON attention_actions(attentionId, ts);
  `);

  // Lightweight migrations for older dbs
  const cols = (db.prepare("PRAGMA table_info(sessions)").all() as any[]).map((r) => String(r.name));
  const addCol = (name: string, ddl: string) => {
    if (!cols.includes(name)) db.exec(`ALTER TABLE sessions ADD COLUMN ${ddl}`);
  };
  addCol("toolSessionId", "toolSessionId TEXT");
  addCol("cwd", "cwd TEXT");
  addCol("workspaceKey", "workspaceKey TEXT");
  addCol("workspaceRoot", "workspaceRoot TEXT");
  addCol("treePath", "treePath TEXT");
  addCol("label", "label TEXT");
  addCol("pinnedSlot", "pinnedSlot INTEGER");

  const stmtCreateSession = db.prepare(
    "INSERT INTO sessions (id, tool, profileId, toolSessionId, cwd, workspaceKey, workspaceRoot, treePath, label, pinnedSlot, createdAt, updatedAt, exitCode, signal) VALUES (@id, @tool, @profileId, @toolSessionId, @cwd, @workspaceKey, @workspaceRoot, @treePath, @label, @pinnedSlot, @createdAt, @updatedAt, NULL, NULL)",
  );
  const stmtListSessions = db.prepare("SELECT * FROM sessions ORDER BY createdAt DESC");
  const stmtGetSession = db.prepare("SELECT * FROM sessions WHERE id = ?");
  const stmtTouchSession = db.prepare("UPDATE sessions SET updatedAt = ? WHERE id = ?");
  const stmtSetSessionMeta = db.prepare(
    "UPDATE sessions SET workspaceKey=@workspaceKey, workspaceRoot=@workspaceRoot, treePath=@treePath, label=@label WHERE id=@id",
  );
  const stmtSetSessionToolSessionId = db.prepare("UPDATE sessions SET toolSessionId = ?, updatedAt = ? WHERE id = ?");
  const stmtSetSessionLabel = db.prepare("UPDATE sessions SET label = ?, updatedAt = ? WHERE id = ?");
  const stmtClearPinnedByWorkspaceSlot = db.prepare(
    "UPDATE sessions SET pinnedSlot = NULL, updatedAt = ? WHERE workspaceKey = ? AND pinnedSlot = ? AND id != ?",
  );
  const stmtClearPinnedByCwdSlot = db.prepare(
    "UPDATE sessions SET pinnedSlot = NULL, updatedAt = ? WHERE cwd = ? AND pinnedSlot = ? AND id != ?",
  );
  const stmtSetSessionPinnedSlot = db.prepare("UPDATE sessions SET pinnedSlot = ?, updatedAt = ? WHERE id = ?");
  const stmtSetSessionExit = db.prepare("UPDATE sessions SET exitCode = ?, signal = ?, updatedAt = ? WHERE id = ?");
  const stmtDeleteSession = db.prepare("DELETE FROM sessions WHERE id = ?");
  const stmtEvent = db.prepare("INSERT INTO events (sessionId, ts, kind, data) VALUES (?, ?, ?, ?)");
  const stmtEventsFirst = db.prepare(
    "SELECT id, ts, kind, data FROM events WHERE sessionId = ? ORDER BY id DESC LIMIT ?",
  );
  const stmtEventsAfter = db.prepare(
    "SELECT id, ts, kind, data FROM events WHERE sessionId = ? AND id < ? ORDER BY id DESC LIMIT ?",
  );
  const stmtDeleteEvents = db.prepare("DELETE FROM events WHERE sessionId = ?");
  const stmtOut = db.prepare("INSERT INTO output (sessionId, ts, chunk) VALUES (?, ?, ?)");
  const stmtTranscriptFirst = db.prepare(
    "SELECT id, ts, chunk FROM output WHERE sessionId = ? ORDER BY id DESC LIMIT ?",
  );
  const stmtTranscriptAfter = db.prepare(
    "SELECT id, ts, chunk FROM output WHERE sessionId = ? AND id < ? ORDER BY id DESC LIMIT ?",
  );
  const stmtDeleteOutput = db.prepare("DELETE FROM output WHERE sessionId = ?");
  const stmtRecentWorkspaces = db.prepare(
    `
      SELECT cwd as path, MAX(updatedAt) as lastUsed
      FROM sessions
      WHERE cwd IS NOT NULL AND TRIM(cwd) != ''
      GROUP BY cwd
      ORDER BY lastUsed DESC
      LIMIT ?
    `,
  );

  const stmtGetPreset = db.prepare("SELECT path, tool, profileId, overrides, updatedAt FROM workspace_presets WHERE path = ? AND tool = ?");
  const stmtUpsertPreset = db.prepare(
    "INSERT INTO workspace_presets (path, tool, profileId, overrides, updatedAt) VALUES (?, ?, ?, ?, ?) ON CONFLICT(path, tool) DO UPDATE SET profileId=excluded.profileId, overrides=excluded.overrides, updatedAt=excluded.updatedAt",
  );

  const stmtAttentionInsert = db.prepare(
    "INSERT INTO attention_items (sessionId, ts, updatedAt, status, kind, severity, title, body, signature, options) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const stmtAttentionListOpen = db.prepare(
    "SELECT id, sessionId, ts, status, kind, severity, title, body, signature, options FROM attention_items WHERE status = 'open' ORDER BY updatedAt DESC LIMIT ?",
  );
  const stmtAttentionListOpenByWorkspace = db.prepare(
    `
      SELECT ai.id, ai.sessionId, ai.ts, ai.status, ai.kind, ai.severity, ai.title, ai.body, ai.signature, ai.options
      FROM attention_items ai
      JOIN sessions s ON s.id = ai.sessionId
      WHERE ai.status = 'open' AND s.workspaceKey = ?
      ORDER BY ai.updatedAt DESC
      LIMIT ?
    `,
  );
  const stmtAttentionListOpenByCwd = db.prepare(
    `
      SELECT ai.id, ai.sessionId, ai.ts, ai.status, ai.kind, ai.severity, ai.title, ai.body, ai.signature, ai.options
      FROM attention_items ai
      JOIN sessions s ON s.id = ai.sessionId
      WHERE ai.status = 'open' AND s.cwd = ?
      ORDER BY ai.updatedAt DESC
      LIMIT ?
    `,
  );
  const stmtAttentionListBySession = db.prepare(
    "SELECT id, sessionId, ts, status, kind, severity, title, body, signature, options FROM attention_items WHERE sessionId = ? AND status = 'open' ORDER BY updatedAt DESC LIMIT ?",
  );
  const stmtAttentionGet = db.prepare(
    "SELECT id, sessionId, ts, status, kind, severity, title, body, signature, options FROM attention_items WHERE id = ?",
  );
  const stmtAttentionUpdateStatus = db.prepare("UPDATE attention_items SET status = ?, updatedAt = ? WHERE id = ?");
  const stmtAttentionTouchAndUpdate = db.prepare(
    "UPDATE attention_items SET updatedAt = ?, title = ?, body = ?, options = ? WHERE id = ?",
  );
  const stmtAttentionFindOpenBySig = db.prepare(
    "SELECT id, sessionId, ts, status, kind, severity, title, body, signature, options FROM attention_items WHERE signature = ? AND status = 'open' ORDER BY updatedAt DESC LIMIT 1",
  );
  const stmtAttentionActionInsert = db.prepare(
    "INSERT INTO attention_actions (attentionId, sessionId, ts, action, data) VALUES (?, ?, ?, ?, ?)",
  );
  const stmtDeleteAttentionActionsBySession = db.prepare("DELETE FROM attention_actions WHERE sessionId = ?");
  const stmtAttentionCounts = db.prepare(
    "SELECT sessionId, COUNT(*) as count FROM attention_items WHERE status = 'open' GROUP BY sessionId",
  );
  const stmtDeleteAttentionItemsBySession = db.prepare("DELETE FROM attention_items WHERE sessionId = ?");

  function createSession(input: {
    id: string;
    tool: ToolId;
    profileId: string;
    toolSessionId?: string | null;
    cwd: string | null;
    workspaceKey?: string | null;
    workspaceRoot?: string | null;
    treePath?: string | null;
    label?: string | null;
    pinnedSlot?: number | null;
  }) {
    const now = Date.now();
    stmtCreateSession.run({
      ...input,
      toolSessionId: input.toolSessionId ?? null,
      workspaceKey: input.workspaceKey ?? null,
      workspaceRoot: input.workspaceRoot ?? null,
      treePath: input.treePath ?? null,
      label: input.label ?? null,
      pinnedSlot: input.pinnedSlot ?? null,
      createdAt: now,
      updatedAt: now,
    });
  }

  function listSessions(): StoreSessionRow[] {
    return stmtListSessions.all() as any;
  }

  function getSession(id: string): StoreSessionRow | null {
    const row = stmtGetSession.get(id) as any;
    return row ?? null;
  }

  function setSessionMeta(input: {
    id: string;
    workspaceKey: string | null;
    workspaceRoot: string | null;
    treePath: string | null;
    label: string | null;
  }) {
    stmtSetSessionMeta.run(input as any);
  }

  function setSessionToolSessionId(sessionId: string, toolSessionId: string | null) {
    stmtSetSessionToolSessionId.run(toolSessionId, Date.now(), sessionId);
  }

  function setSessionLabel(sessionId: string, label: string | null) {
    stmtSetSessionLabel.run(label, Date.now(), sessionId);
  }

  function setSessionPinnedSlot(sessionId: string, pinnedSlot: number | null) {
    const now = Date.now();
    // Uniqueness: within a git workspace, each slot can hold only one session.
    if (pinnedSlot != null) {
      const sess = getSession(sessionId);
      const wk = sess?.workspaceKey ?? null;
      if (wk) {
        try {
          stmtClearPinnedByWorkspaceSlot.run(now, wk, pinnedSlot, sessionId);
        } catch {
          // ignore
        }
      } else if (sess?.cwd) {
        try {
          stmtClearPinnedByCwdSlot.run(now, sess.cwd, pinnedSlot, sessionId);
        } catch {
          // ignore
        }
      }
    }
    stmtSetSessionPinnedSlot.run(pinnedSlot, now, sessionId);
  }

  function setSessionExit(sessionId: string, exitCode: number | null, signal: number | null) {
    stmtSetSessionExit.run(exitCode, signal, Date.now(), sessionId);
  }

  const txDeleteSession = db.transaction((sessionId: string) => {
    // Fully remove a FromYourPhone session from the local DB.
    // This does NOT touch tool-native logs (Codex/Claude/OpenCode).
    stmtDeleteAttentionActionsBySession.run(sessionId);
    stmtDeleteAttentionItemsBySession.run(sessionId);
    stmtDeleteEvents.run(sessionId);
    stmtDeleteOutput.run(sessionId);
    stmtDeleteSession.run(sessionId);
  });

  function deleteSession(sessionId: string) {
    txDeleteSession(sessionId);
  }

  function touchSession(sessionId: string) {
    try {
      stmtTouchSession.run(Date.now(), sessionId);
    } catch {
      // ignore
    }
  }

  function appendEvent(sessionId: string, kind: string, data: unknown): number {
    const r = stmtEvent.run(sessionId, Date.now(), kind, JSON.stringify(data ?? {})) as any;
    touchSession(sessionId);
    const id = Number(r?.lastInsertRowid);
    return Number.isFinite(id) ? id : -1;
  }

  function appendOutput(sessionId: string, chunk: string) {
    stmtOut.run(sessionId, Date.now(), chunk);
    touchSession(sessionId);
  }

  function getTranscript(sessionId: string, opts: { limit: number; cursor: number | null }) {
    const rows: TranscriptItem[] = (opts.cursor == null
      ? stmtTranscriptFirst.all(sessionId, opts.limit)
      : stmtTranscriptAfter.all(sessionId, opts.cursor, opts.limit)) as any;

    // Return ascending by time for replay
    rows.reverse();
    const nextCursor = rows.length > 0 ? rows[0]!.id : null;
    return { items: rows, nextCursor };
  }

  function getEvents(sessionId: string, opts: { limit: number; cursor: number | null }) {
    const rows: EventItem[] = (opts.cursor == null
      ? stmtEventsFirst.all(sessionId, opts.limit)
      : stmtEventsAfter.all(sessionId, opts.cursor, opts.limit)) as any;
    rows.reverse();
    const items = rows.map((r) => ({
      ...r,
      data: (() => {
        try {
          return JSON.parse(r.data);
        } catch {
          return {};
        }
      })(),
    }));
    const nextCursor = items.length > 0 ? items[0]!.id : null;
    return { items, nextCursor };
  }

  function listRecentWorkspaces(limit: number): { path: string; lastUsed: number }[] {
    const lim = Math.min(50, Math.max(1, Math.floor(limit || 10)));
    const rows = stmtRecentWorkspaces.all(lim) as any[];
    return rows
      .map((r) => ({ path: String(r.path ?? ""), lastUsed: Number(r.lastUsed ?? 0) }))
      .filter((r) => r.path && Number.isFinite(r.lastUsed));
  }

  function getWorkspacePreset(pathStr: string, tool: ToolId): WorkspacePresetRow | null {
    const r = stmtGetPreset.get(pathStr, tool) as any;
    if (!r) return null;
    let parsed: any = {};
    try {
      parsed = JSON.parse(String(r.overrides ?? "{}"));
    } catch {
      parsed = {};
    }
    return {
      path: String(r.path),
      tool: tool,
      profileId: String(r.profileId),
      overrides: parsed,
      updatedAt: Number(r.updatedAt ?? 0),
    };
  }

  function upsertWorkspacePreset(input: { path: string; tool: ToolId; profileId: string; overrides: any }) {
    const now = Date.now();
    stmtUpsertPreset.run(input.path, input.tool, input.profileId, JSON.stringify(input.overrides ?? {}), now);
  }

  function parseAttentionRow(r: any): AttentionItemRow {
    let options: any = [];
    try {
      options = JSON.parse(String(r.options ?? "[]"));
    } catch {
      options = [];
    }
    return {
      id: Number(r.id),
      sessionId: String(r.sessionId),
      ts: Number(r.ts),
      status: (String(r.status) as any) ?? "open",
      kind: String(r.kind),
      severity: (String(r.severity) as any) ?? "info",
      title: String(r.title),
      body: String(r.body),
      signature: String(r.signature),
      options,
    };
  }

  function createAttentionItem(input: {
    sessionId: string;
    kind: string;
    severity: "info" | "warn" | "danger";
    title: string;
    body: string;
    signature: string;
    options: any;
  }): { ok: true; id: number } | { ok: false; reason: string; existingId?: number } {
    const sig = input.signature;
    try {
      const existing = stmtAttentionFindOpenBySig.get(sig) as any;
      if (existing?.id) {
        // Touch existing instead of duplicating.
        const now = Date.now();
        try {
          stmtAttentionTouchAndUpdate.run(
            now,
            input.title,
            input.body,
            JSON.stringify(input.options ?? []),
            Number(existing.id),
          );
        } catch {
          stmtAttentionUpdateStatus.run("open", now, Number(existing.id));
        }
        return { ok: false, reason: "duplicate", existingId: Number(existing.id) };
      }
    } catch {
      // ignore
    }
    const now = Date.now();
    const r = stmtAttentionInsert.run(
      input.sessionId,
      now,
      now,
      "open",
      input.kind,
      input.severity,
      input.title,
      input.body,
      input.signature,
      JSON.stringify(input.options ?? []),
    ) as any;
    const id = Number(r?.lastInsertRowid);
    return { ok: true, id: Number.isFinite(id) ? id : -1 };
  }

  function listInbox(input: {
    limit: number;
    workspaceKey?: string | null;
    cwd?: string | null;
    sessionId?: string | null;
  }): AttentionItemRow[] {
    const limit = Math.min(500, Math.max(10, Math.floor(input.limit || 120)));
    let rows: any[] = [];
    if (input.sessionId) {
      rows = stmtAttentionListBySession.all(input.sessionId, limit) as any[];
    } else if (input.cwd) {
      rows = stmtAttentionListOpenByCwd.all(input.cwd, limit) as any[];
    } else if (input.workspaceKey) {
      rows = stmtAttentionListOpenByWorkspace.all(input.workspaceKey, limit) as any[];
    } else {
      rows = stmtAttentionListOpen.all(limit) as any[];
    }
    return rows.map(parseAttentionRow);
  }

  function getAttentionItem(id: number): AttentionItemRow | null {
    const r = stmtAttentionGet.get(id) as any;
    return r ? parseAttentionRow(r) : null;
  }

  function setAttentionStatus(id: number, status: AttentionItemRow["status"]) {
    stmtAttentionUpdateStatus.run(status, Date.now(), id);
  }

  function addAttentionAction(input: { attentionId: number; sessionId: string; action: string; data: any }) {
    stmtAttentionActionInsert.run(input.attentionId, input.sessionId, Date.now(), input.action, JSON.stringify(input.data ?? {}));
  }

  function getOpenAttentionCounts(): Record<string, number> {
    const rows = stmtAttentionCounts.all() as any[];
    const out: Record<string, number> = {};
    for (const r of rows) out[String(r.sessionId)] = Number(r.count ?? 0);
    return out;
  }

  function doctor() {
    return {
      ok: true,
      dbPath,
    };
  }

  function close() {
    db.close();
  }

  return {
    createSession,
    deleteSession,
    listSessions,
    getSession,
    setSessionMeta,
    setSessionToolSessionId,
    setSessionLabel,
    setSessionPinnedSlot,
    setSessionExit,
    appendEvent,
    appendOutput,
    getTranscript,
    getEvents,
    listRecentWorkspaces,
    getWorkspacePreset,
    upsertWorkspacePreset,
    createAttentionItem,
    listInbox,
    getAttentionItem,
    setAttentionStatus,
    addAttentionAction,
    getOpenAttentionCounts,
    doctor,
    close,
  };
}

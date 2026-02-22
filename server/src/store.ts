import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { ToolId } from "./sessions/session_manager.js";

export type StoreSessionRow = {
  id: string;
  tool: ToolId;
  profileId: string;
  transport: string;
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

export type OrchestrationRow = {
  id: string;
  name: string;
  projectPath: string;
  orchestratorSessionId: string;
  status: "active" | "cleaning" | "cleaned" | "error";
  lastError: string | null;
  cleanedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type OrchestrationWorkerRow = {
  id: number;
  orchestrationId: string;
  workerIndex: number;
  name: string;
  tool: ToolId;
  profileId: string;
  sessionId: string;
  projectPath: string;
  worktreePath: string | null;
  branch: string | null;
  baseRef: string | null;
  taskPrompt: string;
  createdAt: number;
};

export type TaskRow = {
  id: string;
  title: string;
  kind: "single" | "group" | "orchestrator";
  status: "active" | "paused" | "archived" | "error";
  goal: string | null;
  defaultMode: "wrap" | "terminal";
  visibility: "user" | "internal";
  source: "manual" | "planner" | "migration";
  plannerConfig: any;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type TaskMemberRow = {
  id: number;
  taskId: string;
  sessionId: string;
  role: "parent" | "child" | "solo" | "helper";
  ordinal: number;
  title: string | null;
  isInternal: boolean;
  defaultHidden: boolean;
  modeOverride: "wrap" | "terminal" | null;
  createdAt: number;
};

export type HarnessCommandReplayRow = {
  cacheKey: string;
  orchestrationId: string;
  commandId: string;
  ts: number;
  response: any;
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
      transport TEXT,
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

    CREATE TABLE IF NOT EXISTS orchestrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      projectPath TEXT NOT NULL,
      orchestratorSessionId TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      lastError TEXT,
      cleanedAt INTEGER,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_orchestrations_updated ON orchestrations(updatedAt DESC);

    CREATE TABLE IF NOT EXISTS orchestration_workers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      orchestrationId TEXT NOT NULL,
      workerIndex INTEGER NOT NULL,
      name TEXT NOT NULL,
      tool TEXT NOT NULL,
      profileId TEXT NOT NULL,
      sessionId TEXT NOT NULL,
      projectPath TEXT NOT NULL,
      worktreePath TEXT,
      branch TEXT,
      baseRef TEXT,
      taskPrompt TEXT NOT NULL,
      createdAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_orch_workers_orch ON orchestration_workers(orchestrationId, workerIndex);

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      goal TEXT,
      defaultMode TEXT NOT NULL DEFAULT 'wrap',
      visibility TEXT NOT NULL DEFAULT 'user',
      source TEXT NOT NULL DEFAULT 'manual',
      plannerConfig TEXT NOT NULL DEFAULT '{}',
      archivedAt INTEGER,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_updated ON tasks(updatedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, visibility, updatedAt DESC);

    CREATE TABLE IF NOT EXISTS task_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      taskId TEXT NOT NULL,
      sessionId TEXT NOT NULL,
      role TEXT NOT NULL,
      ordinal INTEGER NOT NULL DEFAULT 0,
      title TEXT,
      isInternal INTEGER NOT NULL DEFAULT 0,
      defaultHidden INTEGER NOT NULL DEFAULT 0,
      modeOverride TEXT,
      createdAt INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_task_members_unique ON task_members(taskId, sessionId);
    CREATE INDEX IF NOT EXISTS idx_task_members_task ON task_members(taskId, ordinal, id);
    CREATE INDEX IF NOT EXISTS idx_task_members_session ON task_members(sessionId);

    CREATE TABLE IF NOT EXISTS harness_command_replay (
      cacheKey TEXT PRIMARY KEY,
      orchestrationId TEXT NOT NULL,
      commandId TEXT NOT NULL,
      ts INTEGER NOT NULL,
      response TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_harness_command_replay_ts ON harness_command_replay(ts DESC);
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
  addCol("transport", "transport TEXT");
  const orchCols = (db.prepare("PRAGMA table_info(orchestrations)").all() as any[]).map((r) => String(r.name));
  const addOrchCol = (name: string, ddl: string) => {
    if (!orchCols.includes(name)) db.exec(`ALTER TABLE orchestrations ADD COLUMN ${ddl}`);
  };
  addOrchCol("status", "status TEXT NOT NULL DEFAULT 'active'");
  addOrchCol("lastError", "lastError TEXT");
  addOrchCol("cleanedAt", "cleanedAt INTEGER");
  const taskCols = (db.prepare("PRAGMA table_info(tasks)").all() as any[]).map((r) => String(r.name));
  const addTaskCol = (name: string, ddl: string) => {
    if (!taskCols.includes(name)) db.exec(`ALTER TABLE tasks ADD COLUMN ${ddl}`);
  };
  addTaskCol("status", "status TEXT NOT NULL DEFAULT 'active'");
  addTaskCol("goal", "goal TEXT");
  addTaskCol("defaultMode", "defaultMode TEXT NOT NULL DEFAULT 'wrap'");
  addTaskCol("visibility", "visibility TEXT NOT NULL DEFAULT 'user'");
  addTaskCol("source", "source TEXT NOT NULL DEFAULT 'manual'");
  addTaskCol("plannerConfig", "plannerConfig TEXT NOT NULL DEFAULT '{}'");
  addTaskCol("archivedAt", "archivedAt INTEGER");
  const taskMemberCols = (db.prepare("PRAGMA table_info(task_members)").all() as any[]).map((r) => String(r.name));
  const addTaskMemberCol = (name: string, ddl: string) => {
    if (!taskMemberCols.includes(name)) db.exec(`ALTER TABLE task_members ADD COLUMN ${ddl}`);
  };
  addTaskMemberCol("isInternal", "isInternal INTEGER NOT NULL DEFAULT 0");
  addTaskMemberCol("defaultHidden", "defaultHidden INTEGER NOT NULL DEFAULT 0");
  addTaskMemberCol("modeOverride", "modeOverride TEXT");

  const stmtCreateSession = db.prepare(
    "INSERT INTO sessions (id, tool, profileId, transport, toolSessionId, cwd, workspaceKey, workspaceRoot, treePath, label, pinnedSlot, createdAt, updatedAt, exitCode, signal) VALUES (@id, @tool, @profileId, @transport, @toolSessionId, @cwd, @workspaceKey, @workspaceRoot, @treePath, @label, @pinnedSlot, @createdAt, @updatedAt, NULL, NULL)",
  );
  const stmtListSessions = db.prepare("SELECT * FROM sessions ORDER BY updatedAt DESC");
  const stmtListSessionsLimit = db.prepare("SELECT * FROM sessions ORDER BY updatedAt DESC LIMIT ?");
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
  const stmtLatestEventOfKind = db.prepare(
    "SELECT id, ts, kind, data FROM events WHERE sessionId = ? AND kind = ? ORDER BY id DESC LIMIT 1",
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

  const stmtOrchInsert = db.prepare(
    "INSERT INTO orchestrations (id, name, projectPath, orchestratorSessionId, status, lastError, cleanedAt, createdAt, updatedAt) VALUES (@id, @name, @projectPath, @orchestratorSessionId, @status, @lastError, @cleanedAt, @createdAt, @updatedAt)",
  );
  const stmtOrchInsertWorker = db.prepare(
    "INSERT INTO orchestration_workers (orchestrationId, workerIndex, name, tool, profileId, sessionId, projectPath, worktreePath, branch, baseRef, taskPrompt, createdAt) VALUES (@orchestrationId, @workerIndex, @name, @tool, @profileId, @sessionId, @projectPath, @worktreePath, @branch, @baseRef, @taskPrompt, @createdAt)",
  );
  const stmtOrchList = db.prepare("SELECT id, name, projectPath, orchestratorSessionId, status, lastError, cleanedAt, createdAt, updatedAt FROM orchestrations ORDER BY updatedAt DESC LIMIT ?");
  const stmtOrchGet = db.prepare("SELECT id, name, projectPath, orchestratorSessionId, status, lastError, cleanedAt, createdAt, updatedAt FROM orchestrations WHERE id = ?");
  const stmtOrchWorkers = db.prepare(
    "SELECT id, orchestrationId, workerIndex, name, tool, profileId, sessionId, projectPath, worktreePath, branch, baseRef, taskPrompt, createdAt FROM orchestration_workers WHERE orchestrationId = ? ORDER BY workerIndex ASC",
  );
  const stmtOrchState = db.prepare(
    "UPDATE orchestrations SET status = ?, lastError = ?, cleanedAt = ?, updatedAt = ? WHERE id = ?",
  );
  const stmtOrchDeleteWorkers = db.prepare("DELETE FROM orchestration_workers WHERE orchestrationId = ?");
  const stmtOrchDelete = db.prepare("DELETE FROM orchestrations WHERE id = ?");

  const stmtTaskInsert = db.prepare(
    "INSERT INTO tasks (id, title, kind, status, goal, defaultMode, visibility, source, plannerConfig, archivedAt, createdAt, updatedAt) VALUES (@id, @title, @kind, @status, @goal, @defaultMode, @visibility, @source, @plannerConfig, @archivedAt, @createdAt, @updatedAt)",
  );
  const stmtTaskUpsert = db.prepare(
    "INSERT INTO tasks (id, title, kind, status, goal, defaultMode, visibility, source, plannerConfig, archivedAt, createdAt, updatedAt) VALUES (@id, @title, @kind, @status, @goal, @defaultMode, @visibility, @source, @plannerConfig, @archivedAt, @createdAt, @updatedAt) ON CONFLICT(id) DO UPDATE SET title=excluded.title, kind=excluded.kind, status=excluded.status, goal=excluded.goal, defaultMode=excluded.defaultMode, visibility=excluded.visibility, source=excluded.source, plannerConfig=excluded.plannerConfig, archivedAt=excluded.archivedAt, updatedAt=excluded.updatedAt",
  );
  const stmtTaskGet = db.prepare(
    "SELECT id, title, kind, status, goal, defaultMode, visibility, source, plannerConfig, archivedAt, createdAt, updatedAt FROM tasks WHERE id = ?",
  );
  const stmtTaskList = db.prepare(
    "SELECT id, title, kind, status, goal, defaultMode, visibility, source, plannerConfig, archivedAt, createdAt, updatedAt FROM tasks ORDER BY updatedAt DESC LIMIT ?",
  );
  const stmtTaskSetMode = db.prepare("UPDATE tasks SET defaultMode = ?, updatedAt = ? WHERE id = ?");
  const stmtTaskSetStatus = db.prepare("UPDATE tasks SET status = ?, archivedAt = ?, updatedAt = ? WHERE id = ?");
  const stmtTaskDelete = db.prepare("DELETE FROM tasks WHERE id = ?");

  const stmtTaskMemberUpsert = db.prepare(
    "INSERT INTO task_members (taskId, sessionId, role, ordinal, title, isInternal, defaultHidden, modeOverride, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(taskId, sessionId) DO UPDATE SET role=excluded.role, ordinal=excluded.ordinal, title=excluded.title, isInternal=excluded.isInternal, defaultHidden=excluded.defaultHidden, modeOverride=COALESCE(excluded.modeOverride, task_members.modeOverride)",
  );
  const stmtTaskMemberList = db.prepare(
    "SELECT id, taskId, sessionId, role, ordinal, title, isInternal, defaultHidden, modeOverride, createdAt FROM task_members WHERE taskId = ? ORDER BY ordinal ASC, id ASC",
  );
  const stmtTaskMemberGetBySession = db.prepare(
    "SELECT id, taskId, sessionId, role, ordinal, title, isInternal, defaultHidden, modeOverride, createdAt FROM task_members WHERE sessionId = ? ORDER BY id DESC LIMIT 1",
  );
  const stmtTaskMemberSetModeOverride = db.prepare(
    "UPDATE task_members SET modeOverride = ? WHERE taskId = ? AND sessionId = ?",
  );
  const stmtTaskMemberDeleteBySession = db.prepare("DELETE FROM task_members WHERE sessionId = ?");
  const stmtTaskMembersDeleteByTask = db.prepare("DELETE FROM task_members WHERE taskId = ?");
  const stmtTaskMemberCountByTask = db.prepare("SELECT taskId, COUNT(*) AS count FROM task_members GROUP BY taskId");
  const stmtTaskOrphans = db.prepare(
    "SELECT t.id FROM tasks t LEFT JOIN task_members tm ON tm.taskId = t.id WHERE tm.id IS NULL",
  );
  const stmtHarnessReplayGet = db.prepare(
    "SELECT cacheKey, orchestrationId, commandId, ts, response FROM harness_command_replay WHERE cacheKey = ?",
  );
  const stmtHarnessReplayUpsert = db.prepare(
    `
      INSERT INTO harness_command_replay (cacheKey, orchestrationId, commandId, ts, response)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(cacheKey) DO UPDATE SET
        orchestrationId=excluded.orchestrationId,
        commandId=excluded.commandId,
        ts=excluded.ts,
        response=excluded.response
    `,
  );
  const stmtHarnessReplayDeleteOlderThan = db.prepare("DELETE FROM harness_command_replay WHERE ts < ?");
  const stmtHarnessReplayCount = db.prepare("SELECT COUNT(*) as count FROM harness_command_replay");
  const stmtHarnessReplayDeleteOldest = db.prepare(
    "DELETE FROM harness_command_replay WHERE cacheKey IN (SELECT cacheKey FROM harness_command_replay ORDER BY ts ASC LIMIT ?)",
  );

  // Backfill: older DBs may have sessions without cwd populated. This creates confusing blank
  // "dir" workspace entries in the phone UI. We recover cwd from the stored session.created event.
  const stmtSessionsMissingCwd = db.prepare("SELECT id FROM sessions WHERE cwd IS NULL OR TRIM(cwd) = '' LIMIT ?");
  const stmtLastCreatedEvent = db.prepare(
    "SELECT data FROM events WHERE sessionId = ? AND kind = 'session.created' ORDER BY id DESC LIMIT 1",
  );
  const stmtSetSessionCwd = db.prepare("UPDATE sessions SET cwd = ? WHERE id = ? AND (cwd IS NULL OR TRIM(cwd) = '')");
  try {
    const missing = stmtSessionsMissingCwd.all(250) as any[];
    for (const r of missing) {
      const id = typeof r?.id === "string" ? r.id : "";
      if (!id) continue;
      const ev = stmtLastCreatedEvent.get(id) as any;
      const raw = typeof ev?.data === "string" ? ev.data : "";
      if (!raw) continue;
      try {
        const j = JSON.parse(raw);
        const cwd = typeof j?.cwd === "string" ? j.cwd.trim() : "";
        if (cwd) stmtSetSessionCwd.run(cwd, id);
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }

  function createSession(input: {
    id: string;
    tool: ToolId;
    profileId: string;
    transport?: string;
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
      transport: input.transport ?? "pty",
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

  function listSessions(limit?: number): StoreSessionRow[] {
    const hasLimit = Number.isFinite(Number(limit));
    const lim = hasLimit ? Math.min(2000, Math.max(1, Math.floor(Number(limit)))) : null;
    const rows = lim == null ? (stmtListSessions.all() as any[]) : (stmtListSessionsLimit.all(lim) as any[]);
    return rows.map((r) => ({ ...r, transport: String(r.transport ?? "pty") })) as any;
  }

  function getSession(id: string): StoreSessionRow | null {
    const row = stmtGetSession.get(id) as any;
    if (!row) return null;
    row.transport = String(row.transport ?? "pty");
    return row as any;
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
    stmtTaskMemberDeleteBySession.run(sessionId);
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

  function getLatestEvent(sessionId: string, kind: string): EventItem | null {
    const r = stmtLatestEventOfKind.get(sessionId, kind) as any;
    if (!r) return null;
    let parsed: any = {};
    try {
      parsed = JSON.parse(String(r.data ?? "{}"));
    } catch {
      parsed = {};
    }
    return {
      id: Number(r.id),
      ts: Number(r.ts),
      kind: String(r.kind),
      data: parsed,
    };
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

  function updateAttentionItem(id: number, input: { title: string; body: string; options: any }) {
    const now = Date.now();
    stmtAttentionTouchAndUpdate.run(now, input.title, input.body, JSON.stringify(input.options ?? []), id);
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

  const txCreateOrchestration = db.transaction(
    (input: {
      id: string;
      name: string;
      projectPath: string;
      orchestratorSessionId: string;
      workers: Array<{
        workerIndex: number;
        name: string;
        tool: ToolId;
        profileId: string;
        sessionId: string;
        projectPath: string;
        worktreePath?: string | null;
        branch?: string | null;
        baseRef?: string | null;
        taskPrompt: string;
      }>;
    }) => {
      const now = Date.now();
      stmtOrchInsert.run({
        id: input.id,
        name: input.name,
        projectPath: input.projectPath,
        orchestratorSessionId: input.orchestratorSessionId,
        status: "active",
        lastError: null,
        cleanedAt: null,
        createdAt: now,
        updatedAt: now,
      } as any);
      for (const w of input.workers) {
        stmtOrchInsertWorker.run({
          orchestrationId: input.id,
          workerIndex: w.workerIndex,
          name: w.name,
          tool: w.tool,
          profileId: w.profileId,
          sessionId: w.sessionId,
          projectPath: w.projectPath,
          worktreePath: w.worktreePath ?? null,
          branch: w.branch ?? null,
          baseRef: w.baseRef ?? null,
          taskPrompt: w.taskPrompt,
          createdAt: now,
        } as any);
      }
    },
  );

  function createOrchestration(input: {
    id: string;
    name: string;
    projectPath: string;
    orchestratorSessionId: string;
    workers: Array<{
      workerIndex: number;
      name: string;
      tool: ToolId;
      profileId: string;
      sessionId: string;
      projectPath: string;
      worktreePath?: string | null;
      branch?: string | null;
      baseRef?: string | null;
      taskPrompt: string;
    }>;
  }) {
    txCreateOrchestration(input);
  }

  function listOrchestrations(limit = 60): OrchestrationRow[] {
    const lim = Math.min(500, Math.max(1, Math.floor(limit || 60)));
    const rows = stmtOrchList.all(lim) as any[];
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      projectPath: String(r.projectPath),
      orchestratorSessionId: String(r.orchestratorSessionId),
      status: (String(r.status || "active") as any) ?? "active",
      lastError: r.lastError == null ? null : String(r.lastError),
      cleanedAt: r.cleanedAt == null ? null : Number(r.cleanedAt),
      createdAt: Number(r.createdAt ?? 0),
      updatedAt: Number(r.updatedAt ?? 0),
    }));
  }

  function getOrchestration(id: string): null | { orchestration: OrchestrationRow; workers: OrchestrationWorkerRow[] } {
    const row = stmtOrchGet.get(id) as any;
    if (!row) return null;
    const workers = (stmtOrchWorkers.all(id) as any[]).map((r) => ({
      id: Number(r.id),
      orchestrationId: String(r.orchestrationId),
      workerIndex: Number(r.workerIndex ?? 0),
      name: String(r.name),
      tool: String(r.tool) as ToolId,
      profileId: String(r.profileId),
      sessionId: String(r.sessionId),
      projectPath: String(r.projectPath),
      worktreePath: r.worktreePath == null ? null : String(r.worktreePath),
      branch: r.branch == null ? null : String(r.branch),
      baseRef: r.baseRef == null ? null : String(r.baseRef),
      taskPrompt: String(r.taskPrompt ?? ""),
      createdAt: Number(r.createdAt ?? 0),
    })) as OrchestrationWorkerRow[];
    return {
      orchestration: {
        id: String(row.id),
        name: String(row.name),
        projectPath: String(row.projectPath),
        orchestratorSessionId: String(row.orchestratorSessionId),
        status: (String(row.status || "active") as any) ?? "active",
        lastError: row.lastError == null ? null : String(row.lastError),
        cleanedAt: row.cleanedAt == null ? null : Number(row.cleanedAt),
        createdAt: Number(row.createdAt ?? 0),
        updatedAt: Number(row.updatedAt ?? 0),
      },
      workers,
    };
  }

  function setOrchestrationState(
    id: string,
    input: { status: "active" | "cleaning" | "cleaned" | "error"; lastError?: string | null; cleanedAt?: number | null },
  ) {
    stmtOrchState.run(
      input.status,
      input.lastError == null ? null : String(input.lastError),
      input.cleanedAt == null ? null : Number(input.cleanedAt),
      Date.now(),
      id,
    );
  }

  const txDeleteOrchestration = db.transaction((id: string) => {
    stmtOrchDeleteWorkers.run(id);
    stmtOrchDelete.run(id);
  });

  function deleteOrchestration(id: string) {
    txDeleteOrchestration(id);
  }

  function parseTaskRow(r: any): TaskRow {
    let plannerConfig: any = {};
    try {
      plannerConfig = JSON.parse(String(r.plannerConfig ?? "{}"));
    } catch {
      plannerConfig = {};
    }
    const kind = String(r.kind ?? "single");
    const status = String(r.status ?? "active");
    const mode = String(r.defaultMode ?? "wrap");
    const visibility = String(r.visibility ?? "user");
    const source = String(r.source ?? "manual");
    return {
      id: String(r.id),
      title: String(r.title ?? ""),
      kind: (kind === "single" || kind === "group" || kind === "orchestrator" ? kind : "single") as any,
      status: (status === "active" || status === "paused" || status === "archived" || status === "error" ? status : "active") as any,
      goal: r.goal == null ? null : String(r.goal),
      defaultMode: (mode === "terminal" ? "terminal" : "wrap") as any,
      visibility: (visibility === "internal" ? "internal" : "user") as any,
      source: (source === "planner" || source === "migration" ? source : "manual") as any,
      plannerConfig,
      archivedAt: r.archivedAt == null ? null : Number(r.archivedAt),
      createdAt: Number(r.createdAt ?? 0),
      updatedAt: Number(r.updatedAt ?? 0),
    };
  }

  function parseTaskMemberRow(r: any): TaskMemberRow {
    const role = String(r.role ?? "solo");
    const mode = String(r.modeOverride ?? "");
    return {
      id: Number(r.id),
      taskId: String(r.taskId),
      sessionId: String(r.sessionId),
      role: (role === "parent" || role === "child" || role === "helper" ? role : "solo") as any,
      ordinal: Number(r.ordinal ?? 0),
      title: r.title == null ? null : String(r.title),
      isInternal: Number(r.isInternal ?? 0) === 1,
      defaultHidden: Number(r.defaultHidden ?? 0) === 1,
      modeOverride: mode === "wrap" || mode === "terminal" ? (mode as any) : null,
      createdAt: Number(r.createdAt ?? 0),
    };
  }

  function upsertTask(input: {
    id: string;
    title: string;
    kind: TaskRow["kind"];
    status?: TaskRow["status"];
    goal?: string | null;
    defaultMode?: TaskRow["defaultMode"];
    visibility?: TaskRow["visibility"];
    source?: TaskRow["source"];
    plannerConfig?: any;
    archivedAt?: number | null;
  }) {
    const now = Date.now();
    const cur = stmtTaskGet.get(input.id) as any;
    const createdAt = cur ? Number(cur.createdAt ?? now) : now;
    stmtTaskUpsert.run({
      id: input.id,
      title: input.title,
      kind: input.kind,
      status: input.status ?? "active",
      goal: input.goal ?? null,
      defaultMode: input.defaultMode ?? "wrap",
      visibility: input.visibility ?? "user",
      source: input.source ?? "manual",
      plannerConfig: JSON.stringify(input.plannerConfig ?? {}),
      archivedAt: input.archivedAt ?? null,
      createdAt,
      updatedAt: now,
    } as any);
  }

  function createTask(input: {
    id: string;
    title: string;
    kind: TaskRow["kind"];
    status?: TaskRow["status"];
    goal?: string | null;
    defaultMode?: TaskRow["defaultMode"];
    visibility?: TaskRow["visibility"];
    source?: TaskRow["source"];
    plannerConfig?: any;
    archivedAt?: number | null;
  }) {
    const now = Date.now();
    stmtTaskInsert.run({
      id: input.id,
      title: input.title,
      kind: input.kind,
      status: input.status ?? "active",
      goal: input.goal ?? null,
      defaultMode: input.defaultMode ?? "wrap",
      visibility: input.visibility ?? "user",
      source: input.source ?? "manual",
      plannerConfig: JSON.stringify(input.plannerConfig ?? {}),
      archivedAt: input.archivedAt ?? null,
      createdAt: now,
      updatedAt: now,
    } as any);
  }

  function listTasks(limit = 120): TaskRow[] {
    const lim = Math.min(1000, Math.max(1, Math.floor(limit || 120)));
    return (stmtTaskList.all(lim) as any[]).map(parseTaskRow);
  }

  function getTask(id: string): TaskRow | null {
    const row = stmtTaskGet.get(id) as any;
    return row ? parseTaskRow(row) : null;
  }

  function setTaskDefaultMode(taskId: string, mode: "wrap" | "terminal") {
    stmtTaskSetMode.run(mode, Date.now(), taskId);
  }

  function setTaskStatus(taskId: string, status: TaskRow["status"], archivedAt: number | null = null) {
    stmtTaskSetStatus.run(status, archivedAt, Date.now(), taskId);
  }

  function deleteTask(taskId: string) {
    stmtTaskMembersDeleteByTask.run(taskId);
    stmtTaskDelete.run(taskId);
  }

  function upsertTaskMember(input: {
    taskId: string;
    sessionId: string;
    role: TaskMemberRow["role"];
    ordinal: number;
    title?: string | null;
    isInternal?: boolean;
    defaultHidden?: boolean;
    modeOverride?: "wrap" | "terminal" | null;
  }) {
    const now = Date.now();
    try {
      stmtTaskMemberDeleteBySession.run(input.sessionId);
    } catch {
      // ignore
    }
    stmtTaskMemberUpsert.run(
      input.taskId,
      input.sessionId,
      input.role,
      Math.floor(Number(input.ordinal ?? 0)),
      input.title ?? null,
      input.isInternal ? 1 : 0,
      input.defaultHidden ? 1 : 0,
      input.modeOverride ?? null,
      now,
    );
    stmtTaskSetStatus.run("active", null, now, input.taskId);
  }

  function listTaskMembers(taskId: string): TaskMemberRow[] {
    return (stmtTaskMemberList.all(taskId) as any[]).map(parseTaskMemberRow);
  }

  function getTaskMemberBySession(sessionId: string): TaskMemberRow | null {
    const row = stmtTaskMemberGetBySession.get(sessionId) as any;
    return row ? parseTaskMemberRow(row) : null;
  }

  function setTaskMemberModeOverride(taskId: string, sessionId: string, modeOverride: "wrap" | "terminal" | null) {
    stmtTaskMemberSetModeOverride.run(modeOverride, taskId, sessionId);
    stmtTaskSetStatus.run("active", null, Date.now(), taskId);
  }

  function clearTaskMembers(taskId: string) {
    stmtTaskMembersDeleteByTask.run(taskId);
    stmtTaskSetStatus.run("active", null, Date.now(), taskId);
  }

  function pruneOrphanTasks() {
    const rows = stmtTaskOrphans.all() as any[];
    for (const r of rows) {
      const id = String(r?.id ?? "");
      if (!id) continue;
      stmtTaskDelete.run(id);
    }
  }

  function getTaskMemberCounts(): Record<string, number> {
    const rows = stmtTaskMemberCountByTask.all() as any[];
    const out: Record<string, number> = {};
    for (const r of rows) out[String(r.taskId)] = Number(r.count ?? 0);
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

  function getHarnessCommandReplay(cacheKey: string): HarnessCommandReplayRow | null {
    const row = stmtHarnessReplayGet.get(cacheKey) as any;
    if (!row) return null;
    let response: any = {};
    try {
      response = JSON.parse(String(row.response ?? "{}"));
    } catch {
      response = {};
    }
    return {
      cacheKey: String(row.cacheKey ?? ""),
      orchestrationId: String(row.orchestrationId ?? ""),
      commandId: String(row.commandId ?? ""),
      ts: Number(row.ts ?? 0),
      response,
    };
  }

  function upsertHarnessCommandReplay(input: {
    cacheKey: string;
    orchestrationId: string;
    commandId: string;
    ts: number;
    response: any;
  }) {
    stmtHarnessReplayUpsert.run(
      input.cacheKey,
      input.orchestrationId,
      input.commandId,
      Math.floor(Number(input.ts ?? Date.now())),
      JSON.stringify(input.response ?? {}),
    );
  }

  function pruneHarnessCommandReplay(input: { olderThanTs: number; maxRows: number; keepRows: number }) {
    const olderThanTs = Math.floor(Number(input.olderThanTs ?? 0));
    const maxRows = Math.max(100, Math.floor(Number(input.maxRows ?? 300)));
    const keepRows = Math.max(50, Math.min(maxRows, Math.floor(Number(input.keepRows ?? 220))));

    stmtHarnessReplayDeleteOlderThan.run(olderThanTs);
    const row = stmtHarnessReplayCount.get() as any;
    const count = Number(row?.count ?? 0);
    if (count <= maxRows) return;
    const drop = count - keepRows;
    if (drop > 0) stmtHarnessReplayDeleteOldest.run(drop);
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
    getLatestEvent,
    listRecentWorkspaces,
    getWorkspacePreset,
    upsertWorkspacePreset,
    createAttentionItem,
    listInbox,
    getAttentionItem,
    setAttentionStatus,
    updateAttentionItem,
    addAttentionAction,
    getOpenAttentionCounts,
    createOrchestration,
    listOrchestrations,
    getOrchestration,
    setOrchestrationState,
    deleteOrchestration,
    createTask,
    upsertTask,
    listTasks,
    getTask,
    setTaskDefaultMode,
    setTaskStatus,
    deleteTask,
    upsertTaskMember,
    listTaskMembers,
    getTaskMemberBySession,
    setTaskMemberModeOverride,
    clearTaskMembers,
    pruneOrphanTasks,
    getTaskMemberCounts,
    getHarnessCommandReplay,
    upsertHarnessCommandReplay,
    pruneHarnessCommandReplay,
    doctor,
    close,
  };
}

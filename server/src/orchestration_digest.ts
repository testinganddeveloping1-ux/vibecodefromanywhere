import { createHash } from "node:crypto";

export type OrchestrationEventRef = {
  id: number | null;
  kind: string | null;
  ts: number | null;
};

export type OrchestrationWorkerInput = {
  idx: number;
  name: string;
  sessionId: string;
  running: boolean;
  attention: number;
  preview: string | null;
  previewTs: number | null;
  branch: string | null;
  lastEvent: OrchestrationEventRef | null;
  progressUpdatedAt?: number | null;
  checklistDone?: number;
  checklistTotal?: number;
  progressRelPath?: string | null;
};

export type OrchestrationWorkerSnapshot = {
  stateHash: string;
  running: boolean;
  attention: number;
  preview: string | null;
  previewTs: number | null;
  branch: string | null;
  lastEventId: number | null;
  lastEventKind: string | null;
  lastEventTs: number | null;
  progressUpdatedAt: number | null;
  checklistDone: number;
  checklistTotal: number;
  progressRelPath: string | null;
  changedAt: number;
};

export type OrchestrationDigestInput = {
  orchestrationId: string;
  name: string;
  trigger: string;
  generatedAt: number;
  workers: OrchestrationWorkerInput[];
  previousSnapshots: Record<string, OrchestrationWorkerSnapshot>;
};

export type OrchestrationDigest = {
  hash: string;
  text: string;
  generatedAt: number;
  workerFingerprint: string;
  workerCount: number;
  runningWorkers: number;
  attentionTotal: number;
  changedWorkerCount: number;
  changedSessionIds: string[];
  snapshots: Record<string, OrchestrationWorkerSnapshot>;
};

function shortId(v: string): string {
  const s = String(v ?? "");
  return s.length <= 8 ? s : s.slice(0, 8);
}

function cleanLine(v: string | null | undefined, max = 220): string | null {
  const s = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  if (!s) return null;
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 3))}...`;
}

function stableHash(parts: string[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex").slice(0, 16);
}

function normalizeEventForDigest(ev: OrchestrationEventRef | null): OrchestrationEventRef | null {
  if (!ev || ev.id == null) return null;
  const kindRaw = String(ev.kind ?? "").trim();
  const kind = kindRaw.toLowerCase();
  if (!kind) return null;

  const exactKinds = new Set([
    "claude.permission",
    "codex.approval",
    "codex.native.user_input",
    "inbox.respond",
    "inbox.dismiss",
    "inbox.timeout",
    "session.exit",
  ]);
  const prefixKinds = ["codex.native.approval.", "orchestration.question."];

  if (!exactKinds.has(kind) && !prefixKinds.some((p) => kind.startsWith(p))) return null;
  return {
    id: Number(ev.id),
    kind: kindRaw,
    ts: ev.ts == null ? null : Number(ev.ts),
  };
}

function snapshotForWorker(w: OrchestrationWorkerInput, now: number, prev: OrchestrationWorkerSnapshot | null): OrchestrationWorkerSnapshot {
  const preview = cleanLine(w.preview);
  const branch = cleanLine(w.branch, 120);
  const progressRelPath = cleanLine(w.progressRelPath, 140);
  const progressUpdatedAt = w.progressUpdatedAt == null ? null : Number(w.progressUpdatedAt);
  const checklistDone = Math.max(0, Math.floor(Number(w.checklistDone) || 0));
  const checklistTotal = Math.max(0, Math.floor(Number(w.checklistTotal) || 0));
  const ev = normalizeEventForDigest(w.lastEvent ?? null);
  const stateHash = stableHash([
    w.running ? "1" : "0",
    String(Math.max(0, Math.floor(Number(w.attention) || 0))),
    branch ?? "",
    preview ?? "",
    progressRelPath ?? "",
    progressUpdatedAt == null ? "" : String(progressUpdatedAt),
    String(checklistDone),
    String(checklistTotal),
    ev?.id == null ? "" : String(ev.id),
    ev?.kind == null ? "" : String(ev.kind),
    ev?.ts == null ? "" : String(ev.ts),
    w.previewTs == null ? "" : String(w.previewTs),
  ]);
  const changedAt = prev && prev.stateHash === stateHash ? prev.changedAt : now;
  return {
    stateHash,
    running: Boolean(w.running),
    attention: Math.max(0, Math.floor(Number(w.attention) || 0)),
    preview,
    previewTs: w.previewTs == null ? null : Number(w.previewTs),
    branch,
    lastEventId: ev?.id == null ? null : Number(ev.id),
    lastEventKind: ev?.kind == null ? null : String(ev.kind),
    lastEventTs: ev?.ts == null ? null : Number(ev.ts),
    progressUpdatedAt,
    checklistDone,
    checklistTotal,
    progressRelPath,
    changedAt,
  };
}

function changeSummaryLine(
  w: OrchestrationWorkerInput,
  prev: OrchestrationWorkerSnapshot | null,
  cur: OrchestrationWorkerSnapshot,
): string {
  if (!prev) return `- #${w.idx + 1} ${w.name} (${shortId(w.sessionId)}): new worker snapshot`;
  const bits: string[] = [];
  if (prev.running !== cur.running) bits.push(`running ${prev.running ? "on" : "off"}→${cur.running ? "on" : "off"}`);
  if (prev.attention !== cur.attention) bits.push(`attention ${prev.attention}→${cur.attention}`);
  if ((prev.branch ?? "") !== (cur.branch ?? "")) bits.push(`branch ${(prev.branch ?? "none")}→${(cur.branch ?? "none")}`);
  if ((prev.preview ?? "") !== (cur.preview ?? "")) bits.push("preview changed");
  if (prev.checklistDone !== cur.checklistDone || prev.checklistTotal !== cur.checklistTotal) {
    bits.push(`checklist ${prev.checklistDone}/${prev.checklistTotal}→${cur.checklistDone}/${cur.checklistTotal}`);
  } else if ((prev.progressUpdatedAt ?? -1) !== (cur.progressUpdatedAt ?? -1)) {
    bits.push("task.md updated");
  }
  if ((prev.progressRelPath ?? "") !== (cur.progressRelPath ?? "")) {
    bits.push(`progress source ${(prev.progressRelPath ?? "none")}→${(cur.progressRelPath ?? "none")}`);
  }
  if ((prev.lastEventId ?? -1) !== (cur.lastEventId ?? -1)) {
    const evName = cur.lastEventKind ?? "event";
    bits.push(`${evName} #${cur.lastEventId ?? "?"}`);
  }
  if (bits.length === 0) bits.push("state touched");
  return `- #${w.idx + 1} ${w.name} (${shortId(w.sessionId)}): ${bits.join(" · ")}`;
}

function workerStateLine(w: OrchestrationWorkerInput): string {
  const bits = [
    `- #${w.idx + 1} ${w.name} (${shortId(w.sessionId)})`,
    w.running ? "running" : "stopped",
    `attention:${Math.max(0, Math.floor(Number(w.attention) || 0))}`,
  ];
  const branch = cleanLine(w.branch, 120);
  if (branch) bits.push(`branch:${branch}`);
  const checklistDone = Math.max(0, Math.floor(Number(w.checklistDone) || 0));
  const checklistTotal = Math.max(0, Math.floor(Number(w.checklistTotal) || 0));
  if (checklistTotal > 0) bits.push(`checklist:${checklistDone}/${checklistTotal}`);
  const progressRelPath = cleanLine(w.progressRelPath, 120);
  if (progressRelPath) bits.push(`progress:${progressRelPath}`);
  const ev = normalizeEventForDigest(w.lastEvent ?? null);
  if (ev?.id != null) bits.push(`${ev.kind ?? "event"}#${ev.id}`);
  return bits.join(" · ");
}

export function buildOrchestrationDigest(input: OrchestrationDigestInput): OrchestrationDigest {
  const generatedAt = Number(input.generatedAt) || Date.now();
  const snapshots: Record<string, OrchestrationWorkerSnapshot> = {};
  const changedLines: string[] = [];
  const changedSessionIds: string[] = [];

  let runningWorkers = 0;
  let attentionTotal = 0;

  const workerStates = input.workers
    .slice()
    .sort((a, b) => Number(a.idx) - Number(b.idx));

  for (const w of workerStates) {
    if (w.running) runningWorkers += 1;
    attentionTotal += Math.max(0, Math.floor(Number(w.attention) || 0));
    const prev = input.previousSnapshots[String(w.sessionId)] ?? null;
    const cur = snapshotForWorker(w, generatedAt, prev);
    snapshots[String(w.sessionId)] = cur;
    if (!prev || prev.stateHash !== cur.stateHash) {
      changedSessionIds.push(String(w.sessionId));
      changedLines.push(changeSummaryLine(w, prev, cur));
    }
  }

  const workerFingerprint = workerStates
    .map((w) => `${w.sessionId}|${snapshots[w.sessionId]?.stateHash ?? ""}`)
    .join("\n");
  const hash = createHash("sha256").update(workerFingerprint).digest("hex").slice(0, 20);

  const workerLines = workerStates.map((w) => {
    const head = workerStateLine(w);
    const p = cleanLine(w.preview, 220);
    return p ? `${head}\n  last: ${p}` : head;
  });

  const text =
    `ORCHESTRATION SYNC (${input.trigger})\n` +
    `id: ${input.orchestrationId}\n` +
    `name: ${input.name}\n` +
    `generatedAt: ${new Date(generatedAt).toISOString()}\n` +
    `workers: ${runningWorkers}/${workerStates.length} running\n` +
    `attentionTotal: ${attentionTotal}\n` +
    `digestHash: ${hash}\n` +
    `changes: ${changedLines.length}\n` +
    `\nChanges since last digest:\n` +
    `${changedLines.length ? changedLines.join("\n") : "- none"}\n` +
    `\nWorker states:\n${workerLines.join("\n")}\n` +
    `\nTreat this as read-only status context. Do not interrupt workers unless asked.`;

  return {
    hash,
    text,
    generatedAt,
    workerFingerprint,
    workerCount: workerStates.length,
    runningWorkers,
    attentionTotal,
    changedWorkerCount: changedLines.length,
    changedSessionIds,
    snapshots,
  };
}

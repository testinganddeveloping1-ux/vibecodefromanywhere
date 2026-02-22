import fs from "node:fs";
import path from "node:path";
import {
  buildMasterSystemPromptLibrary,
  defaultCommandCatalog,
  expertPlaybookCatalog,
  inferWorkerRole,
  type WorkerRoleKey,
} from "./harness.js";

export type OrchestrationDocsWorker = {
  workerIndex: number;
  name: string;
  role?: WorkerRoleKey | string;
  sessionId: string;
  tool: string;
  profileId: string;
  projectPath: string;
  worktreePath: string | null;
  branch: string | null;
  taskPrompt: string;
  systemPrompt?: string;
};

export type OrchestrationDocsInput = {
  orchestrationId: string;
  orchestrationName: string;
  objective: string;
  dispatchMode: "orchestrator-first" | "worker-first";
  orchestratorSessionId: string;
  orchestratorTool: string;
  orchestratorProfileId: string;
  projectPath: string;
  workers: OrchestrationDocsWorker[];
};

export type RuntimeBootstrapDocInput = {
  orchestrationId: string;
  projectPath: string;
  orchestratorBootstrap: string;
  workers: Array<{
    workerIndex: number;
    workerName: string;
    workerRole?: WorkerRoleKey | string;
    workerProfileId?: string;
    workerSystemPrompt?: string;
    rootPath: string;
    bootstrap: string;
  }>;
};

export type OrchestrationDocsWriteResult = {
  written: string[];
  skipped: string[];
  errors: Array<{ file: string; message: string }>;
};

function slug(v: string): string {
  return String(v ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-/]+|[-/]+$/g, "") || "worker";
}

function nowIso(): string {
  return new Date().toISOString();
}

function relOrSelf(baseDir: string, absPath: string): string {
  try {
    const rel = path.relative(baseDir, absPath);
    return rel && !rel.startsWith("..") ? rel : absPath;
  } catch {
    return absPath;
  }
}

function ensureParent(filePath: string) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o775 });
  fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
}

function writeTextFile(
  filePath: string,
  content: string,
  result: OrchestrationDocsWriteResult,
  opts?: { ifMissing?: boolean },
) {
  try {
    if (opts?.ifMissing === true && fs.existsSync(filePath)) {
      result.skipped.push(filePath);
      return;
    }
    ensureParent(filePath);
    fs.writeFileSync(filePath, content, "utf8");
    // Keep generated orchestration docs readable by all local runtime processes.
    // This is best-effort and does not override OS-level security boundaries.
    try {
      fs.chmodSync(filePath, 0o644);
    } catch {
      // ignore chmod failures on platforms/filesystems that don't support it
    }
    fs.accessSync(filePath, fs.constants.R_OK);
    result.written.push(filePath);
  } catch (e: any) {
    result.errors.push({
      file: filePath,
      message: typeof e?.message === "string" ? e.message : "write_failed",
    });
  }
}

function workerTaskFileName(w: OrchestrationDocsWorker): string {
  return `worker-${Number(w.workerIndex) + 1}-${slug(String(w.name))}.md`;
}

function buildWorkersBlock(workers: OrchestrationDocsWorker[]): string {
  return workers
    .map((w) => {
      const role = inferWorkerRole({
        role: typeof w.role === "string" ? w.role : "",
        name: w.name,
        taskPrompt: w.taskPrompt,
        profileId: w.profileId,
      });
      const lines = [
        `### Worker ${Number(w.workerIndex) + 1}: ${w.name}`,
        `- Role: \`${role}\``,
        `- Session: \`${w.sessionId}\``,
        `- Tool/Profile: \`${w.tool}/${w.profileId}\``,
        `- Project: \`${w.projectPath}\``,
      ];
      if (w.worktreePath) lines.push(`- Worktree: \`${w.worktreePath}\``);
      if (w.branch) lines.push(`- Branch: \`${w.branch}\``);
      lines.push(`- Task file: \`.agents/tasks/${workerTaskFileName(w)}\``);
      if (typeof w.systemPrompt === "string" && w.systemPrompt.trim()) {
        lines.push("- Runtime contract mirror: `.agents/system/runtime-worker-contracts.md`");
      }
      lines.push(`- Initial task prompt:`);
      lines.push("```text");
      lines.push(String(w.taskPrompt || "(none)").trim());
      lines.push("```");
      return lines.join("\n");
    })
    .join("\n\n");
}

function buildAgentsReadme(input: OrchestrationDocsInput): string {
  const header = [
    "# .agents Orchestration Index",
    "",
    `Generated: ${nowIso()}`,
    `Orchestration ID: \`${input.orchestrationId}\``,
    `Name: ${input.orchestrationName}`,
    `Dispatch mode: \`${input.dispatchMode}\``,
    `Orchestrator session: \`${input.orchestratorSessionId}\``,
    `Orchestrator runtime: \`${input.orchestratorTool}/${input.orchestratorProfileId}\``,
    "",
    "## Objective",
    "",
    String(input.objective || "").trim() || "(no objective)",
    "",
    "## Non-negotiable contracts",
    "",
    "- This folder is the canonical orchestration state for planning, progress, and worker ownership.",
    "- Workers keep progress in `.agents/tasks/worker-*.md` and `.fyp/task.md`.",
    "- Orchestrator references these files before dispatching new work.",
    "- Worker-to-worker communication is forbidden unless orchestrator explicitly authorizes it.",
    "- Escalations and uncertainty are sent as questions through the CLI question/request-input path.",
    "- If no intervention is needed, orchestrator must choose no-dispatch/no-message behavior.",
    "",
    "## File map",
    "",
    "- `.agents/system/orchestrator.md` -> orchestration runtime policy, review loop, approval gates, no-op policy.",
    "- `.agents/system/command-bus.md` -> dispatch/question/approval routing and CLI command patterns.",
    "- `.agents/system/runtime-map.md` -> worker ownership matrix and lifecycle checkpoints.",
    "- `.agents/system/master-prompt-library.md` -> 4k+ line canonical system prompt reference for orchestrator/workers.",
    "- `.agents/system/runtime-worker-contracts.md` -> concrete worker role/system prompt contracts used in this run.",
    "- `.agents/system/runtime-bootstrap-orchestrator.md` -> exact startup bootstrap injected to orchestrator.",
    "- `.agents/tasks/worker-*.md` -> worker-owned status, blockers, verification, and handoff logs.",
    "- `.fyp/task.md` -> concise progress mirror consumed by UI digests.",
    "- `docs/agent-command-library/*.md` -> deep expert playbooks (security debug, reliability, contracts, frontend QA, orchestration ops).",
    "",
    "## Startup sequence (expected)",
    "",
    "1. Orchestrator bootstrap is sent.",
    "2. Worker bootstraps are sent.",
    "3. Workers reply `BOOTSTRAP-ACK`.",
    "4. Orchestrator dispatches first scoped TASK/SCOPE prompts.",
    "5. Workers execute and update `.agents/tasks/worker-*.md` + `.fyp/task.md`.",
    "6. Orchestrator runs periodic review without unnecessary interruption.",
    "",
    "## Worker registry",
    "",
    buildWorkersBlock(input.workers),
    "",
    "## Worker question protocol (required)",
    "",
    "When a worker needs a decision, ask exactly one structured question packet:",
    "",
    "```text",
    "QUESTION:",
    "CONTEXT:",
    "FILES:",
    "OPTIONS:",
    "RECOMMENDED:",
    "BLOCKING:",
    "```",
    "",
    "Question rules:",
    "- Ask only when truly blocking or when a safety/approval gate is hit.",
    "- Bundle related clarifications into one packet.",
    "- Include explicit options so orchestrator can answer quickly.",
    "- If task can continue safely, do not ask a question.",
    "",
    "## Orchestrator no-op policy",
    "",
    "- If a review finds no intervention needed, orchestrator must send no worker message.",
    "- A no-op review should still be logged in orchestrator summary text.",
    "- No-op is success, not inactivity.",
    "",
    "## UI tracking notes",
    "",
    "- UI should treat `.agents/tasks/worker-*.md` as the primary detailed progress source.",
    "- UI should treat `.fyp/task.md` as compact progress summary source.",
    "- Checklist completion is computed from markdown checkboxes.",
    "- Blockers should appear before progress in digest cards.",
    "",
    "## Maintenance notes",
    "",
    "- Do not delete this folder during active orchestration.",
    "- On cleanup/archive, keep these files if auditability is desired.",
    "- If regenerated, newest timestamp wins.",
  ];
  return header.join("\n");
}

function buildOrchestratorPolicy(input: OrchestrationDocsInput): string {
  const workerMatrix = input.workers
    .map((w) => {
      const base = [
        `## Worker ${Number(w.workerIndex) + 1} Policy: ${w.name}`,
        `- Session ID: \`${w.sessionId}\``,
        `- Tool/profile: \`${w.tool}/${w.profileId}\``,
        `- Scope file: \`.agents/tasks/${workerTaskFileName(w)}\``,
        `- Project root: \`${w.projectPath}\``,
      ];
      if (w.worktreePath) base.push(`- Worktree: \`${w.worktreePath}\``);
      if (w.branch) base.push(`- Branch: \`${w.branch}\``);
      base.push("- Ownership rule: worker may only edit files explicitly assigned in orchestrator dispatch.");
      base.push("- Escalation rule: route blockers via question packet, not ad-hoc chat.");
      base.push("- Completion rule: worker includes file list + verify command output.");
      return base.join("\n");
    })
    .join("\n\n");

  const decisionGates = Array.from({ length: 24 }, (_, i) => {
    const idx = i + 1;
    const row = [
      `### Gate Scenario ${idx}`,
      "- Check objective alignment.",
      "- Check worker scope ownership.",
      "- Check cross-worker conflict risk.",
      "- Check verification evidence quality.",
      "- Decide: approve / reject / request evidence / no-op.",
      "- Record decision summary in orchestrator status update.",
    ];
    return row.join("\n");
  }).join("\n\n");

  const periodicReview = Array.from({ length: 20 }, (_, i) => {
    const n = i + 1;
    return [
      `### Periodic Review Cycle ${n}`,
      "- Read all worker task files (`.agents/tasks/worker-*.md`) before making any dispatch.",
      "- Read worker `.fyp/task.md` if present for concise progress signal.",
      "- Detect stale worker (no checklist movement + no file updates).",
      "- If stale and blocked, send targeted unblock prompt.",
      "- If stale but still making progress, no-op and wait.",
      "- Never interrupt active useful progress without explicit reason.",
    ].join("\n");
  }).join("\n\n");
  const playbookRows = expertPlaybookCatalog()
    .map((p) => `- [${p.id}] (${p.mode}) \`${p.path}\``)
    .join("\n");

  return [
    "# Orchestrator Runtime Policy",
    "",
    `Generated: ${nowIso()}`,
    `Orchestration ID: \`${input.orchestrationId}\``,
    `Dispatch mode: \`${input.dispatchMode}\``,
    "",
    "## Mission",
    "- Coordinate, dispatch, monitor, and integrate work from workers.",
    "- Maintain strict ownership boundaries and avoid duplicate edits.",
    "- Resolve worker questions quickly through structured decisions.",
    "- Prefer no-op when intervention is unnecessary.",
    "",
    "## Strict startup checklist",
    "1. Confirm worker registry and task files exist.",
    "2. Confirm each worker has ACKed bootstrap context.",
    "3. Publish first dispatch prompts with TASK/SCOPE/NOT-YOUR-JOB/DONE-WHEN/VERIFY.",
    "4. Confirm workers understood boundaries before allowing broad edits.",
    "5. Start periodic non-invasive review loop.",
    "",
    "## Expert playbooks (read before risky actions)",
    playbookRows,
    "",
    "## Dispatch contract",
    "",
    "Use this exact structure for every worker instruction:",
    "",
    "```text",
    "TASK: [single scoped sentence]",
    "SCOPE: [files/directories]",
    "NOT-YOUR-JOB: [forbidden areas]",
    "DONE-WHEN: [testable result]",
    "VERIFY: [command with expected evidence]",
    "PRIORITY: [HIGH|NORMAL|LOW]",
    "```",
    "",
    "Dispatch rules:",
    "- No vague verbs without measurable output.",
    "- No shared-file edits by multiple workers without explicit owner assignment.",
    "- No broad refactors if objective is focused bugfix/debug pass.",
    "",
    "## Question-first coordination policy",
    "- Workers escalate decisions through question packets only.",
    "- Orchestrator answers with explicit option choice + rationale.",
    "- If worker provided options are insufficient, request a revised packet.",
    "- If question is non-blocking, instruct worker to proceed on conservative path.",
    "",
    "## No-message / no-op policy",
    "- If review indicates worker is on-track, send no new message.",
    "- If worker finishes and no further scope exists, keep worker in standby without extra dispatch.",
    "- No-op decisions must still be reflected in orchestrator logs or summary updates.",
    "",
    "## Approval gate matrix (expanded)",
    "",
    decisionGates,
    "",
    "## Worker ownership matrix",
    "",
    workerMatrix,
    "",
    "## Periodic review protocol",
    "",
    periodicReview,
    "",
    "## Final integration checklist",
    "- Ensure all worker `DONE-WHEN` criteria are met.",
    "- Ensure all `VERIFY` commands include concrete output evidence.",
    "- Ensure no unresolved blockers remain in worker task files.",
    "- Ensure no overlapping conflicting edits remain unmediated.",
    "- Summarize completed/pending/risks/next with file references.",
    "",
    "## Failure handling",
    "- If a worker drifts scope, apply scope-lock immediately and re-dispatch.",
    "- If a worker session stalls, request concise status + blocker options.",
    "- If dispatch delivery fails, retry once then mark as infrastructure blocker.",
    "- If two workers conflict on shared files, pause one worker and reconcile owner.",
    "",
    "## Token economy policy",
    "- Prefer concise dispatches over long conversational chatter.",
    "- Keep status updates blocker-first and evidence-driven.",
    "- Only run hard reviews when risk threshold requires it.",
    "",
    "## Audit policy",
    "- Keep immutable context in `.agents/system/` files.",
    "- Keep mutable progress in `.agents/tasks/` and `.fyp/task.md`.",
    "- Do not erase blocker history; mark resolved with date/time notes.",
  ].join("\n");
}

function buildCommandBusDoc(input: OrchestrationDocsInput): string {
  const workerTargets = input.workers
    .map((w) => `- #${Number(w.workerIndex) + 1}: ${w.name} -> \`session:${w.sessionId}\``)
    .join("\n");
  const commandRows = defaultCommandCatalog()
    .map((c) => `- [${c.id}] ${c.summary}`)
    .join("\n");
  const playbookRows = expertPlaybookCatalog()
    .map((p) => `- [${p.id}] (${p.mode}) ${p.path} :: ${p.focus}`)
    .join("\n");
  const sampleSession = input.workers[0]?.sessionId || "<session-id>";
  const sampleTaskFile = input.workers[0] ? `.agents/tasks/${workerTaskFileName(input.workers[0])}` : ".agents/tasks/worker-1.md";

  return [
    "# Command Bus and Messaging",
    "",
    `Generated: ${nowIso()}`,
    `Orchestration: \`${input.orchestrationId}\``,
    "",
    "## Worker targets",
    workerTargets,
    "",
    "## Agent command library",
    "Use command IDs as concise orchestrator steering verbs:",
    commandRows,
    "",
    "## Expert playbook references",
    "Read these before high-risk decisions or deep debug cycles:",
    playbookRows,
    "",
    "## Dispatch",
    "",
    "Quickstart (recommended):",
    "1. Wait for workers to print `BOOTSTRAP-ACK`.",
    "2. Send one release message with `FYP_DISPATCH_JSON`.",
    "3. Let workers run; only send targeted follow-ups for blockers/scope changes.",
    "",
    "Fastest path (no curl, from orchestrator output):",
    "```text",
    "FYP_DISPATCH_JSON: {\"target\":\"all\",\"text\":\"<prompt>\"}",
    "FYP_DISPATCH_JSON: {\"target\":\"worker:<name>\",\"text\":\"<prompt>\"}",
    "```",
    "",
    "Broadcast to all workers:",
    "```bash",
    "curl -sS -X POST \"$FYP_API_BASE_URL/api/orchestrations/$FYP_ORCHESTRATION_ID/dispatch\" \\",
    "  -H \"Authorization: Bearer $FYP_API_TOKEN\" \\",
    "  -H \"content-type: application/json\" \\",
    "  -d '{\"target\":\"all\",\"text\":\"<prompt>\"}'",
    "```",
    "",
    "Dispatch to one worker by index:",
    "```bash",
    "curl -sS -X POST \"$FYP_API_BASE_URL/api/orchestrations/$FYP_ORCHESTRATION_ID/dispatch\" \\",
    "  -H \"Authorization: Bearer $FYP_API_TOKEN\" \\",
    "  -H \"content-type: application/json\" \\",
    "  -d '{\"target\":\"1\",\"text\":\"<prompt>\"}'",
    "```",
    "",
    "Dispatch by worker name:",
    "```bash",
    "curl -sS -X POST \"$FYP_API_BASE_URL/api/orchestrations/$FYP_ORCHESTRATION_ID/dispatch\" \\",
    "  -H \"Authorization: Bearer $FYP_API_TOKEN\" \\",
    "  -H \"content-type: application/json\" \\",
    "  -d '{\"target\":\"worker:<name>\",\"text\":\"<prompt>\"}'",
    "```",
    "",
    "Dispatch by session id:",
    "```bash",
    "curl -sS -X POST \"$FYP_API_BASE_URL/api/orchestrations/$FYP_ORCHESTRATION_ID/dispatch\" \\",
    "  -H \"Authorization: Bearer $FYP_API_TOKEN\" \\",
    "  -H \"content-type: application/json\" \\",
    "  -d '{\"target\":\"session:<id>\",\"text\":\"<prompt>\"}'",
    "```",
    "",
    "## Questions/approvals",
    "List pending inbox:",
    "```bash",
    "curl -sS \"$FYP_API_BASE_URL/api/inbox?status=open&limit=80\" -H \"Authorization: Bearer $FYP_API_TOKEN\"",
    "```",
    "",
    "Respond:",
    "```bash",
    "curl -sS -X POST \"$FYP_API_BASE_URL/api/inbox/<attentionId>/respond\" \\",
    "  -H \"Authorization: Bearer $FYP_API_TOKEN\" \\",
    "  -H \"content-type: application/json\" \\",
    "  -d '{\"optionId\":\"approve\"}'",
    "```",
    "",
    "## Progress feed",
    "```bash",
    "curl -sS \"$FYP_API_BASE_URL/api/orchestrations/$FYP_ORCHESTRATION_ID/progress\" -H \"Authorization: Bearer $FYP_API_TOKEN\"",
    "```",
    "",
    "## Direct session control (fallback)",
    "Send direct input to a session:",
    "```bash",
    `curl -sS -X POST "$FYP_API_BASE_URL/api/sessions/${sampleSession}/input" \\`,
    "  -H \"Authorization: Bearer $FYP_API_TOKEN\" \\",
    "  -H \"content-type: application/json\" \\",
    "  -d '{\"text\":\"<prompt>\\r\"}'",
    "```",
    "",
    "Read session events:",
    "```bash",
    `curl -sS "$FYP_API_BASE_URL/api/sessions/${sampleSession}/events?limit=80" -H "Authorization: Bearer $FYP_API_TOKEN"`,
    "```",
    "",
    "Read session transcript:",
    "```bash",
    `curl -sS "$FYP_API_BASE_URL/api/sessions/${sampleSession}/transcript" -H "Authorization: Bearer $FYP_API_TOKEN"`,
    "```",
    "",
    "## Task board control",
    "List task cards:",
    "```bash",
    "curl -sS \"$FYP_API_BASE_URL/api/tasks?limit=80\" -H \"Authorization: Bearer $FYP_API_TOKEN\"",
    "```",
    "",
    "Read one task card:",
    "```bash",
    "curl -sS \"$FYP_API_BASE_URL/api/tasks/<taskId>\" -H \"Authorization: Bearer $FYP_API_TOKEN\"",
    "```",
    "",
    "## Structured worker question packet",
    "When worker needs a decision, require this exact format:",
    "```text",
    "QUESTION:",
    "CONTEXT:",
    "FILES:",
    "OPTIONS:",
    "RECOMMENDED:",
    "BLOCKING:",
    "```",
    `Expected worker log location: \`${sampleTaskFile}\``,
    "",
    "## Review/no-op guidance",
    "- Review worker status before dispatching any follow-up.",
    "- If no intervention needed, send no dispatch and continue monitoring.",
    "- Use targeted messages only when there is clear blocker or risk.",
  ].join("\n");
}

function buildRuntimeMapDoc(input: OrchestrationDocsInput): string {
  const rows = input.workers.map((w) => {
    return [
      `## Worker ${Number(w.workerIndex) + 1}: ${w.name}`,
      `- Session: \`${w.sessionId}\``,
      `- Task doc: \`.agents/tasks/${workerTaskFileName(w)}\``,
      `- FYP progress mirror: \`.fyp/task.md\``,
      `- Primary root: \`${w.worktreePath || w.projectPath}\``,
      `- Branch: \`${w.branch || "(shared)"}\``,
      "",
      "Status fields to maintain:",
      "- Current phase",
      "- Checklist with checkboxes",
      "- Blockers",
      "- Files touched",
      "- Verification command + output snippet",
      "- Handoff summary",
    ].join("\n");
  });

  return [
    "# Runtime Ownership Map",
    "",
    `Generated: ${nowIso()}`,
    `Orchestration ID: \`${input.orchestrationId}\``,
    "",
    "This document defines where the orchestrator should read worker progress and how UI should map worker state.",
    "",
    ...rows,
    "",
    "## UI mapping notes",
    "- Prefer `.agents/tasks/worker-*.md` when present.",
    "- Fallback to `.fyp/task.md` or `task.md` if worker file is missing.",
    "- Checklist counts derive from markdown checkboxes.",
    "- Preview text should be extracted from first meaningful non-empty lines.",
  ].join("\n");
}

function buildWorkerTaskDoc(input: OrchestrationDocsInput, worker: OrchestrationDocsWorker): string {
  const role = inferWorkerRole({
    role: typeof worker.role === "string" ? worker.role : "",
    name: worker.name,
    taskPrompt: worker.taskPrompt,
    profileId: worker.profileId,
  });
  return [
    `# Worker ${Number(worker.workerIndex) + 1} Task Card`,
    "",
    `Generated: ${nowIso()}`,
    `Orchestration ID: \`${input.orchestrationId}\``,
    `Worker name: ${worker.name}`,
    `Worker role: \`${role}\``,
    `Session ID: \`${worker.sessionId}\``,
    `Tool/profile: \`${worker.tool}/${worker.profileId}\``,
    `Dispatch mode: \`${input.dispatchMode}\``,
    "",
    "## Objective",
    input.objective,
    "",
    "## Assigned prompt (seed)",
    "```text",
    String(worker.taskPrompt || "").trim(),
    "```",
    "",
    "## Worker system prompt contract (runtime)",
    "```text",
    String(worker.systemPrompt || "(provided at runtime bootstrap)").trim(),
    "```",
    "",
    "## Communication contract",
    "- Follow orchestrator dispatch format strictly.",
    "- Do not chat with peer workers directly.",
    "- Ask structured question packets for blockers/safety gates only.",
    "- Question packet format (exact): QUESTION / CONTEXT / FILES / OPTIONS / RECOMMENDED / BLOCKING.",
    "- If not blocked, continue and update checklist.",
    "",
    "## Checklist",
    "- [ ] Read current orchestrator dispatch",
    "- [ ] Confirm owned scope and non-goals",
    "- [ ] Record planned files before editing",
    "- [ ] Implement scoped changes only",
    "- [ ] Run verification command(s)",
    "- [ ] Update Files touched section",
    "- [ ] Post concise status for orchestrator",
    "",
    "## Scope",
    "- Owner files/directories: _(fill from orchestrator dispatch)_",
    "- Forbidden files/directories: _(fill from orchestrator dispatch)_",
    "",
    "## Progress log",
    "### Cycle 1",
    "- Status: pending",
    "- Summary:",
    "- Evidence:",
    "- Next:",
    "",
    "### Cycle 2",
    "- Status: pending",
    "- Summary:",
    "- Evidence:",
    "- Next:",
    "",
    "### Cycle 3",
    "- Status: pending",
    "- Summary:",
    "- Evidence:",
    "- Next:",
    "",
    "## Blockers",
    "- None.",
    "",
    "## Files touched",
    "- _(none yet)_",
    "",
    "## Verification",
    "- Command:",
    "- Result:",
    "- Notes:",
    "",
    "## Handoff draft",
    "- Completed:",
    "- Pending:",
    "- Risks:",
    "- Suggested next action:",
  ].join("\n");
}

function buildFypTaskDoc(input: OrchestrationDocsInput, worker: OrchestrationDocsWorker): string {
  return [
    `# ${input.orchestrationName} :: ${worker.name}`,
    "",
    `Orchestration: \`${input.orchestrationId}\``,
    `Session: \`${worker.sessionId}\``,
    "",
    "## Objective",
    input.objective,
    "",
    "## Scope",
    "- Fill from orchestrator dispatch.",
    "",
    "## Checklist",
    "- [ ] Bootstrap acknowledged",
    "- [ ] Scope confirmed",
    "- [ ] Implementation in progress",
    "- [ ] Verification completed",
    "- [ ] Handoff completed",
    "",
    "## Blockers",
    "- None",
    "",
    "## Files touched",
    "- _(none yet)_",
    "",
    "## Verification",
    "- Command:",
    "- Output:",
  ].join("\n");
}

function uniqueWorkerRoots(input: OrchestrationDocsInput): Array<{ rootPath: string; worker: OrchestrationDocsWorker }> {
  const seen = new Set<string>();
  const out: Array<{ rootPath: string; worker: OrchestrationDocsWorker }> = [];
  for (const w of input.workers) {
    const rootPath = path.resolve(w.worktreePath || w.projectPath || input.projectPath);
    const key = `${rootPath}::${workerTaskFileName(w)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ rootPath, worker: w });
  }
  return out;
}

export function scaffoldOrchestrationDocs(input: OrchestrationDocsInput): OrchestrationDocsWriteResult {
  const result: OrchestrationDocsWriteResult = { written: [], skipped: [], errors: [] };
  const projectRoot = path.resolve(input.projectPath);
  const agentsRoot = path.join(projectRoot, ".agents");
  const systemRoot = path.join(agentsRoot, "system");
  const tasksRoot = path.join(agentsRoot, "tasks");

  writeTextFile(path.join(agentsRoot, "README.md"), buildAgentsReadme(input), result);
  writeTextFile(path.join(systemRoot, "orchestrator.md"), buildOrchestratorPolicy(input), result);
  writeTextFile(path.join(systemRoot, "command-bus.md"), buildCommandBusDoc(input), result);
  writeTextFile(path.join(systemRoot, "runtime-map.md"), buildRuntimeMapDoc(input), result);
  writeTextFile(path.join(systemRoot, "master-prompt-library.md"), buildMasterSystemPromptLibrary({ minLines: 4096 }), result);
  writeTextFile(
    path.join(systemRoot, "runtime-worker-contracts.md"),
    [
      "# Runtime Worker Contracts",
      "",
      `Generated: ${nowIso()}`,
      "",
      ...input.workers.map((w) => {
        const role = inferWorkerRole({
          role: typeof w.role === "string" ? w.role : "",
          name: w.name,
          taskPrompt: w.taskPrompt,
          profileId: w.profileId,
        });
        return [
          `## Worker ${Number(w.workerIndex) + 1}: ${w.name}`,
          `Role: \`${role}\``,
          `Tool/profile: \`${w.tool}/${w.profileId}\``,
          "```text",
          String(w.systemPrompt || "(runtime provided)").trim(),
          "```",
          "",
        ].join("\n");
      }),
    ].join("\n"),
    result,
  );
  for (const w of input.workers) {
    writeTextFile(path.join(tasksRoot, workerTaskFileName(w)), buildWorkerTaskDoc(input, w), result);
  }

  for (const { rootPath, worker } of uniqueWorkerRoots(input)) {
    const workerAgentsRoot = path.join(rootPath, ".agents");
    const workerTasksRoot = path.join(workerAgentsRoot, "tasks");
    const workerReadme = [
      "# Worker-local .agents",
      "",
      `Generated: ${nowIso()}`,
      `Orchestration ID: \`${input.orchestrationId}\``,
      "",
      "This local mirror exists so worker runtime and UI can always read task state from current cwd.",
      "",
      `Primary task doc: \`.agents/tasks/${workerTaskFileName(worker)}\``,
      "Progress mirror: `.fyp/task.md`",
      "",
      `Reference orchestrator docs in project root: \`${relOrSelf(rootPath, path.join(projectRoot, ".agents", "README.md"))}\``,
    ].join("\n");
    writeTextFile(path.join(workerAgentsRoot, "README.md"), workerReadme, result);
    writeTextFile(path.join(workerTasksRoot, workerTaskFileName(worker)), buildWorkerTaskDoc(input, worker), result);
    writeTextFile(path.join(rootPath, ".fyp", "task.md"), buildFypTaskDoc(input, worker), result, { ifMissing: true });
  }

  return result;
}

export function persistRuntimeBootstrapDocs(input: RuntimeBootstrapDocInput): OrchestrationDocsWriteResult {
  const result: OrchestrationDocsWriteResult = { written: [], skipped: [], errors: [] };
  const projectRoot = path.resolve(input.projectPath);
  const systemRoot = path.join(projectRoot, ".agents", "system");
  writeTextFile(path.join(systemRoot, "runtime-bootstrap-orchestrator.md"), input.orchestratorBootstrap, result);

  for (const w of input.workers) {
    const nameSlug = slug(w.workerName);
    const fileName = `runtime-bootstrap-worker-${Number(w.workerIndex) + 1}-${nameSlug}.md`;
    const localSystemRoot = path.join(path.resolve(w.rootPath), ".agents", "system");
    writeTextFile(path.join(localSystemRoot, fileName), w.bootstrap, result);
    if (typeof w.workerSystemPrompt === "string" && w.workerSystemPrompt.trim()) {
      const role = inferWorkerRole({
        role: typeof w.workerRole === "string" ? w.workerRole : "",
        name: w.workerName,
        taskPrompt: "",
        profileId: typeof w.workerProfileId === "string" ? w.workerProfileId : "",
      });
      writeTextFile(
        path.join(localSystemRoot, `runtime-worker-contract-${Number(w.workerIndex) + 1}-${nameSlug}.md`),
        [
          `# Runtime Worker Contract: ${w.workerName}`,
          "",
          `Generated: ${nowIso()}`,
          `Role: \`${role}\``,
          `Profile: \`${String(w.workerProfileId || "(unknown)")}\``,
          "",
          "```text",
          String(w.workerSystemPrompt).trim(),
          "```",
        ].join("\n"),
        result,
      );
    }
  }

  return result;
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type HarnessBudget = "low" | "balanced" | "high";
export type HarnessPriority = "speed" | "balanced" | "quality";

export type HarnessCreatorPrefs = {
  budget: HarnessBudget;
  priority: HarnessPriority;
  maxWorkers: number;
  allowWorkspaceScan: boolean;
};

export type WorkspaceScanSummary = {
  root: string;
  fileCount: number;
  tsFileCount: number;
  jsFileCount: number;
  pyFileCount: number;
  goFileCount: number;
  rsFileCount: number;
  testFileCount: number;
  frontendLikely: boolean;
  backendLikely: boolean;
};

export type AgentCommandDef = {
  id: string;
  title: string;
  summary: string;
  whenToUse: string;
  payloadTemplate: string;
};

export type ExpertPlaybookDef = {
  id: string;
  title: string;
  mode: "debug" | "normal" | "both";
  path: string;
  focus: string;
};

export type WorkerRoleKey = "backend" | "frontend" | "debug" | "integration" | "perf";

export type CreatorWorkerPlan = {
  name: string;
  role: string;
  tool: "codex" | "claude" | "opencode";
  profileId: string;
  taskPrompt: string;
  systemPrompt?: string;
  rationale: string;
};

export type CreatorRecommendation = {
  creator: {
    tool: "opencode" | "codex" | "claude";
    profileId: string;
    systemPrompt: string;
  };
  orchestrator: {
    tool: "codex" | "claude" | "opencode";
    profileId: string;
    systemPrompt: string;
    dispatchMode: "orchestrator-first" | "worker-first";
  };
  workers: CreatorWorkerPlan[];
  notes: string[];
  confidence: number;
  commandCatalog: AgentCommandDef[];
};

type SkillDomain =
  | "security"
  | "debugging"
  | "testing"
  | "orchestration"
  | "frontend"
  | "mobile"
  | "accessibility"
  | "reliability"
  | "observability"
  | "integration";

export type HarnessSkillRecord = {
  name: string;
  description: string;
  path: string;
  domain: SkillDomain;
  sourceRoot: string;
  qualityScore: number;
  qualitySignals: string[];
};

export type HarnessCommandCoverage = {
  commandId: string;
  requiredDomains: SkillDomain[];
  coveredDomains: SkillDomain[];
  missingDomains: SkillDomain[];
  supportingSkills: string[];
  supportScore: number;
  confidence: "high" | "medium" | "low";
  covered: boolean;
};

export type HarnessSotaAudit = {
  generatedAt: string;
  skillRoots: string[];
  missingRoots: string[];
  skillCount: number;
  skillsByDomain: Record<SkillDomain, number>;
  domainQuality: Record<SkillDomain, number>;
  averageSkillQuality: number;
  sampledSkills: HarnessSkillRecord[];
  commandCoverage: HarnessCommandCoverage[];
  uncoveredCommands: string[];
  recommendations: string[];
};

function clampInt(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

function normText(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function cleanRoleToken(v: unknown): string {
  return String(v ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function titleSlug(v: string): string {
  const s = String(v || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "worker";
}

function compactPromptBlock(
  text: string,
  opts?: { maxLines?: number; maxChars?: number },
): { text: string; truncated: boolean } {
  const raw = String(text ?? "").trim();
  if (!raw) return { text: "", truncated: false };

  const maxLines = clampInt(Number(opts?.maxLines ?? 48), 8, 400);
  const maxChars = clampInt(Number(opts?.maxChars ?? 4800), 400, 64000);
  const lines = raw.split(/\r?\n/);
  let out = lines.slice(0, maxLines).join("\n");
  let truncated = lines.length > maxLines;

  if (out.length > maxChars) {
    out = out.slice(0, maxChars);
    truncated = true;
  }
  return { text: out.trim(), truncated };
}

function renderCommandCatalogForPrompt(
  catalog: AgentCommandDef[],
  opts?: { maxItems?: number; includeWhenToUse?: boolean },
): string {
  const maxItems = clampInt(Number(opts?.maxItems ?? 18), 6, 120);
  const includeWhenToUse = opts?.includeWhenToUse !== false;
  const trimmed = catalog.slice(0, maxItems);
  const rows = trimmed.map((c) =>
    includeWhenToUse
      ? `  [${c.id}] ${c.summary}\n   → Use: ${c.whenToUse}`
      : `  [${c.id}] ${c.summary}`,
  );
  if (catalog.length > trimmed.length) {
    rows.push(`  ... ${catalog.length - trimmed.length} more commands in docs/agent-command-library/README.md`);
  }
  return rows.join("\n\n");
}

// ── Command Catalog ───────────────────────────────────────────────────────────

export function defaultCommandCatalog(): AgentCommandDef[] {
  return [
    {
      id: "replan",
      title: "Replan",
      summary: "Re-scope tasks after new evidence, blockers, or changed assumptions.",
      whenToUse: "When a worker is stuck, when discovered complexity invalidates original plan, or when scope must shrink.",
      payloadTemplate: "Goal delta, what changed, blockers, updated worker assignments, new acceptance criteria.",
    },
    {
      id: "review-hard",
      title: "Hard Review",
      summary: "Full regression + risk-focused review before integration or risky merge.",
      whenToUse: "Before final integration, before risky refactors, or when quality gate must be met.",
      payloadTemplate: "Target files, suspected regressions, required test evidence, pass/fail criteria.",
    },
    {
      id: "sync-status",
      title: "Sync Status",
      summary: "Collect concise progress from all workers with blockers-first format.",
      whenToUse: "Periodic checkpoints, before user-facing updates, before dispatching next phase.",
      payloadTemplate: "Requested granularity (file-level / module-level), deadline if any, blockers-first format.",
    },
    {
      id: "handoff",
      title: "Handoff",
      summary: "Produce structured handoff for next agent or session resumption.",
      whenToUse: "When stopping work, switching workers, or producing final deliverable summary.",
      payloadTemplate: "Done list (with evidence), pending list, risks, exact next command per pending item.",
    },
    {
      id: "scope-lock",
      title: "Scope Lock",
      summary: "Explicitly restrict a worker to a named set of files/directories.",
      whenToUse: "When a worker is drifting outside their ownership boundary.",
      payloadTemplate: "Worker name, allowed file list, forbidden patterns, consequence if violated.",
    },
    {
      id: "conflict-resolve",
      title: "Conflict Resolve",
      summary: "Mediate when two workers have produced conflicting implementations.",
      whenToUse: "When integration fails, duplicate implementations detected, or interface contracts diverge.",
      payloadTemplate: "Files in conflict, authoritative version, resolution strategy, which worker applies fix.",
    },
    {
      id: "frontend-pass",
      title: "Frontend Pass",
      summary: "Constrain design work to explicit UX goals and visual acceptance checks.",
      whenToUse: "UI polish, redesign, responsive or accessibility pass.",
      payloadTemplate: "Screens in scope, target behaviors, visual constraints, QA checklist.",
    },
    {
      id: "backend-hardening",
      title: "Backend Hardening",
      summary: "Focus on reliability: locks, cleanup, error recovery, and edge cases.",
      whenToUse: "Race conditions, session leaks, orchestration stability work, before production deploy.",
      payloadTemplate: "Critical paths, known failure modes, verification commands, rollback plan.",
    },
    {
      id: "security-threat-model",
      title: "Security Threat Model",
      summary: "Run structured threat modeling and produce prioritized risk statements.",
      whenToUse: "Before security-sensitive refactors, new auth/data flows, or when new attack surface is added.",
      payloadTemplate: "Assets, trust boundaries, entry points, abuse cases, highest-risk controls to add first.",
    },
    {
      id: "security-vuln-repro",
      title: "Vuln Repro (Safe Lab)",
      summary: "Reproduce a suspected vulnerability in an authorized, isolated environment with evidence.",
      whenToUse: "Debug mode only, after explicit scope authorization, when a security bug must be verified before fixing.",
      payloadTemplate:
        "Authorized scope proof, isolated repro steps, expected vulnerable behavior, evidence artifacts, stop conditions.",
    },
    {
      id: "security-remediation",
      title: "Security Remediation",
      summary: "Implement minimal fix for verified vulnerability and add regression/security tests.",
      whenToUse: "After vulnerability reproduction confirms root cause and affected code path.",
      payloadTemplate: "Root cause file:line, mitigation strategy, tests added, rollback trigger, residual risk note.",
    },
    {
      id: "dependency-risk-audit",
      title: "Dependency Risk Audit",
      summary: "Audit dependencies for known vulnerabilities and risky update posture.",
      whenToUse: "Before release, after major dependency updates, or during security hardening cycles.",
      payloadTemplate: "Advisory source, affected versions, exploitability in this repo, patch/upgrade plan.",
    },
    {
      id: "data-integrity-audit",
      title: "Data Integrity Audit",
      summary: "Validate invariants, transaction boundaries, and corruption/partial-write protection.",
      whenToUse: "State corruption incidents, migration work, async write paths, or concurrency-heavy modules.",
      payloadTemplate: "Critical invariants, corruption scenarios, checks/tests, recovery/rollback plan.",
    },
    {
      id: "contract-audit",
      title: "Contract Audit",
      summary: "Validate API/schema/worker contract compatibility and drift.",
      whenToUse: "Integration regressions, shared-type changes, multi-worker merge phases.",
      payloadTemplate: "Producer/consumer list, contract diffs, compatibility matrix, migration steps.",
    },
    {
      id: "perf-regression-lab",
      title: "Perf Regression Lab",
      summary: "Measure and isolate performance regressions with reproducible baselines.",
      whenToUse: "Latency/throughput complaints, CPU/memory spikes, or before high-risk release.",
      payloadTemplate: "Baseline metrics, load profile, bottleneck hypothesis, before/after evidence.",
    },
    {
      id: "accessibility-hard-check",
      title: "Accessibility Hard Check",
      summary: "Run strict keyboard/screen-reader/contrast checks and remediate violations.",
      whenToUse: "UI delivery gates, mobile polish passes, or when interaction regressions are suspected.",
      payloadTemplate: "Views in scope, WCAG criteria, test matrix, violated checks, fixes + proof.",
    },
    {
      id: "diag-evidence",
      title: "Diagnostic Evidence",
      summary: "Collect deterministic repro evidence and trace path before implementing fixes.",
      whenToUse: "Any bug/instability investigation before first code patch.",
      payloadTemplate: "Bug title, scope, repro command, logs/trace sources, expected failing signal.",
    },
    {
      id: "test-tdd",
      title: "TDD Execution",
      summary: "Enforce red-green-refactor with explicit failing-then-passing proof.",
      whenToUse: "Features, bugfixes, and behavior changes where regression risk exists.",
      payloadTemplate: "Test path, expected failing behavior, scope, edge cases to add.",
    },
    {
      id: "verify-completion",
      title: "Verify Completion",
      summary: "Require fresh verification command outputs before completion claims.",
      whenToUse: "Before marking any task complete or sending final worker result.",
      payloadTemplate: "Claim being made, exact verify commands, expected pass criteria.",
    },
    {
      id: "review-request",
      title: "Review Request",
      summary: "Request structured review with severity handling and remediation loop.",
      whenToUse: "After major task batches, risky edits, or pre-integration checkpoints.",
      payloadTemplate: "baseSha, headSha, review dimensions, required remediation threshold.",
    },
    {
      id: "security-sast",
      title: "Security SAST",
      summary: "Run static security scans and map findings to mitigation actions.",
      whenToUse: "Security-sensitive paths, auth/data-flow changes, and pre-release hardening.",
      payloadTemplate: "scan command, scope, threat mapping links, gating policy for critical findings.",
    },
    {
      id: "coord-task",
      title: "Coordinate Task",
      summary: "Create strict worker task packets with ownership and acceptance boundaries.",
      whenToUse: "Task dispatch, scope corrections, and ownership drift prevention.",
      payloadTemplate: "TASK/SCOPE/NOT-YOUR-JOB/DONE-WHEN/VERIFY/PRIORITY packet fields.",
    },
    {
      id: "team-launch",
      title: "Team Launch",
      summary: "Select a right-sized team profile and role split for current complexity.",
      whenToUse: "At orchestration startup or when major scope changes require recomposition.",
      payloadTemplate: "Desired profile, worker count, role map, ownership partitions, risk focus.",
    },
    {
      id: "threat-model-stride",
      title: "Threat Model STRIDE",
      summary: "Run STRIDE-based threat modeling and prioritized mitigation planning.",
      whenToUse: "New attack surface, auth/data-path changes, or pre-hardening planning.",
      payloadTemplate: "System boundaries, assets, trust zones, STRIDE threats, severity ranking.",
    },
    {
      id: "attack-tree-map",
      title: "Attack Tree Map",
      summary: "Build attack trees to visualize exploit paths and control gaps.",
      whenToUse: "Complex multi-step security scenarios needing structured decomposition.",
      payloadTemplate: "Goal node, OR/AND branches, preconditions, controls, detection points.",
    },
    {
      id: "security-requirements",
      title: "Security Requirements",
      summary: "Extract concrete, testable security requirements from threats.",
      whenToUse: "After threat model completion and before implementation hardening.",
      payloadTemplate: "Threat->requirement links, acceptance criteria, test cases, compliance mapping.",
    },
    {
      id: "mitigation-map",
      title: "Mitigation Map",
      summary: "Map threats to preventive/detective/corrective controls with coverage scoring.",
      whenToUse: "Security design reviews and remediation planning.",
      payloadTemplate: "Threat IDs, controls, control type, residual risk, ownership, due dates.",
    },
    {
      id: "auth-hardening",
      title: "Auth Hardening",
      summary: "Harden auth/session/token paths and enforce authorization invariants.",
      whenToUse: "Auth regressions, session leaks, permission boundary bugs, token lifecycle updates.",
      payloadTemplate: "Auth flow scope, token/session model, invariants, abuse cases, verify commands.",
    },
    {
      id: "error-path-audit",
      title: "Error Path Audit",
      summary: "Audit error paths for context propagation, cleanup, and safe degradation.",
      whenToUse: "Crashes, swallowed errors, inconsistent retries, resource leaks.",
      payloadTemplate: "Critical error paths, expected behavior, logging model, cleanup checks.",
    },
    {
      id: "resilience-chaos-check",
      title: "Resilience Chaos Check",
      summary: "Validate behavior under controlled fault injection and interruption scenarios.",
      whenToUse: "Before release on critical paths or after reliability incidents.",
      payloadTemplate: "Fault scenarios, blast radius, expected fallback, safety stop conditions.",
    },
    {
      id: "observability-pass",
      title: "Observability Pass",
      summary: "Ensure logs/metrics/traces expose root-cause-ready signals.",
      whenToUse: "When debugging quality is poor or incident triage is slow.",
      payloadTemplate: "Critical spans/events, metrics, alert thresholds, correlation IDs.",
    },
    {
      id: "incident-drill",
      title: "Incident Drill",
      summary: "Run tabletop/operational incident drill with recovery checkpoints.",
      whenToUse: "Pre-release readiness and post-incident learning cycles.",
      payloadTemplate: "Scenario, responders, runbook steps, escalation path, recovery criteria.",
    },
    {
      id: "contract-drift-check",
      title: "Contract Drift Check",
      summary: "Detect and block producer/consumer contract drift.",
      whenToUse: "Shared schema/type/interface updates and integration regressions.",
      payloadTemplate: "Producer list, consumer list, diffs, compatibility result, migration action.",
    },
    {
      id: "integration-gate",
      title: "Integration Gate",
      summary: "Gate integration with compatibility, regression, and ownership checks.",
      whenToUse: "Before merging parallel worker outputs.",
      payloadTemplate: "Merge scope, conflict scan, required tests, owner approvals.",
    },
    {
      id: "rollback-drill",
      title: "Rollback Drill",
      summary: "Validate rollback trigger/procedure and restoration confidence.",
      whenToUse: "High-risk changes in critical paths.",
      payloadTemplate: "Trigger, rollback steps, validation checks, max rollback time.",
    },
    {
      id: "release-readiness",
      title: "Release Readiness",
      summary: "Run full readiness gate across quality, security, reliability, and docs.",
      whenToUse: "Pre-release or major deployment decisions.",
      payloadTemplate: "Release scope, required gates, unresolved risks, go/no-go criteria.",
    },
    {
      id: "flake-hunt",
      title: "Flake Hunt",
      summary: "Identify and stabilize flaky tests with deterministic repro loops.",
      whenToUse: "Intermittent CI/test failures.",
      payloadTemplate: "Flaky target, rerun policy, environment controls, stabilization plan.",
    },
    {
      id: "perf-budget-gate",
      title: "Perf Budget Gate",
      summary: "Enforce latency/throughput/memory budgets before approval.",
      whenToUse: "Performance-sensitive changes and release checks.",
      payloadTemplate: "Budget targets, baseline, current metrics, delta explanation.",
    },
    {
      id: "frontend-mobile-gate",
      title: "Frontend Mobile Gate",
      summary: "Run mobile-first responsive and platform-ergonomic quality gate.",
      whenToUse: "UI tasks touching layout/navigation/interaction patterns.",
      payloadTemplate: "Viewports, platform checks, touch ergonomics, overflow checks.",
    },
    {
      id: "motion-reduced-check",
      title: "Motion Reduced Check",
      summary: "Validate reduced-motion accessibility and animation fallback behavior.",
      whenToUse: "Any UI with transitions/animations/interactive motion.",
      payloadTemplate: "Animated surfaces, reduced-mode behavior, fallback communication path.",
    },
    {
      id: "design-parity-matrix",
      title: "Design Parity Matrix",
      summary: "Track parity gaps across web, Android, and iOS surfaces.",
      whenToUse: "Cross-platform product surfaces with shared requirements.",
      payloadTemplate: "Features by platform, parity status, intentional differences, owner.",
    },
    {
      id: "ownership-audit",
      title: "Ownership Audit",
      summary: "Audit file/module ownership to prevent overlap and conflict.",
      whenToUse: "Parallel workstreams and recurring merge conflicts.",
      payloadTemplate: "Workers, owned paths, overlap findings, reassignments.",
    },
    {
      id: "communication-audit",
      title: "Communication Audit",
      summary: "Audit worker/orchestrator messaging quality and blocker handling.",
      whenToUse: "Chatty/noisy orchestration, missing blocker packets, unclear decisions.",
      payloadTemplate: "Message samples, protocol violations, correction plan, cadence updates.",
    },
  ];
}

const PROFILE_PLAYBOOK = [
  {
    profileId: "codex.default",
    bestFor: "Balanced implementation tasks where deterministic edits and measured progress matter.",
    avoidFor: "Creative-heavy UI ideation without concrete acceptance criteria.",
    behavior: "Use short implementation loops, explicit verification after each meaningful edit.",
    evidence: "Prefer `npm run build`, targeted tests, and concise transcript updates.",
  },
  {
    profileId: "codex.full_auto",
    bestFor: "Debug/verification workers, stabilization passes, and high-autonomy bugfix loops.",
    avoidFor: "Open-ended architecture redesign without scope lock.",
    behavior: "Run reproduce -> patch -> verify cycles and avoid broad refactors.",
    evidence: "Always emit BUG/ROOT/FIX/TEST/RESULT and include exact command output snippets.",
  },
  {
    profileId: "claude.default",
    bestFor: "Orchestration, planning, review synthesis, and tradeoff-heavy reasoning.",
    avoidFor: "High-volume mechanical file edits where a code-focused model is better.",
    behavior: "Decompose work, dispatch precisely, maintain risk register and no-op discipline.",
    evidence: "Include dispatch receipts, worker evidence review, and clear approval decisions.",
  },
  {
    profileId: "claude.accept_edits",
    bestFor: "Frontend implementation with visual quality constraints and iterative polishing.",
    avoidFor: "Latency-sensitive backend hardening loops.",
    behavior: "Prioritize UX acceptance checks, responsive behavior, and accessibility rules.",
    evidence: "Record viewport checks, interaction checks, and regression coverage.",
  },
  {
    profileId: "opencode.default",
    bestFor: "Cheap planning/prototyping and low-risk preparation tasks.",
    avoidFor: "Mission-critical integration without a stronger verifier.",
    behavior: "Generate concise draft plans and route risky implementation to stronger workers.",
    evidence: "Focus on clear task decomposition and validation checkpoints.",
  },
  {
    profileId: "opencode.minimax_free",
    bestFor: "Cost-aware creator planning and initial decomposition.",
    avoidFor: "Deep multi-hop debugging without explicit evidence loops.",
    behavior: "Keep prompts constrained, deterministic, and tightly scoped.",
    evidence: "Provide structured task specs and measurable done criteria.",
  },
  {
    profileId: "opencode.kimi_free",
    bestFor: "Low-cost recommendation generation and prompt scaffolding.",
    avoidFor: "Unbounded autonomous coding in complex shared-state repositories.",
    behavior: "Treat output as planning substrate; assign execution to codex/claude workers.",
    evidence: "Emit role assignments, scope boundaries, and verification commands.",
  },
] as const;

export function buildProfilePlaybookPrompt(): string {
  const lines: string[] = [
    "PROFILE EXECUTION PLAYBOOK",
    "Use this matrix when assigning profiles and evaluating whether behavior matches model strengths.",
  ];

  for (const p of PROFILE_PLAYBOOK) {
    lines.push("");
    lines.push(`Profile: ${p.profileId}`);
    lines.push(`- Best for: ${p.bestFor}`);
    lines.push(`- Avoid for: ${p.avoidFor}`);
    lines.push(`- Behavior contract: ${p.behavior}`);
    lines.push(`- Evidence expectation: ${p.evidence}`);
  }
  return lines.join("\n");
}

const UNIVERSAL_PRINCIPLES = [
  "[1] PRECISION OVER BREADTH. Never touch files outside assigned scope.",
  "[2] EVIDENCE-BASED COMPLETION. Never claim done without verification output.",
  "[3] BLOCKERS FIRST. Status = blockers, progress, next action.",
  "[4] NO AMBIGUOUS SCOPE. Ask for measurable criteria before acting on vague tasks.",
  "[5] ANTI-SLOP. No dead code, placeholders, speculative rewrites, or duplicate logic.",
  "[6] ANTI-CONFLICT. Shared files require explicit ownership/coordination.",
  "[7] COMMUNICATION BATCH. Group related questions instead of chatty interruptions.",
  "[8] REGRESSION SAFETY. Re-run relevant verification after each meaningful change.",
  "[9] SCOPE DISCIPLINE. Log out-of-scope findings, do not silently expand scope.",
  "[10] APPROVAL CRITERIA. Approve only aligned, in-scope, low-conflict, evidenced actions.",
] as const;

const EXPERT_PLAYBOOKS: ExpertPlaybookDef[] = [
  {
    id: "security-debug-pentest",
    title: "Security Debug + Pentest (Authorized)",
    mode: "debug",
    path: "docs/agent-command-library/01-security-debug-pentest.md",
    focus:
      "Safe-lab vulnerability reproduction, exploitability validation, root-cause security fixes, and regression hardening.",
  },
  {
    id: "backend-reliability-resilience",
    title: "Backend Reliability + Resilience",
    mode: "both",
    path: "docs/agent-command-library/02-backend-reliability-resilience.md",
    focus:
      "Concurrency safety, timeout/retry correctness, cleanup guarantees, state integrity, and rollback readiness.",
  },
  {
    id: "api-integration-contracts",
    title: "API + Integration Contracts",
    mode: "both",
    path: "docs/agent-command-library/03-api-integration-contracts.md",
    focus:
      "Contract drift prevention, schema/version compatibility, integration gate checks, and merge-safe ownership.",
  },
  {
    id: "frontend-quality-accessibility",
    title: "Frontend Quality + Accessibility",
    mode: "normal",
    path: "docs/agent-command-library/04-frontend-quality-accessibility.md",
    focus:
      "Responsive correctness, keyboard/screen-reader behavior, interaction reliability, and visual QA evidence.",
  },
  {
    id: "orchestrator-expert-operations",
    title: "Orchestrator Expert Operations",
    mode: "both",
    path: "docs/agent-command-library/05-orchestrator-expert-operations.md",
    focus:
      "Dispatch strategy, no-op discipline, question handling, conflict arbitration, and evidence-first approvals.",
  },
  {
    id: "skill-crosswalk-security-orchestration",
    title: "Skill Crosswalk: Security + Orchestration",
    mode: "both",
    path: "docs/agent-command-library/06-skill-crosswalk-security-orchestration.md",
    focus:
      "Skill-derived debug/TDD/verification/security/team protocols mapped into enforceable command workflows.",
  },
  {
    id: "skill-crosswalk-frontend-mobile",
    title: "Skill Crosswalk: Frontend + Mobile",
    mode: "normal",
    path: "docs/agent-command-library/07-skill-crosswalk-frontend-mobile.md",
    focus:
      "Skill-derived responsive, platform, accessibility, and interaction quality gates for UI work.",
  },
  {
    id: "command-automation-recipes",
    title: "Command Automation Recipes",
    mode: "both",
    path: "docs/agent-command-library/08-command-automation-recipes.md",
    focus:
      "Concrete command payload recipes for dispatch, evidence, verification, review, and security scan orchestration.",
  },
  {
    id: "sota-gap-matrix",
    title: "SOTA Gap Matrix",
    mode: "both",
    path: "docs/agent-command-library/09-sota-gap-matrix.md",
    focus:
      "Maturity scoring and adoption checklist for state-of-the-art worker/orchestrator operating quality.",
  },
  {
    id: "threat-modeling-and-sast-pipeline",
    title: "Threat Modeling + SAST Pipeline",
    mode: "debug",
    path: "docs/agent-command-library/10-threat-modeling-and-sast-pipeline.md",
    focus:
      "STRIDE, attack trees, threat-to-control mapping, and SAST triage integrated as an execution gate.",
  },
  {
    id: "debug-hypothesis-lab",
    title: "Debug Hypothesis Lab",
    mode: "debug",
    path: "docs/agent-command-library/11-debug-hypothesis-lab.md",
    focus:
      "Repro-first debugging, disproof-driven hypothesis loops, flake isolation, and failure-injection validation.",
  },
  {
    id: "testing-verification-review-gates",
    title: "Testing + Verification + Review Gates",
    mode: "both",
    path: "docs/agent-command-library/12-testing-verification-review-gates.md",
    focus:
      "TDD discipline, verification-before-completion, and severity-calibrated review closure.",
  },
  {
    id: "auth-and-session-hardening",
    title: "Auth + Session Hardening",
    mode: "debug",
    path: "docs/agent-command-library/13-auth-and-session-hardening.md",
    focus:
      "Token/session lifecycle hardening, authorization invariants, and abuse resistance verification.",
  },
  {
    id: "error-handling-and-recovery-patterns",
    title: "Error Handling + Recovery",
    mode: "both",
    path: "docs/agent-command-library/14-error-handling-and-recovery-patterns.md",
    focus:
      "Failure semantics, retries/timeouts, cleanup guarantees, and recovery-safe observability.",
  },
  {
    id: "team-communication-and-task-governance",
    title: "Team Communication + Task Governance",
    mode: "both",
    path: "docs/agent-command-library/15-team-communication-and-task-governance.md",
    focus:
      "Structured dispatch protocols, blocker packet quality, and low-noise orchestrator governance.",
  },
  {
    id: "parallel-execution-and-conflict-arbitration",
    title: "Parallel Execution + Conflict Arbitration",
    mode: "both",
    path: "docs/agent-command-library/16-parallel-execution-and-conflict-arbitration.md",
    focus:
      "Ownership-safe parallelization, conflict detection, arbitration flow, and integration gates.",
  },
  {
    id: "release-readiness-rollback-incident",
    title: "Release Readiness + Rollback + Incident",
    mode: "both",
    path: "docs/agent-command-library/17-release-readiness-rollback-incident.md",
    focus:
      "Go/no-go policy, rollback drills, incident readiness, and operational release governance.",
  },
  {
    id: "frontend-platform-parity-motion",
    title: "Frontend Platform Parity + Motion",
    mode: "normal",
    path: "docs/agent-command-library/18-frontend-platform-parity-motion.md",
    focus:
      "Cross-platform parity, responsive/mobile ergonomics, interaction quality, and reduced-motion correctness.",
  },
  {
    id: "observability-and-slo-ops",
    title: "Observability + SLO Ops",
    mode: "both",
    path: "docs/agent-command-library/19-observability-and-slo-ops.md",
    focus:
      "Tracing/metrics/logging standards, SLO definitions, and alert/runbook effectiveness for incident triage.",
  },
  {
    id: "expanded-command-reference",
    title: "Expanded Command Reference",
    mode: "both",
    path: "docs/agent-command-library/20-expanded-command-reference.md",
    focus:
      "Canonical command semantics, safety levels, output contracts, and escalation/dispatch rules.",
  },
  {
    id: "deep-research-foundations",
    title: "Deep Research Foundations",
    mode: "both",
    path: "docs/agent-command-library/21-deep-research-foundations.md",
    focus:
      "External standards grounding for idempotency, security quality gates, validation posture, and accessibility baselines.",
  },
];

export function expertPlaybookCatalog(): ExpertPlaybookDef[] {
  return EXPERT_PLAYBOOKS.slice();
}

function buildExpertPlaybookIndexPrompt(): string {
  const rows = EXPERT_PLAYBOOKS.map((p) => `- [${p.id}] (${p.mode}) ${p.title}\n  path: ${p.path}\n  focus: ${p.focus}`);
  return [
    "EXPERT PLAYBOOK INDEX",
    "Read relevant playbooks before high-risk decisions, debug triage, or release-critical changes.",
    "Security debug workflows are authorized-scope only; never perform unauthorized exploitation.",
    ...rows,
  ].join("\n");
}

const SKILL_DOMAIN_LIST: SkillDomain[] = [
  "security",
  "debugging",
  "testing",
  "orchestration",
  "frontend",
  "mobile",
  "accessibility",
  "reliability",
  "observability",
  "integration",
];

function blankSkillDomainCounts(): Record<SkillDomain, number> {
  return {
    security: 0,
    debugging: 0,
    testing: 0,
    orchestration: 0,
    frontend: 0,
    mobile: 0,
    accessibility: 0,
    reliability: 0,
    observability: 0,
    integration: 0,
  };
}

function blankSkillDomainQuality(): Record<SkillDomain, number> {
  return {
    security: 0,
    debugging: 0,
    testing: 0,
    orchestration: 0,
    frontend: 0,
    mobile: 0,
    accessibility: 0,
    reliability: 0,
    observability: 0,
    integration: 0,
  };
}

function parseSkillHeader(raw: string): { name: string; description: string } {
  const text = String(raw ?? "");
  const name =
    text.match(/^\s*name:\s*(.+)\s*$/im)?.[1]?.trim() ??
    text.match(/^\s*#\s+(.+)\s*$/m)?.[1]?.trim() ??
    "";
  const description =
    text.match(/^\s*description:\s*(.+)\s*$/im)?.[1]?.trim() ??
    text.match(/^\s*##\s+.+\n+([^\n#].+)$/m)?.[1]?.trim() ??
    "";
  return {
    name: name.replace(/^["']|["']$/g, ""),
    description: description.replace(/^["']|["']$/g, ""),
  };
}

function inferSkillQuality(raw: string): { score: number; signals: string[] } {
  const text = String(raw ?? "");
  const signals: string[] = [];
  let score = 0;

  const add = (ok: boolean, points: number, label: string) => {
    if (!ok) return;
    score += points;
    signals.push(label);
  };

  add(/\b(when to use|use when|trigger|use this skill)\b/i.test(text), 2, "trigger-rules");
  add(/\b(workflow|steps|process|procedure|checklist)\b/i.test(text), 2, "workflow");
  add(/\b(verify|verification|test|assert|acceptance)\b/i.test(text), 2, "verification");
  add(/\b(example|template|snippet|payload)\b/i.test(text), 1, "examples");
  add(/\b(safety|authorized|permission|must not|do not)\b/i.test(text), 1, "safety-guardrails");
  add(/\b(tool|script|command|automation)\b/i.test(text), 1, "tooling");
  add(/\b(fallback|if blocked|missing|degrade gracefully)\b/i.test(text), 1, "fallback");

  return {
    score: Math.max(0, Math.min(10, score)),
    signals,
  };
}

const MATCH_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "when",
  "what",
  "where",
  "which",
  "will",
  "your",
  "must",
  "have",
  "into",
  "mode",
  "task",
  "worker",
  "workers",
  "agent",
  "agents",
  "command",
  "commands",
  "using",
  "used",
  "only",
  "more",
  "over",
  "than",
  "also",
  "just",
  "does",
  "from",
  "into",
]);

function tokenizeForMatch(text: string): string[] {
  const raw = String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ");
  const uniq = new Set<string>();
  for (const token of raw.split(/\s+/g)) {
    if (!token || token.length < 3) continue;
    if (MATCH_STOPWORDS.has(token)) continue;
    uniq.add(token);
  }
  return Array.from(uniq.values());
}

function inferSkillDomain(record: { path: string; name: string; description: string }): SkillDomain {
  const hay = `${record.path}\n${record.name}\n${record.description}`.toLowerCase();
  if (/(security|threat|sast|vuln|pentest|owasp|auth-implementation|stride|mitigation|incident-response)/.test(hay)) return "security";
  // Accessibility must be checked before generic testing terms, otherwise
  // skills like screen-reader-testing get misclassified as testing.
  if (/(accessibility|wcag|screen-reader|inclusive|a11y)/.test(hay)) return "accessibility";
  if (/(observability|metrics|tracing|grafana|prometheus|telemetry)/.test(hay)) return "observability";
  if (/(orchestrat|task-coordination|team-communication|workflow|dispatch|agent-teams|track-management)/.test(hay)) return "orchestration";
  if (/(reliability|resilience|error-handling|performance|slo|rollback|backoff|timeout)/.test(hay)) return "reliability";
  if (/(mobile|android|ios|react-native|expo|material design|swiftui)/.test(hay)) return "mobile";
  if (/(frontend|web-design|component|ui-design|tailwind|react|vue|nextjs|nuxt)/.test(hay)) return "frontend";
  if (/(debug|root cause|systematic-debugging|parallel-debugging|bug|triage)/.test(hay)) return "debugging";
  if (/(test|tdd|verification|vitest|jest|pytest|playwright|review)/.test(hay)) return "testing";
  return "integration";
}

function discoverSkillRoots(inputRoots?: string[]): { roots: string[]; missing: string[] } {
  const roots = new Set<string>();
  const missing = new Set<string>();
  const envHome = normText(process.env.CODEX_HOME);
  const candidates = [
    ...((Array.isArray(inputRoots) ? inputRoots : []).map((v) => normText(v)).filter(Boolean)),
    envHome ? path.join(envHome, "skills") : "",
    path.join(os.homedir(), ".codex", "skills"),
  ]
    .map((v) => v.trim())
    .filter(Boolean);

  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) roots.add(candidate);
      else missing.add(candidate);
    } catch {
      missing.add(candidate);
    }
  }
  return {
    roots: Array.from(roots.values()),
    missing: Array.from(missing.values()),
  };
}

function scanSkillCorpus(opts?: {
  roots?: string[];
  maxSkills?: number;
}): { roots: string[]; missingRoots: string[]; skills: HarnessSkillRecord[] } {
  const maxSkills = clampInt(Number(opts?.maxSkills ?? 4000), 100, 12000);
  const resolved = discoverSkillRoots(opts?.roots);
  const out: HarnessSkillRecord[] = [];

  for (const root of resolved.roots) {
    const stack: string[] = [root];
    while (stack.length > 0 && out.length < maxSkills) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        if (out.length >= maxSkills) break;
        const name = String(ent.name ?? "");
        if (!name) continue;
        const full = path.join(dir, name);
        if (ent.isDirectory()) {
          if (name === ".git" || name === "node_modules" || name === "__pycache__") continue;
          stack.push(full);
          continue;
        }
        if (!ent.isFile() || name !== "SKILL.md") continue;
        let raw = "";
        try {
          raw = fs.readFileSync(full, "utf8");
        } catch {
          continue;
        }
        const parsed = parseSkillHeader(raw.slice(0, 6000));
        const recBase = {
          path: full,
          name: parsed.name || path.basename(path.dirname(full)),
          description: parsed.description || "",
        };
        const quality = inferSkillQuality(raw.slice(0, 12000));
        out.push({
          ...recBase,
          domain: inferSkillDomain(recBase),
          sourceRoot: root,
          qualityScore: quality.score,
          qualitySignals: quality.signals,
        });
      }
    }
  }

  return { roots: resolved.roots, missingRoots: resolved.missing, skills: out };
}

const COMMAND_DOMAIN_CONTRACT: Record<string, SkillDomain[]> = {
  replan: ["orchestration", "integration"],
  "review-hard": ["orchestration", "testing", "debugging"],
  "sync-status": ["orchestration"],
  handoff: ["orchestration", "integration"],
  "scope-lock": ["orchestration", "integration"],
  "conflict-resolve": ["orchestration", "integration", "testing"],
  "frontend-pass": ["orchestration", "frontend", "accessibility", "testing"],
  "backend-hardening": ["orchestration", "reliability", "testing", "debugging"],
  "security-threat-model": ["orchestration", "security", "integration"],
  "security-vuln-repro": ["orchestration", "security", "debugging", "testing"],
  "security-remediation": ["orchestration", "security", "testing", "reliability"],
  "dependency-risk-audit": ["orchestration", "security", "testing"],
  "data-integrity-audit": ["orchestration", "reliability", "testing", "integration"],
  "contract-audit": ["orchestration", "integration", "testing"],
  "perf-regression-lab": ["orchestration", "reliability", "observability", "testing"],
  "accessibility-hard-check": ["orchestration", "accessibility", "frontend", "testing"],
  "diag-evidence": ["orchestration", "debugging", "testing", "observability"],
  "test-tdd": ["orchestration", "testing", "debugging"],
  "verify-completion": ["orchestration", "testing"],
  "review-request": ["orchestration", "testing", "integration"],
  "security-sast": ["orchestration", "security", "testing"],
  "coord-task": ["orchestration", "integration"],
  "team-launch": ["orchestration", "integration"],
  "threat-model-stride": ["orchestration", "security"],
  "attack-tree-map": ["orchestration", "security"],
  "security-requirements": ["orchestration", "security", "testing"],
  "mitigation-map": ["orchestration", "security", "reliability"],
  "auth-hardening": ["orchestration", "security", "reliability", "testing"],
  "error-path-audit": ["orchestration", "reliability", "debugging", "testing"],
  "resilience-chaos-check": ["orchestration", "reliability", "testing", "observability"],
  "observability-pass": ["orchestration", "observability", "reliability"],
  "incident-drill": ["orchestration", "reliability", "observability"],
  "contract-drift-check": ["orchestration", "integration", "testing"],
  "integration-gate": ["orchestration", "integration", "testing"],
  "rollback-drill": ["orchestration", "reliability", "testing"],
  "release-readiness": ["orchestration", "integration", "testing", "reliability", "security"],
  "flake-hunt": ["orchestration", "testing", "debugging"],
  "perf-budget-gate": ["orchestration", "reliability", "observability", "testing"],
  "frontend-mobile-gate": ["orchestration", "frontend", "mobile", "testing"],
  "motion-reduced-check": ["orchestration", "frontend", "accessibility", "mobile"],
  "design-parity-matrix": ["orchestration", "frontend", "mobile", "accessibility", "integration"],
  "ownership-audit": ["orchestration", "integration"],
  "communication-audit": ["orchestration", "integration"],
};

function normalizeDomains(domains: SkillDomain[]): SkillDomain[] {
  const out = new Set<SkillDomain>();
  out.add("orchestration");
  for (const d of domains) out.add(d);
  return Array.from(out.values());
}

function requiredDomainsForCommand(command: AgentCommandDef): SkillDomain[] {
  const explicit = COMMAND_DOMAIN_CONTRACT[command.id];
  if (explicit && explicit.length > 0) return normalizeDomains(explicit);

  const text = `${command.id} ${command.title} ${command.summary} ${command.whenToUse}`.toLowerCase();
  const domains = new Set<SkillDomain>(["orchestration"]);

  if (/(security|threat|sast|mitigation|vuln|auth|dependency-risk)/.test(text)) domains.add("security");
  if (/(diag|debug|root cause|flake|triage|bug)/.test(text)) domains.add("debugging");
  if (/(test|verify|review|quality gate|contract drift|integration gate)/.test(text)) domains.add("testing");
  if (/(frontend|mobile|design|motion|accessibility|responsive|parity)/.test(text)) domains.add("frontend");
  if (/(mobile|android|ios)/.test(text)) domains.add("mobile");
  if (/(accessibility|wcag|reduced-motion)/.test(text)) domains.add("accessibility");
  if (/(resilience|hardening|rollback|release|incident|perf|reliability|error path|observability)/.test(text)) {
    domains.add("reliability");
  }
  if (/(observability|slo|trace|metrics|telemetry)/.test(text)) domains.add("observability");
  if (/(integration|contract|conflict|ownership|team-launch|scope-lock)/.test(text)) domains.add("integration");

  return Array.from(domains.values());
}

function scoreToConfidence(score: number, covered: boolean): "high" | "medium" | "low" {
  if (!covered && score < 70) return "low";
  if (score >= 82) return "high";
  if (score >= 58) return "medium";
  return "low";
}

function scoreSkillForCommand(
  skill: HarnessSkillRecord & { tokens: string[] },
  commandTokens: Set<string>,
  requiredDomains: Set<SkillDomain>,
): number {
  let overlap = 0;
  for (const token of skill.tokens) {
    if (commandTokens.has(token)) overlap += 1;
  }
  if (overlap === 0 && !requiredDomains.has(skill.domain)) return 0;

  const domainBoost = requiredDomains.has(skill.domain) ? 4 : 0;
  const qualityBoost = Math.max(0, Math.min(10, skill.qualityScore)) * 0.8;
  const overlapScore = Math.min(12, overlap * 1.4);
  return overlapScore + domainBoost + qualityBoost;
}

export function buildHarnessSotaAudit(opts?: {
  skillRoots?: string[];
  sampleSize?: number;
  maxSkills?: number;
  commandCatalog?: AgentCommandDef[];
}): HarnessSotaAudit {
  const generatedAt = new Date().toISOString();
  const sampleSize = clampInt(Number(opts?.sampleSize ?? 40), 10, 300);
  const catalog = Array.isArray(opts?.commandCatalog) && opts?.commandCatalog.length > 0
    ? opts!.commandCatalog!
    : defaultCommandCatalog();
  const corpus = scanSkillCorpus({ roots: opts?.skillRoots, maxSkills: opts?.maxSkills });
  const counts = blankSkillDomainCounts();
  const qualityTotals = blankSkillDomainQuality();
  let totalQuality = 0;
  for (const skill of corpus.skills) {
    counts[skill.domain] += 1;
    qualityTotals[skill.domain] += skill.qualityScore;
    totalQuality += skill.qualityScore;
  }

  const domainQuality = blankSkillDomainQuality();
  for (const d of SKILL_DOMAIN_LIST) {
    const c = counts[d];
    domainQuality[d] = c > 0 ? Number((qualityTotals[d] / c).toFixed(2)) : 0;
  }
  const averageSkillQuality = corpus.skills.length > 0
    ? Number((totalQuality / corpus.skills.length).toFixed(2))
    : 0;

  const indexedSkills = corpus.skills.map((skill) => ({
    ...skill,
    tokens: tokenizeForMatch(`${skill.name}\n${skill.description}\n${skill.path}`),
  }));

  const domainSet = new Set<SkillDomain>(corpus.skills.map((s) => s.domain));
  const commandCoverage: HarnessCommandCoverage[] = catalog.map((cmd) => {
    const requiredDomains = requiredDomainsForCommand(cmd);
    const coveredDomains = requiredDomains.filter((d) => domainSet.has(d));
    const missingDomains = requiredDomains.filter((d) => !domainSet.has(d));
    const requiredDomainSet = new Set<SkillDomain>(requiredDomains);
    const commandTokens = new Set<string>(
      tokenizeForMatch([
        cmd.id,
        cmd.title,
        cmd.summary,
        cmd.whenToUse,
        requiredDomains.join(" "),
      ].join(" ")),
    );

    const ranked = indexedSkills
      .map((skill) => ({ skill, score: scoreSkillForCommand(skill, commandTokens, requiredDomainSet) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));
    const supportingSkills = ranked.slice(0, 6).map((x) => x.skill.name);
    const coveredRatio = coveredDomains.length / Math.max(requiredDomains.length, 1);
    const lexicalRatio = ranked.length > 0 ? Math.min(1, ranked[0].score / 20) : 0;
    const qualityRatio = ranked.length > 0
      ? Math.min(
          1,
          ranked.slice(0, 6).reduce((acc, x) => acc + x.skill.qualityScore, 0) /
            (Math.min(6, ranked.length) * 10),
        )
      : 0;
    const supportScore = Math.round((coveredRatio * 0.55 + lexicalRatio * 0.2 + qualityRatio * 0.25) * 100);
    const covered = missingDomains.length === 0;
    return {
      commandId: cmd.id,
      requiredDomains,
      coveredDomains,
      missingDomains,
      supportingSkills,
      supportScore,
      confidence: scoreToConfidence(supportScore, covered),
      covered,
    };
  });

  const uncoveredCommands = commandCoverage.filter((c) => !c.covered).map((c) => c.commandId);
  const lowConfidenceCommands = commandCoverage.filter((c) => c.confidence === "low").map((c) => c.commandId);
  const recommendations: string[] = [];

  if (corpus.skills.length === 0) {
    recommendations.push(
      "No local skills discovered. Install/populate CODEX skills corpus and re-run audit.",
    );
  }
  for (const d of SKILL_DOMAIN_LIST) {
    if (counts[d] === 0) {
      recommendations.push(`Domain gap: '${d}' has zero discovered skills. Add at least one practical skill for this domain.`);
    }
  }
  if (uncoveredCommands.length > 0) {
    recommendations.push(
      `Command gaps: ${uncoveredCommands.slice(0, 12).join(", ")}${uncoveredCommands.length > 12 ? " ..." : ""}.`,
    );
    recommendations.push(
      "Prioritize closing gaps for commands used in startup/review loops: coord-task, diag-evidence, verify-completion, sync-status, review-hard.",
    );
  } else {
    recommendations.push("All commands have at least one discovered skill backing each required domain contract.");
  }
  if (lowConfidenceCommands.length > 0) {
    recommendations.push(
      `Low-confidence command backing detected: ${lowConfidenceCommands.slice(0, 10).join(", ")}${lowConfidenceCommands.length > 10 ? " ..." : ""}.`,
    );
  }
  if (averageSkillQuality < 4.5) {
    recommendations.push(
      "Average skill quality is low. Strengthen SKILL.md files with trigger rules, workflow, verification, and safety guardrails.",
    );
  }
  if (corpus.missingRoots.length > 0) {
    recommendations.push(`Missing skill roots detected: ${corpus.missingRoots.join(", ")}.`);
  }

  return {
    generatedAt,
    skillRoots: corpus.roots,
    missingRoots: corpus.missingRoots,
    skillCount: corpus.skills.length,
    skillsByDomain: counts,
    domainQuality,
    averageSkillQuality,
    sampledSkills: corpus.skills
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, sampleSize),
    commandCoverage,
    uncoveredCommands,
    recommendations,
  };
}

// ── Role Inference ────────────────────────────────────────────────────────────

export function normalizeWorkerRole(value: unknown): WorkerRoleKey | null {
  const t = cleanRoleToken(value);
  if (!t) return null;
  if (t.includes("front") || t.includes("ui") || t.includes("ux") || t.includes("design")) return "frontend";
  if (t.includes("debug") || t.includes("verify") || t.includes("qa") || t.includes("test") || t.includes("bug")) return "debug";
  if (t.includes("integrat") || t.includes("contract") || t.includes("merge")) return "integration";
  if (t.includes("perf") || t.includes("resilien") || t.includes("stability") || t.includes("hardening")) return "perf";
  if (t.includes("back") || t.includes("api") || t.includes("server") || t.includes("core")) return "backend";
  if (t === "worker") return "backend";
  return null;
}

export function inferWorkerRole(input: {
  role?: string;
  name?: string;
  taskPrompt?: string;
  profileId?: string;
}): WorkerRoleKey {
  const direct = normalizeWorkerRole(input.role);
  if (direct) return direct;

  const joined = `${input.name ?? ""}\n${input.taskPrompt ?? ""}\n${input.profileId ?? ""}`.toLowerCase();

  if (/\b(frontend|ui|ux|css|layout|responsive|component|visual)\b/.test(joined)) return "frontend";
  if (/\b(debug|bug|verify|verification|test|regression|repro|root cause|root-cause|flaky)\b/.test(joined)) return "debug";
  if (/\b(integration|contract|shared type|schema|merge|compose|compat)\b/.test(joined)) return "integration";
  if (/\b(perf|performance|latency|throughput|race|cleanup|resilience|hardening|leak)\b/.test(joined)) return "perf";

  if (String(input.profileId ?? "").includes("full_auto")) return "debug";
  if (String(input.profileId ?? "").includes("accept_edits")) return "frontend";
  return "backend";
}

// ── Generic Knowledge (injected into all agents) ─────────────────────────────

export function buildGenericKnowledgePrompt(): string {
  return [
    "UNIVERSAL AGENT PRINCIPLES — READ EVERY SESSION",
    ...UNIVERSAL_PRINCIPLES,
    "",
    buildExpertPlaybookIndexPrompt(),
  ].join("\n");
}

// ── 4K-Line Master Prompt Library ─────────────────────────────────────────────

function buildDebugFailureModes(): string[] {
  return [
    "Race condition in async state updates",
    "Non-deterministic ordering bug under concurrent writes",
    "Resource leak caused by missing cleanup",
    "Silent error swallowing in promise chain",
    "Retry storm due to missing backoff",
    "Incorrect timeout propagation",
    "Idempotency failure on duplicate requests",
    "Schema mismatch between worker outputs",
    "Incorrect assumption about nullable values",
    "Boundary condition failure at empty input",
    "Boundary condition failure at max-size input",
    "Stale cache returning invalid data",
    "Cache invalidation not triggered on update",
    "Cross-request shared mutable state",
    "Missing transaction guard around multi-step update",
    "Unhandled rejection in background task",
    "Incorrect branch/path assumption in file operations",
    "Validation gap allowing malformed payload",
    "Permission check bypass in conditional branch",
    "Feature flag branch drift",
    "Incorrect default configuration fallback",
    "Overly broad exception catch masking root cause",
    "Data coercion bug from implicit typing",
    "API contract drift between frontend and backend",
    "Flaky test caused by clock/time dependency",
    "Flaky test caused by non-isolated filesystem state",
    "Deadlock risk in lock acquisition order",
    "Inconsistent retry + timeout envelope",
    "Crash on missing environment variable",
    "Memory pressure from unbounded in-memory queue",
    "Message loss during partial failure recovery",
    "State corruption on interrupted write",
    "Regression in backward-compatible behavior",
    "Duplicate implementation diverging from canonical logic",
    "Incorrect rollback behavior on partial commit",
    "Approval pipeline accepts unsafe action without evidence",
    "Worker scope drift caused by ambiguous task wording",
    "Task handoff loses critical context between agents",
    "Question timeout leaves worker blocked indefinitely",
    "Dead-letter queue accumulates unprocessed worker requests",
    "Orchestrator review cadence causes interrupt storms",
    "Worker progress document diverges from actual implementation",
    "Branch/worktree mismatch causes edits in wrong target",
    "Retry policy retries non-idempotent operation",
    "Cancellation signal ignored by long-running subprocess",
    "Lock not released after exceptional path",
    "Incorrect optimistic update rollback on failure",
    "State machine enters impossible transition",
    "Parser accepts malformed control payload",
    "Control bus dispatch targets wrong worker",
    "Orchestrator auto-answer selects unsafe option",
    "Shared file ownership map is stale",
    "Scope-lock policy not enforced after violation",
    "Approval response arrives after request already invalidated",
    "Interleaved tool outputs are attributed to wrong call",
    "Transcript truncation hides root-cause evidence",
    "Event dedupe collapses distinct error events",
    "Batched updates reorder critical status transitions",
    "Failure metric missing labels causes blind spot",
    "Feature toggle fallback bypasses safety checks",
    "Input sanitization strips required command token",
    "Path normalization fails on symlink/worktree boundary",
    "Cleanup hook runs before pending writes flush",
    "Race between stop signal and final result write",
    "Orchestrator summary reports completion without verification",
    "Worker exits cleanly but leaves partial artifacts",
    "Progress parser misreads checklist state",
  ];
}

function buildDebugSurfaces(): string[] {
  return [
    "unit tests",
    "integration tests",
    "E2E reproduction",
    "runtime logs",
    "structured error traces",
    "git diff inspection",
    "task markdown progress artifacts",
    "API contract checks",
    "type-check diagnostics",
    "build output",
    "load/stress checks",
    "manual deterministic repro steps",
    "orchestrator dispatch logs",
    "inbox/approval request timeline",
    "worker progress markdown files",
    "git worktree/branch status",
    "resource usage telemetry",
    "control bus API response payloads",
    "event stream ordering analysis",
    "permission/sandbox decision logs",
  ];
}

function buildDebugEvidenceCommands(): string[] {
  return [
    "npm test -- --runInBand",
    "npm run build && npm test",
    "npm run typecheck",
    "npm run test -- --reporter=verbose",
    "npm run test -- --grep 'auth|permission|policy'",
    "npm run test -- --grep 'orchestration|dispatch|worker'",
    "npm run test -- --grep 'regression|stability'",
    "npm run lint && npm run test",
    "npm run test -- --grep 'integration'",
    "npm run test -- --grep 'race|timeout|retry'",
    "npm run test -- --grep 'api|contract|schema'",
    "npm run build:web && npm run build",
    "pnpm test -- --runInBand",
    "pnpm -r build && pnpm -r test",
    "yarn test --runInBand",
    "yarn build && yarn test",
    "pytest -q",
    "pytest -q -k 'orchestration or approval or worker'",
    "go test ./...",
    "cargo test --workspace",
    "git diff --name-only",
    "git status --short --branch",
    "rg -n 'TODO|FIXME|HACK' server web",
    "npm run lint && npm run typecheck && npm test",
  ];
}

function buildDebugHypothesisBank(): string[] {
  return [
    "Invariant violation in state transition graph",
    "Mutable shared state accessed without synchronization boundary",
    "Timeout/retry envelope is internally inconsistent",
    "Assumed monotonic ordering is violated by async delivery",
    "Input normalization changes semantic meaning",
    "Rollback path fails to restore precondition",
    "Ownership boundary not enforced before write",
    "Error path misses cleanup/finalize hook",
    "Contract compatibility assumption is outdated",
    "Non-idempotent side effect is retried",
    "Parsing fallback path accepts invalid payload",
    "Cross-worker integration expectation is undocumented",
    "Cache key omits differentiating context",
    "Clock/time dependence causes non-determinism",
    "Event dedupe collapses meaningful state changes",
    "Batching policy violates sequencing assumptions",
  ];
}

function buildDebugDisproofSignals(): string[] {
  return [
    "State snapshots before/after edit show invariant preserved",
    "Reproduction no longer fails while neighboring regressions stay green",
    "Trace correlation IDs show correct ordering under stress",
    "Guard rails reject malformed inputs as expected",
    "Rollback reproduces original pre-change state exactly",
    "Scope-lock catches out-of-bound edits in verification run",
    "Race reproducer remains stable across repeated iterations",
    "No duplicate/contradictory implementations remain in diff",
    "Integration contract tests pass with both old/new callers",
    "Resource footprint returns to baseline after completion",
    "No orphan approval requests remain open after workflow end",
    "Dispatch target and resulting worker transcript match expected owner",
  ];
}

function buildDebugInstrumentationBank(): string[] {
  return [
    "Enable structured logs with correlation id across request lifecycle",
    "Capture pre/post mutation snapshots around failing code path",
    "Record worker ownership map for touched files before patching",
    "Attach timestamped sequence markers to async boundaries",
    "Capture approval gate decisions with explicit gate outcomes",
    "Log retry/backoff schedule with attempt counters",
    "Record lock acquisition order and hold duration",
    "Collect control bus request/response payload pairs",
    "Trace event stream ordering with monotonic sequence ids",
    "Capture cleanup hooks and resource release confirmations",
    "Persist minimal repro script for deterministic reruns",
    "Emit progress-doc checksum before/after worker update",
  ];
}

function buildDebugRollbackTriggers(): string[] {
  return [
    "Any new failing test outside declared bug scope",
    "Evidence command output becomes non-deterministic across reruns",
    "Patch touches files outside assigned ownership map",
    "Approval gate conflict risk cannot be resolved quickly",
    "Observed behavior diverges from documented contract after patch",
    "Critical path latency/regression exceeds pre-change baseline",
    "Rollback validation cannot reproduce pre-change behavior",
    "Worker coordination introduces duplicate implementations",
    "Security/permission checks weaken after change",
    "Instrumentation shows hidden side effect in unrelated module",
  ];
}

function buildDebugRollbackActions(): string[] {
  return [
    "Revert patch and re-run minimal repro to re-establish baseline",
    "Restore prior known-good implementation and isolate suspect delta",
    "Scope-lock worker and re-dispatch with narrowed file ownership",
    "Escalate to integration owner before any further patching",
    "Freeze new feature paths and keep containment-only mitigation active",
    "Document incident with exact failing evidence before retrying",
    "Rebuild from clean state and replay deterministic repro steps",
    "Disable risky optimization branch pending measured validation",
    "Apply targeted hotfix fallback and defer broad refactor",
    "Route unresolved conflict through orchestrator hard review",
  ];
}

function buildDebugEscalationCriteria(): string[] {
  return [
    "More than one plausible root cause remains after two disproof attempts",
    "Fix requires shared contract/schema changes across worker boundaries",
    "Repro requires external dependency not available in current sandbox",
    "Evidence output conflicts between two verification surfaces",
    "Potential data-loss/security impact exceeds low-risk threshold",
    "Worker cannot satisfy ownership boundary and objective simultaneously",
    "Approval decision uncertainty remains after gate-by-gate analysis",
    "Repeated retries fail with identical symptoms and no new signal",
  ];
}

function buildApprovalRiskBands(): Array<{
  name: string;
  conflictRule: string;
  evidenceRule: string;
  defaultAction: string;
}> {
  return [
    {
      name: "LOW",
      conflictRule: "No shared file ownership conflict and no schema/API boundary touched.",
      evidenceRule: "Require one targeted verification command with clear pass result.",
      defaultAction: "Approve if gates 1-3 pass and evidence is specific.",
    },
    {
      name: "MEDIUM",
      conflictRule: "Touches shared files or ownership boundary is adjacent but coordinated.",
      evidenceRule: "Require targeted plus one broad regression command.",
      defaultAction: "Conditionally approve with explicit guardrails and follow-up check.",
    },
    {
      name: "HIGH",
      conflictRule: "Touches critical/shared contracts, migrations, auth, or dispatch policy.",
      evidenceRule: "Require full evidence packet and integration-owner confirmation.",
      defaultAction: "Pause/redirect unless hard-review confirms safety.",
    },
  ];
}

function buildQualityGateLibrary(): string[] {
  return [
    "confirm scope ownership before editing",
    "require deterministic repro before patch",
    "tie every patch to a named invariant",
    "log disproof signal for rejected hypotheses",
    "collect targeted and broad verification evidence",
    "record rollback trigger and rollback action",
    "verify no duplicate implementation remains",
    "update progress docs with concise factual state",
    "prefer no-dispatch when worker is on-track",
    "reject ambiguous approval requests and ask for specifics",
    "enforce ownership map on every conflicting file",
    "gate risky actions behind integration-owner review",
    "preserve token budget by batching non-blocking updates",
    "avoid speculative refactor during debug stabilization",
    "capture command output snippets, not assertions",
    "escalate when uncertainty persists after two cycles",
  ];
}

function padPromptLines(lines: string[], minLines: number): string[] {
  const focus = buildQualityGateLibrary();

  let idx = 1;
  while (lines.length < minLines) {
    const action = focus[(idx - 1) % focus.length] ?? focus[0]!;
    lines.push(`QUALITY-GATE-${String(idx).padStart(4, "0")}: ${action}; completion blocked without evidence.`);
    idx += 1;
  }
  return lines;
}

export function buildMasterSystemPromptLibrary(opts?: { minLines?: number }): string {
  const minLines = clampInt(Number(opts?.minLines ?? 4096), 4096, 12000);
  const lines: string[] = [];

  lines.push("MASTER ORCHESTRATION PROMPT LIBRARY");
  lines.push("Version: 2026-02-20");
  lines.push("Purpose: canonical behavior contract for creator, orchestrator, and worker profiles.");
  lines.push("This library is designed to be line-rich, deterministic, and operationally measurable.");
  lines.push("");
  lines.push("SECTION A — UNIVERSAL PRINCIPLES");
  lines.push(...UNIVERSAL_PRINCIPLES);
  lines.push("");

  lines.push("SECTION B — PROFILE PLAYBOOK");
  for (const p of PROFILE_PLAYBOOK) {
    lines.push(`PROFILE ${p.profileId}`);
    lines.push(`BEST_FOR: ${p.bestFor}`);
    lines.push(`AVOID_FOR: ${p.avoidFor}`);
    lines.push(`BEHAVIOR_CONTRACT: ${p.behavior}`);
    lines.push(`EVIDENCE_EXPECTATION: ${p.evidence}`);
    lines.push("");
  }

  lines.push("SECTION B2 — EXPERT PLAYBOOKS");
  lines.push("Use these repository playbooks as deep operational references.");
  lines.push("Security debug playbooks are for authorized scope only in isolated lab/sandbox conditions.");
  for (const p of EXPERT_PLAYBOOKS) {
    lines.push(`PLAYBOOK ${p.id}`);
    lines.push(`MODE: ${p.mode}`);
    lines.push(`TITLE: ${p.title}`);
    lines.push(`PATH: ${p.path}`);
    lines.push(`FOCUS: ${p.focus}`);
    lines.push("");
  }

  lines.push("SECTION C — ORCHESTRATOR CORE CONTRACT");
  lines.push("- Orchestrator is never a feature coder.");
  lines.push("- Orchestrator assigns, monitors, approves, rejects, and integrates.");
  lines.push("- Orchestrator must enforce worker ownership and no-op discipline.");
  lines.push("- Orchestrator must keep a file ownership map and conflict map.");
  lines.push("- Orchestrator dispatch format is mandatory: TASK/SCOPE/NOT-YOUR-JOB/DONE-WHEN/VERIFY/PRIORITY.");
  lines.push("- Orchestrator approves only when objective alignment, scope compliance, conflict risk, and evidence are satisfied.");
  lines.push("- Orchestrator startup sequence: read objective -> read worker registry -> assign ownership -> dispatch within first 2 exchanges.");
  lines.push("- Orchestrator must maintain shared state docs (.agents/README.md, .agents/system/orchestrator.md, .agents/tasks/*.md).");
  lines.push("- Orchestrator reads worker task docs before any steering or approval response.");
  lines.push("- Orchestrator reads worker progress docs before any follow-up dispatch.");
  lines.push("- Orchestrator may choose NO-DISPATCH when no intervention is required.");
  lines.push("- Orchestrator records rationale for approve/reject/no-op decisions.");
  lines.push("- Orchestrator handles worker question packets with blocker-first answers and measurable criteria.");
  lines.push("- Orchestrator must prefer concise, high-signal updates that do not starve worker throughput.");
  lines.push("");

  lines.push("SECTION D — WORKER ROLE CONTRACTS");
  lines.push("BACKEND: Own backend logic, strict typing, explicit error handling, no unrelated refactors.");
  lines.push("FRONTEND: Own UI behavior and accessibility, mobile-first validation, no backend edits.");
  lines.push("DEBUG: Own reproduction + root cause + focused fix + regression tests + evidence.");
  lines.push("INTEGRATION: Own shared contracts and conflict resolution between workers.");
  lines.push("PERF: Own resilience, cleanup, concurrency safety, and measured optimization.");
  lines.push("");

  lines.push("SECTION E — DEBUG ROOT CAUSE TRIAGE GRID");
  const failures = buildDebugFailureModes();
  const surfaces = buildDebugSurfaces();
  const evidence = buildDebugEvidenceCommands();
  const hypotheses = buildDebugHypothesisBank();
  const disproofSignals = buildDebugDisproofSignals();
  const instrumentation = buildDebugInstrumentationBank();
  const rollbackTriggers = buildDebugRollbackTriggers();
  const rollbackActions = buildDebugRollbackActions();
  const escalationCriteria = buildDebugEscalationCriteria();

  let sid = 1;
  outer: for (const failure of failures) {
    for (const surface of surfaces) {
      const e1 = evidence[(sid - 1) % evidence.length] ?? evidence[0]!;
      const e2 = evidence[(sid + 2) % evidence.length] ?? evidence[0]!;
      const hypothesis = hypotheses[(sid - 1) % hypotheses.length] ?? hypotheses[0]!;
      const disproof = disproofSignals[(sid - 1) % disproofSignals.length] ?? disproofSignals[0]!;
      const instrument = instrumentation[(sid - 1) % instrumentation.length] ?? instrumentation[0]!;
      const rollbackTrigger = rollbackTriggers[(sid - 1) % rollbackTriggers.length] ?? rollbackTriggers[0]!;
      const rollbackAction = rollbackActions[(sid - 1) % rollbackActions.length] ?? rollbackActions[0]!;
      const escalateWhen = escalationCriteria[(sid - 1) % escalationCriteria.length] ?? escalationCriteria[0]!;
      lines.push(`DEBUG-SCENARIO-${String(sid).padStart(4, "0")}`);
      lines.push(`FAILURE_MODE: ${failure}`);
      lines.push(`DETECTION_SURFACE: ${surface}`);
      lines.push(`HYPOTHESIS_TO_TEST: ${hypothesis}`);
      lines.push(`DISPROOF_SIGNAL: ${disproof}`);
      lines.push(`INSTRUMENTATION: ${instrument}`);
      lines.push("CONTAINMENT_STEP: reduce blast radius first (scope-lock, disable risky path, preserve reproducibility).");
      lines.push("ROOT_CAUSE_RULE: identify exact failing invariant before editing.");
      lines.push("PATCH_RULE: minimal-change patch tied directly to root cause.");
      lines.push(`TEST_BEFORE: ${e1}`);
      lines.push(`TEST_AFTER: ${e2}`);
      lines.push(`ROLLBACK_TRIGGER: ${rollbackTrigger}`);
      lines.push(`ROLLBACK_ACTION: ${rollbackAction}`);
      lines.push(`ESCALATE_WHEN: ${escalateWhen}`);
      lines.push("DECISION_GATE: do not mark complete without repro-before and repro-after evidence.");
      lines.push("REPORT_FORMAT: BUG | ROOT | FIX | TEST | RESULT.");
      lines.push("");
      sid += 1;
      if (sid > 340) break outer;
    }
  }

  lines.push("SECTION F — ORCHESTRATOR APPROVAL PLAYBOOK");
  const riskBands = buildApprovalRiskBands();
  for (let i = 1; i <= 260; i++) {
    const cmd = evidence[i % evidence.length] ?? evidence[0]!;
    const band = riskBands[(i - 1) % riskBands.length] ?? riskBands[0]!;
    lines.push(`APPROVAL-ENTRY-${String(i).padStart(4, "0")} [${band.name}]`);
    lines.push("GATE_1_OBJECTIVE: verify direct objective alignment and urgency.");
    lines.push("GATE_2_SCOPE: verify ownership map and scope-lock compliance.");
    lines.push(`GATE_3_CONFLICT: ${band.conflictRule}`);
    lines.push(`GATE_4_EVIDENCE: require output from '${cmd}'. ${band.evidenceRule}`);
    lines.push(`DEFAULT_ACTION: ${band.defaultAction}`);
    lines.push("REJECT_TEMPLATE: reason + required evidence + next exact step.");
    lines.push("NO_DISPATCH_RULE: if worker trajectory is healthy and evidenced, avoid interruption.");
  }

  lines.push("SECTION G — TOKEN AND PERFORMANCE HYGIENE");
  lines.push("- Prefer concise state packets over repetitive chatter.");
  lines.push("- Use periodic checkpoints; avoid interrupt loops that starve coding throughput.");
  lines.push("- Route only blocking decisions through question packets.");
  lines.push("- Keep progress docs updated so orchestration can review without extra messages.");
  lines.push("- Use evidence snippets, not full logs, unless explicitly requested.");
  lines.push("- For auto-answer mode: respond to explicit worker question packets only.");
  lines.push("- For steering mode: batch suggestions into infrequent, high-value interventions.");
  lines.push("- Preserve single source of truth in `.agents/tasks/*.md` and refresh UI from those docs.");
  lines.push("- Never force worker restarts just to request progress updates.");
  lines.push("");

  lines.push("SECTION H — WORKER COMMUNICATION CONTRACT");
  lines.push("- Worker status packet format: BLOCKERS | PROGRESS | NEXT.");
  lines.push("- Worker question packet format: CONTEXT | QUESTION | OPTIONS | RECOMMENDED.");
  lines.push("- Worker completion packet format: FILES | VERIFICATION | RISKS | READY_FOR_REVIEW.");
  lines.push("- Orchestrator reply format: DECISION | RATIONALE | CONSTRAINTS | NEXT.");
  lines.push("- If no decision needed, orchestrator returns NO-DISPATCH.");
  lines.push("- Scope drift requires explicit SCOPE-LOCK response.");
  lines.push("- Conflict requires explicit CONFLICT-RESOLVE response naming authoritative owner.");
  lines.push("");

  lines.push("SECTION I — DEBUG EXECUTION CADENCE");
  for (let i = 1; i <= 180; i++) {
    const cmd = evidence[(i - 1) % evidence.length] ?? evidence[0]!;
    const hypothesis = hypotheses[(i - 1) % hypotheses.length] ?? hypotheses[0]!;
    const disproof = disproofSignals[(i - 1) % disproofSignals.length] ?? disproofSignals[0]!;
    lines.push(`DEBUG-CYCLE-${String(i).padStart(4, "0")}`);
    lines.push(`1) establish repro with: ${cmd}`);
    lines.push(`2) test hypothesis: ${hypothesis}`);
    lines.push(`3) seek disproof signal: ${disproof}`);
    lines.push("4) patch minimally and rerun targeted + broad verification");
    lines.push("5) publish BUG|ROOT|FIX|TEST|RESULT and update progress doc");
  }

  padPromptLines(lines, minLines);
  return lines.join("\n");
}

// ── Worker System Prompts ─────────────────────────────────────────────────────

function buildWorkerCoreBlock(role: WorkerRoleKey): string {
  if (role === "frontend") {
    return [
      "ROLE: FRONTEND IMPLEMENTATION WORKER",
      "You own UI implementation in assigned scope only.",
      "- Never modify backend/server files unless explicitly assigned.",
      "- Enforce accessibility semantics and keyboard behavior.",
      "- Validate responsive behavior on narrow and medium viewports.",
      "- Keep styles intentional; remove dead CSS and contradictory overrides.",
      "- Emit evidence for visual/interaction checks in completion summary.",
    ].join("\n");
  }

  if (role === "debug") {
    return [
      "ROLE: DEBUGGER / VERIFIER WORKER",
      "You are the quality gate. Your artifact is evidence, not narrative.",
      "- Reproduce first; no fix without reliable repro.",
      "- Identify root cause line(s), not symptoms.",
      "- Apply minimal patch bound to the root cause.",
      "- Add regression test(s) that fail before and pass after.",
      "- Run targeted then broad verification.",
      "- Report BUG|ROOT|FIX|TEST|RESULT for each bug.",
      "- If outside scope, log with file:line and escalate to orchestrator.",
    ].join("\n");
  }

  if (role === "integration") {
    return [
      "ROLE: INTEGRATION WORKER",
      "You own shared contracts and cross-worker composition safety.",
      "- Shared types/schema/routes/config are your ownership boundary.",
      "- Detect and resolve conflicting implementations.",
      "- Publish migration notes whenever shared contracts change.",
      "- Block merges lacking compatibility verification.",
    ].join("\n");
  }

  if (role === "perf") {
    return [
      "ROLE: PERFORMANCE + RESILIENCE WORKER",
      "You own reliability hardening and measured performance changes.",
      "- Measure before and after; no blind optimizations.",
      "- Prioritize correctness under failure over speed tweaks.",
      "- Fix leaks, cleanup gaps, timeout/retry flaws, and race risks.",
      "- Document baseline, change, and measured outcome.",
    ].join("\n");
  }

  return [
    "ROLE: BACKEND IMPLEMENTATION WORKER",
    "You own backend logic changes within assigned scope.",
    "- Use typed interfaces and explicit error handling.",
    "- Prefer targeted edits over broad rewrites.",
    "- Search for existing logic before introducing new abstractions.",
    "- Always verify with relevant tests/build commands.",
  ].join("\n");
}

function buildRoleEvidenceBlock(role: WorkerRoleKey): string {
  const common = [
    "EVIDENCE RULES",
    "- Completion requires command + output snippet, not assertions.",
    "- Include files changed and residual risk notes.",
  ];

  if (role === "debug") {
    const failureModes = buildDebugFailureModes();
    const surfaces = buildDebugSurfaces();
    const commands = buildDebugEvidenceCommands();
    const hypotheses = buildDebugHypothesisBank();
    const disproofSignals = buildDebugDisproofSignals();
    const rollbackTriggers = buildDebugRollbackTriggers();
    const rollbackActions = buildDebugRollbackActions();
    const lines: string[] = [
      ...common,
      "",
      "DEBUG EXECUTION CONTRACT",
      "- Stage 1: reproduce and log stable failing command.",
      "- Stage 2: declare candidate invariant and hypothesis.",
      "- Stage 3: disprove alternatives before patching.",
      "- Stage 4: patch minimally and bind to root cause.",
      "- Stage 5: verify targeted and broad suites.",
      "- Stage 6: publish BUG|ROOT|FIX|TEST|RESULT with file list.",
      "",
      "DEBUG ROOT CAUSE TRIAGE GRID",
      "Use these deterministic triage entries when validating fixes.",
      "For the full extended catalog, read `.agents/system/master-prompt-library.md`.",
    ];

    let idx = 1;
    const maxRuntimeTriageEntries = 18;
    outer: for (const f of failureModes) {
      for (const s of surfaces) {
        lines.push(`TRIAGE-${String(idx).padStart(4, "0")}: ${f} via ${s}`);
        lines.push(`- Hypothesis: ${hypotheses[(idx - 1) % hypotheses.length]}`);
        lines.push(`- Repro command: ${commands[(idx - 1) % commands.length]}`);
        lines.push(`- Verification command: ${commands[(idx + 3) % commands.length]}`);
        lines.push(`- Disproof signal: ${disproofSignals[(idx - 1) % disproofSignals.length]}`);
        lines.push(`- Rollback trigger: ${rollbackTriggers[(idx - 1) % rollbackTriggers.length]}`);
        lines.push(`- Rollback action: ${rollbackActions[(idx - 1) % rollbackActions.length]}`);
        lines.push("- Acceptance: repro fails before fix and passes after fix; regression suite unchanged or improved.");
        idx += 1;
        if (idx > maxRuntimeTriageEntries) break outer;
      }
    }

    return lines.join("\n");
  }

  return common.join("\n");
}

function buildRoleProfileHints(role: WorkerRoleKey): string {
  const hints = PROFILE_PLAYBOOK
    .filter((p) => {
      if (role === "debug") return p.profileId.includes("full_auto") || p.profileId.includes("codex.default");
      if (role === "frontend") return p.profileId.includes("accept_edits") || p.profileId.includes("codex.default");
      if (role === "integration") return p.profileId.includes("claude.default") || p.profileId.includes("codex.default");
      if (role === "perf") return p.profileId.includes("codex");
      return p.profileId.includes("codex.default") || p.profileId.includes("claude.default");
    })
    .map((p) => `- ${p.profileId}: ${p.behavior}`);

  return [
    "PROFILE HINTS",
    ...hints,
  ].join("\n");
}

// Keep export alias for app.ts compatibility
export function buildImproverSystemPrompt(): string {
  return [
    "ROLE: SKILLS / AGENT COMMAND IMPROVER",
    "You maintain reusable command/system prompt assets.",
    "- Define purpose, trigger, inputs, output contract, and verification for each command.",
    "- Reject ambiguous language without measurable acceptance criteria.",
    "- Include rollback/failure handling for risky operations.",
    "",
    buildGenericKnowledgePrompt(),
  ].join("\n");
}

export function buildWorkerSystemPrompt(role: WorkerRoleKey): string {
  return [
    buildWorkerCoreBlock(role),
    "",
    buildRoleProfileHints(role),
    "",
    buildRoleEvidenceBlock(role),
    "",
    buildGenericKnowledgePrompt(),
  ].join("\n");
}

// ── Creator System Prompt ─────────────────────────────────────────────────────

export function buildCreatorSystemPrompt(): string {
  const catalog = renderCommandCatalogForPrompt(defaultCommandCatalog(), {
    maxItems: 28,
    includeWhenToUse: true,
  });

  return [
    "ROLE: TASK CREATOR — ORCHESTRATION ARCHITECT",
    "You transform a user objective into a precise, measurable multi-worker plan.",
    "Ambiguity is treated as failure.",
    "",
    "INPUTS",
    "- Objective text",
    "- Workspace scan summary",
    "- Budget + priority preferences",
    "",
    "MANDATORY OUTPUT",
    "1. Complexity score (1-8) + rationale",
    "2. Orchestrator tool/profile + system prompt",
    "3. Worker list with role/tool/profile/taskPrompt/systemPrompt/rationale",
    "4. Ownership map (non-overlapping unless integration owner assigned)",
    "5. Verification commands per worker",
    "",
    "TASK PROMPT FORMAT",
    "TASK: [single scoped sentence]",
    "SCOPE: [exact files/dirs/modules]",
    "NOT-YOUR-JOB: [forbidden areas]",
    "DONE-WHEN: [testable completion criteria]",
    "VERIFY: [command proving completion]",
    "",
    "PROFILE PLAYBOOK",
    buildProfilePlaybookPrompt(),
    "",
    "WORKER COUNT HEURISTIC",
    "- 1 worker: focused scope or low complexity",
    "- 2 workers: clean split (implementation + verification)",
    "- 3 workers: include integration owner when shared interfaces exist",
    "- 4 workers: large codebase with independent tracks and final debug pass",
    "",
    "ANTI-SLOP CONTRACT",
    "- Prefer targeted edits over rewrites.",
    "- No dead code/placeholders/speculative abstractions.",
    "- Include evidence-bearing verification commands.",
    "",
    "AVAILABLE COMMAND CATALOG",
    catalog,
    "",
    "MASTER LIBRARY NOTE",
    "- The canonical long-form reference is generated via buildMasterSystemPromptLibrary(minLines=4096).",
    "- Use it when constructing orchestration docs and prompt packs.",
    "",
    buildGenericKnowledgePrompt(),
  ].join("\n");
}

// ── Orchestrator System Prompt ────────────────────────────────────────────────

export function buildOrchestratorSystemPrompt(input: {
  objective: string;
  workers: Array<{
    name: string;
    role: string;
    sessionId: string;
    tool: string;
    profileId: string;
    taskPrompt: string;
    systemPrompt?: string;
  }>;
  commandCatalog?: AgentCommandDef[];
  dispatchMode: "orchestrator-first" | "worker-first";
}): string {
  const workerRegistry = input.workers
    .map((w, i) =>
      [
        `─── Worker ${i + 1}: ${w.name} ───────────────────`,
        `  Session ID : ${w.sessionId}`,
        `  Role       : ${w.role}`,
        `  Tool       : ${w.tool} / ${w.profileId}`,
        `  Task prompt: ${w.taskPrompt}`,
      ].join("\n"),
    )
    .join("\n\n");

  const workerContracts = input.workers
    .map((w, i) => {
      const role = inferWorkerRole({ role: w.role, name: w.name, taskPrompt: w.taskPrompt, profileId: w.profileId });
      const rolePrompt = normText(w.systemPrompt) || buildWorkerSystemPrompt(role);
      const compact = compactPromptBlock(rolePrompt, { maxLines: 40, maxChars: 4500 });
      return [
        `WORKER-CONTRACT-${i + 1}: ${w.name} (${role})`,
        compact.text,
        compact.truncated
          ? "(contract truncated for runtime prompt size; full contract is persisted in .agents/system/runtime-worker-contracts.md)"
          : "",
      ].join("\n");
    })
    .join("\n\n");

  const commands = renderCommandCatalogForPrompt(input.commandCatalog ?? defaultCommandCatalog(), {
    maxItems: 20,
    includeWhenToUse: true,
  });

  return [
    "ROLE: MAIN ORCHESTRATOR",
    `You coordinate ${input.workers.length} CLI agent${input.workers.length !== 1 ? "s" : ""} to accomplish the stated objective.`,
    "You are NOT a feature coder. You plan, dispatch, monitor, integrate, and approve.",
    "You are the orchestration authority. Workers implement scoped tasks.",
    "",
    "OBJECTIVE",
    input.objective,
    "",
    `DISPATCH MODE: ${input.dispatchMode.toUpperCase()}`,
    input.dispatchMode === "orchestrator-first"
      ? "On start: plan quickly, then dispatch first scoped prompts within first 2 exchanges."
      : "Workers already started with seeded prompts; verify understanding then steer.",
    "",
    "YOUR WORKER REGISTRY",
    workerRegistry,
    "",
    "DISPATCH FORMAT — MANDATORY",
    "TASK: [single, specific, scoped sentence]",
    "SCOPE: [exact files or directories]",
    "NOT-YOUR-JOB: [forbidden areas]",
    "DONE-WHEN: [testable completion criteria]",
    "VERIFY: [command proving completion]",
    "PRIORITY: [HIGH | NORMAL | LOW]",
    "",
    "APPROVAL GATES",
    "GATE 1: objective alignment",
    "GATE 2: scope compliance",
    "GATE 3: conflict risk",
    "GATE 4: evidence quality",
    "Default: approve low-risk aligned in-scope actions with evidence.",
    "",
    "CONFLICT PREVENTION",
    "- Non-overlapping ownership is default.",
    "- Shared interfaces require designated owner.",
    "- Out-of-scope changes trigger scope-lock.",
    "- Duplicate implementations trigger conflict-resolve.",
    "",
    "MONITORING PROTOCOL",
    "- After each worker exchange: scope, progress, blockers, evidence.",
    "- Checkpoint every 3-5 exchanges.",
    "- If no intervention needed: NO-DISPATCH.",
    "",
    "PROFILE PLAYBOOK",
    buildProfilePlaybookPrompt(),
    "",
    "WORKER SYSTEM PROMPT CONTRACTS (ENFORCE THESE)",
    workerContracts,
    "",
    "FINAL SUMMARY FORMAT",
    "COMPLETED: [with file + verification evidence]",
    "PENDING: [with reason]",
    "RISKS: [edge cases, regression concerns, human review points]",
    "NEXT: [follow-up actions]",
    "",
    "AVAILABLE AGENT COMMANDS",
    commands,
    "",
    buildGenericKnowledgePrompt(),
  ].join("\n");
}

// ── Profile Selection ─────────────────────────────────────────────────────────

function pickCreatorProfile(prefs: HarnessCreatorPrefs): { tool: "opencode" | "codex" | "claude"; profileId: string } {
  if (prefs.budget === "low") return { tool: "opencode", profileId: "opencode.minimax_free" };
  if (prefs.budget === "balanced") return { tool: "opencode", profileId: "opencode.kimi_free" };
  return { tool: "claude", profileId: "claude.default" };
}

// ── Complexity Scoring ────────────────────────────────────────────────────────

function scoreComplexity(objective: string, scan: WorkspaceScanSummary | null): number {
  let score = 1;
  const t = objective.toLowerCase();
  if (/\b(orchestrator|multi|parallel|many|complex|architecture|refactor|migration|redesign)\b/.test(t)) score += 2;
  if (/\b(bug|debug|fix|stability|race|lock|cleanup|reliability|crash|error)\b/.test(t)) score += 1;
  if (/\b(frontend|ui|ux|design|mobile|responsive|animation|layout)\b/.test(t)) score += 1;
  if (/\b(all|entire|every|full|whole|codebase|project)\b/.test(t)) score += 1;
  if (scan) {
    if (scan.fileCount > 1200) score += 2;
    else if (scan.fileCount > 350) score += 1;
    if (scan.frontendLikely && scan.backendLikely) score += 1;
    if (scan.testFileCount < scan.fileCount * 0.05 && scan.fileCount > 100) score += 1;
  }
  return clampInt(score, 1, 8);
}

// ── Plan Builder ──────────────────────────────────────────────────────────────

export function recommendHarnessPlan(input: {
  objective: string;
  prefs: HarnessCreatorPrefs;
  scan: WorkspaceScanSummary | null;
}): CreatorRecommendation {
  const objective = normText(input.objective);
  const prefs = input.prefs;
  const scan = input.scan;
  const complexity = scoreComplexity(objective, scan);
  const wantsFrontend = /\b(frontend|ui|ux|design|responsive|mobile|component|page|screen|layout|style|css)\b/i.test(objective)
    || Boolean(scan?.frontendLikely && !scan?.backendLikely);
  const wantsBackend = /\b(backend|api|server|database|auth|route|endpoint|service|worker|job)\b/i.test(objective)
    || Boolean(scan?.backendLikely);
  const wantsDebug = /\b(bug|fix|debug|error|crash|test|stability|race|lock|verify|check)\b/i.test(objective);
  const creator = pickCreatorProfile(prefs);

  const targetWorkers = complexity <= 2 ? 1 : complexity <= 4 ? 2 : complexity <= 6 ? 3 : 4;
  const workerCount = clampInt(Math.min(targetWorkers, prefs.maxWorkers), 1, 6);

  const workers: CreatorWorkerPlan[] = [];

  if (wantsFrontend && !wantsBackend) {
    workers.push({
      name: "frontend-owner",
      role: "frontend",
      tool: prefs.budget === "low" ? "codex" : "claude",
      profileId: prefs.budget === "low" ? "codex.default" : "claude.accept_edits",
      taskPrompt: `TASK: Implement all UI/UX changes for: ${objective}\nSCOPE: All frontend files (web/, src/, components/, pages/, styles/)\nNOT-YOUR-JOB: Do not modify backend/, server/, or API contracts.\nDONE-WHEN: All UI changes are visible, responsive, and pass visual review.\nVERIFY: npm run build && visual check on 360px and 768px breakpoints.`,
      systemPrompt: buildWorkerSystemPrompt("frontend"),
      rationale: "Frontend-only objective requires dedicated UI ownership and visual quality checks.",
    });
  } else {
    workers.push({
      name: "core-backend",
      role: wantsDebug ? "debug" : "backend",
      tool: "codex",
      profileId: wantsDebug ? "codex.full_auto" : "codex.default",
      taskPrompt: `TASK: Implement backend changes for: ${objective}\nSCOPE: Assigned backend files and modules.\nNOT-YOUR-JOB: Do not modify frontend UI files unless they are API bindings.\nDONE-WHEN: Implementation complete, tsc passes, existing tests pass.\nVERIFY: npm run build && npm test`,
      systemPrompt: buildWorkerSystemPrompt(wantsDebug ? "debug" : "backend"),
      rationale: "Codex is strong for backend correctness; full_auto is preferred for debug-heavy loops.",
    });
  }

  if (workerCount >= 2) {
    if (wantsFrontend && wantsBackend) {
      workers.push({
        name: "frontend-owner",
        role: "frontend",
        tool: prefs.budget === "low" ? "codex" : "claude",
        profileId: prefs.budget === "low" ? "codex.default" : "claude.accept_edits",
        taskPrompt: `TASK: Implement all frontend/UI changes for: ${objective}\nSCOPE: All frontend files (web/, src/ui/, components/, styles/)\nNOT-YOUR-JOB: Do not modify backend/, server/, or API logic.\nDONE-WHEN: UI renders correctly on mobile, passes visual check.\nVERIFY: npm run build:web && visual review at 360px width.`,
        systemPrompt: buildWorkerSystemPrompt("frontend"),
        rationale: "Dedicated frontend owner prevents backend-focused workers from degrading UX quality.",
      });
    } else {
      workers.push({
        name: "debug-verifier",
        role: "debug",
        tool: "codex",
        profileId: "codex.full_auto",
        taskPrompt: `TASK: Debug, test, and verify fixes for: ${objective}\nSCOPE: Test files and targeted bug fixes in assigned modules.\nNOT-YOUR-JOB: Do not implement new features or refactor working code.\nDONE-WHEN: Failing tests pass and reproductions are fixed with evidence.\nVERIFY: npm test -- --reporter=verbose`,
        systemPrompt: buildWorkerSystemPrompt("debug"),
        rationale: "Independent verifier keeps quality measurable and catches regressions early.",
      });
    }
  }

  if (workerCount >= 3) {
    if (wantsFrontend && wantsBackend) {
      workers.push({
        name: "integration-owner",
        role: "integration",
        tool: "codex",
        profileId: "codex.default",
        taskPrompt: `TASK: Maintain shared interfaces and integrate worker outputs for: ${objective}\nSCOPE: Shared type definitions, API contracts, and integration layer.\nNOT-YOUR-JOB: Do not implement domain features inside backend or frontend.\nDONE-WHEN: Build passes, no type conflicts, frontend and backend compose correctly.\nVERIFY: tsc --noEmit && npm run build`,
        systemPrompt: buildWorkerSystemPrompt("integration"),
        rationale: "Integration owner prevents shared-interface drift and merge conflicts.",
      });
    } else {
      workers.push({
        name: "perf-hardening",
        role: "perf",
        tool: "codex",
        profileId: "codex.default",
        taskPrompt: `TASK: Harden reliability and performance for: ${objective}\nSCOPE: Error handling, resource cleanup, and concurrency safety in assigned modules.\nNOT-YOUR-JOB: Do not add features or alter product semantics.\nDONE-WHEN: Critical failure paths are covered and no leak/race hotspots remain.\nVERIFY: npm run build && npm test`,
        systemPrompt: buildWorkerSystemPrompt("perf"),
        rationale: "Hardening pass ensures resilience before completion and prevents hidden production failures.",
      });
    }
  }

  if (workerCount >= 4) {
    workers.push({
      name: "debug-final",
      role: "debug",
      tool: "codex",
      profileId: "codex.full_auto",
      taskPrompt: `TASK: Final cross-worker debugging and regression sweep for: ${objective}\nSCOPE: Integration points between all worker outputs.\nNOT-YOUR-JOB: Do not reimplement completed features.\nDONE-WHEN: No cross-worker regressions and acceptance criteria are fully verified.\nVERIFY: npm run build && npm test`,
      systemPrompt: buildWorkerSystemPrompt("debug"),
      rationale: "Final debug sweep catches integration regressions missed by isolated workers.",
    });
  }

  const needsReasoning = complexity >= 5 || wantsFrontend;
  const orchestratorTool = (prefs.budget === "high" || needsReasoning) ? "claude" : "codex";
  const orchestratorProfileId = orchestratorTool === "claude" ? "claude.default" : "codex.default";
  const commandCatalog = defaultCommandCatalog();

  const orchestratorPrompt = buildOrchestratorSystemPrompt({
    objective,
    workers: workers.map((w) => ({
      ...w,
      sessionId: "<pending — will be set at launch>",
    })),
    commandCatalog,
    dispatchMode: "orchestrator-first",
  });

  const notes: string[] = [];
  notes.push(`Complexity score: ${complexity}/8${complexity >= 6 ? " (high — multiple workers recommended)" : complexity <= 2 ? " (low — single worker sufficient)" : ""}.`);
  notes.push(`Budget: ${prefs.budget}. Priority: ${prefs.priority}.`);
  if (scan) {
    notes.push(`Workspace: ${scan.fileCount} files (${scan.testFileCount} test files, ${scan.tsFileCount} TS, ${scan.jsFileCount} JS).`);
    if (scan.frontendLikely && scan.backendLikely) notes.push("Full-stack codebase detected — frontend/backend split plus integration checks are recommended.");
    else if (scan.frontendLikely) notes.push("Frontend-heavy codebase detected — prioritize visual and interaction verification.");
    else if (scan.backendLikely) notes.push("Backend-heavy codebase detected — prioritize correctness and resilience checks.");
    if (scan.testFileCount < scan.fileCount * 0.05 && scan.fileCount > 100) notes.push("Low test coverage detected — debug/verifier workers are mandatory.");
  }
  if (workers.length === 1) notes.push("Single worker sufficient — task scope is focused.");
  notes.push("Dispatch mode: orchestrator-first — orchestrator sends initial prompts to all workers.");
  notes.push("Long-form reference: buildMasterSystemPromptLibrary(minLines=4096).");

  return {
    creator: {
      tool: creator.tool,
      profileId: creator.profileId,
      systemPrompt: buildCreatorSystemPrompt(),
    },
    orchestrator: {
      tool: orchestratorTool,
      profileId: orchestratorProfileId,
      systemPrompt: orchestratorPrompt,
      dispatchMode: "orchestrator-first",
    },
    workers,
    notes,
    confidence: Math.min(0.95, 0.65 + complexity * 0.04 + (scan ? 0.10 : 0)),
    commandCatalog,
  };
}

import { describe, expect, test } from "vitest";
import {
  buildMasterSystemPromptLibrary,
  buildOrchestratorSystemPrompt,
  buildWorkerSystemPrompt,
  defaultCommandCatalog,
  expertPlaybookCatalog,
} from "../src/harness";

describe("harness prompt quality", () => {
  test("master system prompt library is 4k+ lines", () => {
    const txt = buildMasterSystemPromptLibrary({ minLines: 4096 });
    const lines = txt.split(/\r?\n/);
    expect(lines.length).toBeGreaterThanOrEqual(4096);
    expect(txt.includes("MASTER ORCHESTRATION PROMPT LIBRARY")).toBe(true);
    expect(txt.includes("DEBUG ROOT CAUSE TRIAGE GRID")).toBe(true);
    expect(txt.includes("HYPOTHESIS_TO_TEST")).toBe(true);
    expect(txt.includes("ROLLBACK_TRIGGER")).toBe(true);
    expect(txt.includes("WORKER COMMUNICATION CONTRACT")).toBe(true);
  });

  test("orchestrator prompt embeds worker system contracts including debug profile", () => {
    const debugPrompt = buildWorkerSystemPrompt("debug");
    const orchestrator = buildOrchestratorSystemPrompt({
      objective: "Debug backend behavior",
      dispatchMode: "orchestrator-first",
      workers: [
        {
          name: "debug-verifier",
          role: "debug",
          sessionId: "sid-1",
          tool: "codex",
          profileId: "codex.full_auto",
          taskPrompt: "Find and fix backend bugs.",
          systemPrompt: debugPrompt,
        },
      ],
    });

    expect(orchestrator.includes("WORKER SYSTEM PROMPT CONTRACTS (ENFORCE THESE)")).toBe(true);
    expect(orchestrator.includes("ROLE: DEBUGGER / VERIFIER WORKER")).toBe(true);
    expect(orchestrator.includes("TRIAGE-0001")).toBe(true);
  });

  test("runtime prompts stay bounded and reference full library instead of flooding", () => {
    const debugPrompt = buildWorkerSystemPrompt("debug");
    const debugLines = debugPrompt.split(/\r?\n/);
    expect(debugLines.length).toBeLessThan(280);
    expect(debugPrompt.includes("master-prompt-library.md")).toBe(true);

    const orchestrator = buildOrchestratorSystemPrompt({
      objective: "Stress test orchestration startup prompt sizing",
      dispatchMode: "orchestrator-first",
      workers: [
        {
          name: "debug-a",
          role: "debug",
          sessionId: "sid-a",
          tool: "codex",
          profileId: "codex.full_auto",
          taskPrompt: "Debug worker A",
          systemPrompt: debugPrompt,
        },
        {
          name: "debug-b",
          role: "debug",
          sessionId: "sid-b",
          tool: "codex",
          profileId: "codex.default",
          taskPrompt: "Debug worker B",
          systemPrompt: debugPrompt,
        },
      ],
    });
    const orchLines = orchestrator.split(/\r?\n/);
    expect(orchLines.length).toBeLessThan(900);
    expect(orchestrator.includes("contract truncated for runtime prompt size")).toBe(true);
  });

  test("command catalog and expert playbooks include expanded SOTA entries", () => {
    const commandIds = new Set(defaultCommandCatalog().map((c) => c.id));
    expect(commandIds.size).toBeGreaterThanOrEqual(40);
    expect(commandIds.has("diag-evidence")).toBe(true);
    expect(commandIds.has("test-tdd")).toBe(true);
    expect(commandIds.has("verify-completion")).toBe(true);
    expect(commandIds.has("review-request")).toBe(true);
    expect(commandIds.has("security-sast")).toBe(true);
    expect(commandIds.has("coord-task")).toBe(true);
    expect(commandIds.has("team-launch")).toBe(true);
    expect(commandIds.has("threat-model-stride")).toBe(true);
    expect(commandIds.has("attack-tree-map")).toBe(true);
    expect(commandIds.has("security-requirements")).toBe(true);
    expect(commandIds.has("mitigation-map")).toBe(true);
    expect(commandIds.has("auth-hardening")).toBe(true);
    expect(commandIds.has("error-path-audit")).toBe(true);
    expect(commandIds.has("resilience-chaos-check")).toBe(true);
    expect(commandIds.has("observability-pass")).toBe(true);
    expect(commandIds.has("incident-drill")).toBe(true);
    expect(commandIds.has("contract-drift-check")).toBe(true);
    expect(commandIds.has("integration-gate")).toBe(true);
    expect(commandIds.has("rollback-drill")).toBe(true);
    expect(commandIds.has("release-readiness")).toBe(true);
    expect(commandIds.has("perf-budget-gate")).toBe(true);
    expect(commandIds.has("frontend-mobile-gate")).toBe(true);
    expect(commandIds.has("motion-reduced-check")).toBe(true);
    expect(commandIds.has("design-parity-matrix")).toBe(true);
    expect(commandIds.has("ownership-audit")).toBe(true);
    expect(commandIds.has("communication-audit")).toBe(true);

    const playbookPaths = new Set(expertPlaybookCatalog().map((p) => p.path));
    expect(playbookPaths.size).toBeGreaterThanOrEqual(20);
    expect(playbookPaths.has("docs/agent-command-library/06-skill-crosswalk-security-orchestration.md")).toBe(true);
    expect(playbookPaths.has("docs/agent-command-library/07-skill-crosswalk-frontend-mobile.md")).toBe(true);
    expect(playbookPaths.has("docs/agent-command-library/08-command-automation-recipes.md")).toBe(true);
    expect(playbookPaths.has("docs/agent-command-library/09-sota-gap-matrix.md")).toBe(true);
    expect(playbookPaths.has("docs/agent-command-library/10-threat-modeling-and-sast-pipeline.md")).toBe(true);
    expect(playbookPaths.has("docs/agent-command-library/11-debug-hypothesis-lab.md")).toBe(true);
    expect(playbookPaths.has("docs/agent-command-library/12-testing-verification-review-gates.md")).toBe(true);
    expect(playbookPaths.has("docs/agent-command-library/13-auth-and-session-hardening.md")).toBe(true);
    expect(playbookPaths.has("docs/agent-command-library/14-error-handling-and-recovery-patterns.md")).toBe(true);
    expect(playbookPaths.has("docs/agent-command-library/15-team-communication-and-task-governance.md")).toBe(true);
    expect(playbookPaths.has("docs/agent-command-library/16-parallel-execution-and-conflict-arbitration.md")).toBe(true);
    expect(playbookPaths.has("docs/agent-command-library/17-release-readiness-rollback-incident.md")).toBe(true);
    expect(playbookPaths.has("docs/agent-command-library/18-frontend-platform-parity-motion.md")).toBe(true);
    expect(playbookPaths.has("docs/agent-command-library/19-observability-and-slo-ops.md")).toBe(true);
    expect(playbookPaths.has("docs/agent-command-library/20-expanded-command-reference.md")).toBe(true);
    expect(playbookPaths.has("docs/agent-command-library/21-deep-research-foundations.md")).toBe(true);
  });
});

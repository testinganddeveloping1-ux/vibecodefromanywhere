# Command Automation Recipes

This document defines executable behavior for high-signal orchestration commands.

## Purpose

Convert skill-derived best practices into concise command packets that orchestrators can reuse.

## Command Recipes

## `diag-evidence`

### Intent
Create deterministic evidence before any fix attempt.

### Input schema

```json
{
  "target": "worker:Worker A",
  "bug": "short title",
  "scope": ["server/src/...", "server/test/..."],
  "repro": "exact command",
  "logs": ["log source A", "log source B"]
}
```

### Worker packet

```text
TASK: Produce deterministic reproduction evidence for <bug>.
SCOPE: <scope>
NOT-YOUR-JOB: patching yet
DONE-WHEN: repro command output + trace path + hypothesis list posted
VERIFY: <repro command>
```

### Expected outputs

- Repro status (pass/fail)
- Trace path
- Top hypotheses
- Suggested next verify commands

## `test-tdd`

### Intent
Enforce red-green-refactor loop.

### Input schema

```json
{
  "target": "worker:Worker A",
  "scope": ["files"],
  "testPath": "path/to/test",
  "behavior": "what should fail then pass"
}
```

### Worker packet

```text
TASK: Implement via TDD for <behavior>.
SCOPE: <scope>
NOT-YOUR-JOB: unrelated refactors
DONE-WHEN: failing test proven before fix, passing test after fix
VERIFY: <test command>
```

### Required proof

- Failing test output (before)
- Passing test output (after)
- Any new edge-case tests

## `verify-completion`

### Intent
Block completion claims until fresh verification output exists.

### Input schema

```json
{
  "target": "worker:Worker A",
  "verify": ["npm run test ...", "npm run build ..."],
  "claim": "what is being claimed complete"
}
```

### Worker packet

```text
TASK: Verify completion claim with fresh command output.
SCOPE: verification only
NOT-YOUR-JOB: new implementation
DONE-WHEN: verify commands run and outputs posted
VERIFY: <verify commands>
```

## `review-request`

### Intent
Trigger structured review request and response loop.

### Input schema

```json
{
  "target": "worker:Worker A",
  "baseSha": "...",
  "headSha": "...",
  "focus": ["security", "reliability", "tests"]
}
```

### Required worker report

- Review findings by severity
- Applied fixes
- Deferred findings with reason

## `process-retro`

### Intent
Capture process flaws and corrective actions after a meaningful task cycle.

### Input schema

```json
{
  "target": "worker:Worker A",
  "scope": ["workflow", "dispatch", "verification", "handoff"],
  "context": "short summary of recent task run"
}
```

### Required outputs

- Top process failures (not code bugs)
- Evidence for each failure
- Corrective rule update proposal
- Which rule becomes mandatory next cycle

## `security-sast`

### Intent
Enforce SAST scan and mitigation mapping for security-sensitive work.

### Input schema

```json
{
  "target": "worker:Worker A",
  "scope": ["changed paths"],
  "scanCommand": "semgrep --config=auto --error",
  "threats": ["ids or summaries"]
}
```

### Required outputs

- Scan summary
- True positives and mitigations
- False positive rationale
- Residual risk

## `coord-task`

### Intent
Normalize worker task packets and ownership constraints.

### Input schema

```json
{
  "target": "worker:Worker A",
  "task": "...",
  "scope": ["owned paths"],
  "notYourJob": ["..."],
  "doneWhen": ["..."],
  "verify": ["..."]
}
```

### Required shape

- TASK
- SCOPE
- NOT-YOUR-JOB
- DONE-WHEN
- VERIFY
- PRIORITY

## `team-launch`

### Intent
Start a right-sized team profile based on complexity.

### Suggested profiles

- `debug-lite`: orchestrator + 1 debug worker
- `debug-standard`: orchestrator + 2 workers (debug + verifier)
- `integration-heavy`: orchestrator + 3 workers (backend + contracts + QA)
- `frontend-hard`: orchestrator + 2 workers (UI + accessibility)

### Constraints

- Prefer smallest team that can cover risk dimensions.
- Enforce non-overlapping ownership maps.

## Automation Failure Policies

### Dispatch failure

- Retry once with same payload.
- Retry via session fallback route.
- Escalate as infra blocker if still failing.

### Worker silence

- Trigger `diag-evidence` or status ping packet.
- Do not interrupt active worker unless policy allows.

### Contradictory outputs

- Freeze conflicting workers.
- Run `conflict-resolve` with authoritative owner assignment.

## Evidence Payload Contract

Every command should produce these fields:

```text
COMMAND:
TARGET:
INPUT_SUMMARY:
RESULT:
EVIDENCE:
NEXT:
```

## Recommended API alignment

Map these command IDs to orchestration endpoints and directives:

- `/api/orchestrations/:id/dispatch`
- `/api/orchestrations/:id/send-task`
- inline `FYP_DISPATCH_JSON`
- inline `FYP_SEND_TASK_JSON`
- `FYP_ANSWER_QUESTION_JSON`

## Notes

These recipes are intentionally transport-agnostic so they work with Codex, Claude, or OpenCode worker profiles.

# Skill Crosswalk: Security, Debugging, Testing, and Orchestration

This document is a synthesis pass across local skills to produce enforceable orchestrator/worker protocols.

## Sources Audited (full read)

- `/home/archu/.codex/skills/obra-superpowers/skills/systematic-debugging/SKILL.md`
- `/home/archu/.codex/skills/obra-superpowers/skills/test-driven-development/SKILL.md`
- `/home/archu/.codex/skills/obra-superpowers/skills/verification-before-completion/SKILL.md`
- `/home/archu/.codex/skills/obra-superpowers/skills/requesting-code-review/SKILL.md`
- `/home/archu/.codex/skills/obra-superpowers/skills/receiving-code-review/SKILL.md`
- `/home/archu/.codex/skills/wshobson-agents/plugins/developer-essentials/skills/debugging-strategies/SKILL.md`
- `/home/archu/.codex/skills/wshobson-agents/plugins/developer-essentials/skills/auth-implementation-patterns/SKILL.md`
- `/home/archu/.codex/skills/wshobson-agents/plugins/developer-essentials/skills/error-handling-patterns/SKILL.md`
- `/home/archu/.codex/skills/wshobson-agents/plugins/javascript-typescript/skills/javascript-testing-patterns/SKILL.md`
- `/home/archu/.codex/skills/wshobson-agents/plugins/security-scanning/skills/attack-tree-construction/SKILL.md`
- `/home/archu/.codex/skills/wshobson-agents/plugins/security-scanning/skills/stride-analysis-patterns/SKILL.md`
- `/home/archu/.codex/skills/wshobson-agents/plugins/security-scanning/skills/security-requirement-extraction/SKILL.md`
- `/home/archu/.codex/skills/wshobson-agents/plugins/security-scanning/skills/threat-mitigation-mapping/SKILL.md`
- `/home/archu/.codex/skills/wshobson-agents/plugins/security-scanning/skills/sast-configuration/SKILL.md`
- `/home/archu/.codex/skills/wshobson-agents/plugins/agent-teams/skills/task-coordination-strategies/SKILL.md`
- `/home/archu/.codex/skills/wshobson-agents/plugins/agent-teams/skills/team-communication-protocols/SKILL.md`
- `/home/archu/.codex/skills/wshobson-agents/plugins/agent-teams/skills/team-composition-patterns/SKILL.md`
- `/home/archu/.codex/skills/wshobson-agents/plugins/agent-teams/skills/parallel-debugging/SKILL.md`
- `/home/archu/.codex/skills/wshobson-agents/plugins/agent-teams/skills/parallel-feature-development/SKILL.md`
- `/home/archu/.codex/skills/wshobson-agents/plugins/agent-teams/skills/multi-reviewer-patterns/SKILL.md`

## SOTA Operating Pipeline (enforced)

This is the default sequence for debug and hardening work:

1. Scope-lock and objective framing
2. Reproduce with deterministic evidence
3. Instrument and trace
4. Hypothesis framing (parallel when needed)
5. Failing test first (red)
6. Minimal root-cause fix (green)
7. Refactor and harden
8. Verification-before-completion gate
9. Multi-dimension review gate
10. Security and SAST gate
11. Handoff with rollback triggers

If any gate fails, do not advance.

## Unified Mandatory Rules

### 1) Debug First, Fix Second

- Do not patch before a reproducible signal exists.
- Capture data flow path and failing invariant.
- If multiple plausible causes exist, run competing hypotheses with evidence scoring.

### 2) TDD on all behavior changes

- For bugfixes and features, create failing tests first.
- Confirm test fails for the expected reason.
- Implement minimal change to pass.
- Refactor only after green.

### 3) Completion claims require fresh execution evidence

- No “should pass” statements.
- No stale test runs.
- No completion without output from the exact verify commands.

### 4) Review is a quality gate, not an optional ritual

- Request review after each major deliverable.
- Fix Critical and Important findings before merge.
- Resolve or document every Minor finding.

### 5) Security requirements must be threat-traceable

- Every requirement references threat source.
- Every requirement has acceptance criteria and tests.
- Controls must include preventive, detective, and corrective coverage.

### 6) SAST is required for security-facing changes

- Baseline scan before hardening cycle.
- CI gate for critical classes.
- False positives documented, not silently ignored.

### 7) Orchestrator communication discipline

- Task packets include TASK/SCOPE/NOT-YOUR-JOB/DONE-WHEN/VERIFY.
- Use direct messages for worker-specific updates.
- Broadcast only for shared blockers.
- Keep team size minimal for the scope.

### 8) Ownership and conflict discipline

- Exactly one owner per file at a time.
- Shared interface contracts are explicit.
- Conflicts resolved by authoritative owner assignment.

## Skill-Derived Command Crosswalk

| Command | Derived From Skills | What it enforces |
|---|---|---|
| `diag-evidence` | `systematic-debugging`, `debugging-strategies`, `parallel-debugging` | Deterministic repro + layered evidence before edits |
| `test-tdd` | `test-driven-development`, `javascript-testing-patterns` | Red->Green->Refactor and explicit fail-before-fix proof |
| `verify-completion` | `verification-before-completion` | Fresh verification output before completion claims |
| `review-request` | `requesting-code-review`, `receiving-code-review`, `multi-reviewer-patterns` | Structured review loop with severity discipline |
| `security-sast` | `sast-configuration`, `security-requirement-extraction`, `threat-mitigation-mapping` | SAST + requirement traceability + control coverage |
| `coord-task` | `task-coordination-strategies`, `team-communication-protocols`, `parallel-feature-development` | File ownership, acceptance criteria, dependency clarity |
| `team-launch` | `team-composition-patterns` | Right-size team composition and role split |

## Anti-Patterns to Explicitly Block

- Blind fixes without repro evidence
- Multi-file broad refactors while root cause is unknown
- Completion claims without command output
- Silent catch blocks and swallowed errors
- Security controls added without threat mapping
- Ad-hoc team messaging with no packet format
- Multi-owner edits to same file without arbitration
- Review deferral until “later” for high-risk paths

## Evidence Standards

For each bug or hardening item, workers must return:

```text
BUG:
ROOT:
FIX:
TEST:
RESULT:
ROLLBACK_TRIGGER:
```

And include:

- exact command executed
- key output lines
- changed files
- residual risk note

## High-Signal Dispatch Templates

### Debug worker template

```text
TASK: Reproduce and isolate root cause for <bug title>.
SCOPE: <exact files/dirs>
NOT-YOUR-JOB: feature additions, refactors outside scope
DONE-WHEN: BUG/ROOT/FIX/TEST/RESULT posted with command output
VERIFY: <targeted test>; <broad test subset>
PRIORITY: HIGH
```

### Security worker template

```text
TASK: Validate exploitability in authorized test scope and propose minimal remediation.
SCOPE: <authorized paths/components>
NOT-YOUR-JOB: unsanctioned targets, broad architecture rewrites
DONE-WHEN: threat->requirement->control map + passing regression tests
VERIFY: <security test command>; <sast command>
PRIORITY: HIGH
```

### Orchestrator review template

```text
REVIEW-HARD:
CHECKS: scope compliance, evidence quality, regressions, security impact
DECISION: approve | request changes | hold
RATIONALE:
NEXT ACTION:
```

## Severity Calibration Baseline

- Critical: data loss, auth bypass, remote code execution, cross-tenant access
- High: privilege escalation path, persistent corruption, major outage risk
- Medium: functional break with workaround, reliability debt in critical path
- Low: non-blocking quality defects

## Rollback Readiness Requirements

Before approving high-risk changes:

- Define explicit rollback trigger.
- Define rollback command/procedure.
- Validate rollback restores expected baseline behavior.

## Integration with Existing Playbooks

This crosswalk should be applied alongside:

- `01-security-debug-pentest.md`
- `02-backend-reliability-resilience.md`
- `03-api-integration-contracts.md`
- `05-orchestrator-expert-operations.md`

Use this document as the policy bridge between skills and commands.

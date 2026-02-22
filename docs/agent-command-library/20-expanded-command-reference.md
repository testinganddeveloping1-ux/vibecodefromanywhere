# Expanded Command Reference

This is the canonical reference for orchestrator command semantics.

## Core Orchestration Commands

- `replan`
- `sync-status`
- `handoff`
- `scope-lock`
- `conflict-resolve`
- `ownership-audit`
- `communication-audit`
- `team-launch`

## Debug and Quality Commands

- `diag-evidence`
- `test-tdd`
- `flake-hunt`
- `verify-completion`
- `review-request`
- `review-hard`

## Security Commands

- `security-threat-model`
- `threat-model-stride`
- `attack-tree-map`
- `security-vuln-repro`
- `security-requirements`
- `mitigation-map`
- `security-remediation`
- `security-sast`
- `dependency-risk-audit`

## Reliability and Release Commands

- `backend-hardening`
- `error-path-audit`
- `resilience-chaos-check`
- `data-integrity-audit`
- `perf-regression-lab`
- `perf-budget-gate`
- `rollback-drill`
- `release-readiness`
- `incident-drill`
- `observability-pass`

## Contracts and Integration Commands

- `contract-audit`
- `contract-drift-check`
- `integration-gate`
- `coord-task`

## Frontend and Accessibility Commands

- `frontend-pass`
- `frontend-mobile-gate`
- `design-parity-matrix`
- `motion-reduced-check`
- `accessibility-hard-check`

## Universal Command Output Contract

All commands should report:

```text
COMMAND:
TARGET:
SCOPE:
RESULT:
EVIDENCE:
RISKS:
NEXT:
```

## Command Safety Levels

### Level 1 (low risk)

- planning/sync/reporting commands

### Level 2 (medium risk)

- scoped implementation and review commands

### Level 3 (high risk)

- security remediation
- release/rollback actions
- broad integration changes

## Level 3 Required Extras

- explicit rollback trigger
- explicit owner approval
- fresh verification outputs
- residual risk statement

## Dispatch Packet Example

```text
TASK: Execute <command> for <goal>.
SCOPE: <paths/modules>
NOT-YOUR-JOB: <forbidden work>
DONE-WHEN: <observable completion>
VERIFY: <commands>
PRIORITY: <HIGH|NORMAL|LOW>
```

## Question Packet Example

```text
QUESTION:
CONTEXT:
FILES:
OPTIONS:
RECOMMENDED:
BLOCKING:
```

## No-Dispatch Rule

When worker trajectory is healthy and in-scope, do not interrupt.

## Escalation Rule

Escalate to user when:

- command preconditions fail repeatedly
- security risk exceeds policy bounds
- rollback cannot guarantee restoration
- ownership conflicts remain unresolved

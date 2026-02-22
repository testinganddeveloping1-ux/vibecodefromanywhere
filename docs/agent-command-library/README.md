# Agent Command Library

This library is the authoritative reference for orchestrator command behavior and worker execution quality.

It is built from local skill crosswalks plus operational hardening docs so commands stay actionable and evidence-first.

## Library Contents

1. `01-security-debug-pentest.md`
2. `02-backend-reliability-resilience.md`
3. `03-api-integration-contracts.md`
4. `04-frontend-quality-accessibility.md`
5. `05-orchestrator-expert-operations.md`
6. `06-skill-crosswalk-security-orchestration.md`
7. `07-skill-crosswalk-frontend-mobile.md`
8. `08-command-automation-recipes.md`
9. `09-sota-gap-matrix.md`
10. `10-threat-modeling-and-sast-pipeline.md`
11. `11-debug-hypothesis-lab.md`
12. `12-testing-verification-review-gates.md`
13. `13-auth-and-session-hardening.md`
14. `14-error-handling-and-recovery-patterns.md`
15. `15-team-communication-and-task-governance.md`
16. `16-parallel-execution-and-conflict-arbitration.md`
17. `17-release-readiness-rollback-incident.md`
18. `18-frontend-platform-parity-motion.md`
19. `19-observability-and-slo-ops.md`
20. `20-expanded-command-reference.md`
21. `21-deep-research-foundations.md`
22. `22-sota-enforcement-loop.md`
23. `23-live-skill-provenance-model.md`
24. `24-manual-sota-review-2026-02-21.md`

## Command Families

## Orchestration and Governance

- `replan`
- `sync-status`
- `handoff`
- `scope-lock`
- `conflict-resolve`
- `coord-task`
- `team-launch`
- `ownership-audit`
- `communication-audit`

## Debug and Quality Gates

- `diag-evidence`
- `test-tdd`
- `flake-hunt`
- `verify-completion`
- `review-request`
- `review-hard`

## Security and Threat Engineering

- `security-threat-model`
- `threat-model-stride`
- `attack-tree-map`
- `security-vuln-repro`
- `security-requirements`
- `mitigation-map`
- `security-remediation`
- `security-sast`
- `dependency-risk-audit`
- `auth-hardening`

## Reliability, Release, and Operations

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

## Contracts and Integration

- `contract-audit`
- `contract-drift-check`
- `integration-gate`

## Frontend, Mobile, and Accessibility

- `frontend-pass`
- `frontend-mobile-gate`
- `design-parity-matrix`
- `motion-reduced-check`
- `accessibility-hard-check`

## Skill Corpus Used in Crosswalk Passes

These docs were upgraded by reading and synthesizing local skills under:

- `obra-superpowers` (systematic debugging, TDD, verification, review loop)
- `wshobson-agents` security-scanning (STRIDE, attack trees, requirement extraction, mitigation mapping, SAST)
- `wshobson-agents` developer essentials (auth, error handling, debugging)
- `wshobson-agents` agent-team coordination (task coordination, communication protocols, team composition, parallel debugging/feature development, multi-reviewer)
- `anthropics-skills` + `wshobson-agents` UI/mobile/accessibility skills

## Safety and Authorization Rules

- Security testing must be authorized and scoped.
- Exploit reproduction must run in isolated lab/sandbox or approved staging.
- Nothing in these docs authorizes testing systems you do not own/control.
- High-risk commands require rollback trigger + evidence + approval.

## Execution Contract (All Modes)

- Evidence before assertion.
- Root cause before broad patch.
- Minimal scoped change before refactor.
- Fresh verification before completion claim.
- Explicit rollback trigger for high-risk changes.

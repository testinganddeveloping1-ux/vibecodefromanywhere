# Release Readiness, Rollback, and Incident Preparedness

This is the go/no-go framework for high-confidence releases.

## Source Skills

- `verification-before-completion`
- `on-call-handoff-patterns` (conceptual alignment)
- `incident-runbook-templates`
- `postmortem-writing`

## Command Links

- `release-readiness`
- `rollback-drill`
- `incident-drill`
- `verify-completion`

## Release Gates

1. Quality gate (tests/build/lint)
2. Security gate (threats, controls, SAST)
3. Reliability gate (failure-path checks)
4. Contract gate (consumer compatibility)
5. Operational gate (monitoring/alerts/runbook)

All gates must pass for go.

## Go/No-Go Packet

```text
RELEASE_SCOPE:
GATE_STATUS:
OPEN_RISKS:
ROLLBACK_PLAN:
ON_CALL_OWNER:
DECISION:
```

## Rollback Drill Standard

- Trigger condition is explicit and measurable.
- Procedure is executable and tested.
- Validation confirms restored baseline.
- Maximum rollback time objective is defined.

## Incident Drill Standard

- Scenario chosen from realistic failure classes.
- Escalation path and responsibilities tested.
- Communication templates validated.
- Follow-up actions captured.

## Runbook Essentials

Each runbook must include:

- detection signals
- triage steps
- containment actions
- rollback/fix path
- verification and communication steps

## Anti-Patterns

- release with undefined rollback
- no owner for incident response
- go decision based on sentiment instead of evidence

## Done Criteria

- go/no-go packet completed
- rollback drill validated
- incident drill completed for critical paths

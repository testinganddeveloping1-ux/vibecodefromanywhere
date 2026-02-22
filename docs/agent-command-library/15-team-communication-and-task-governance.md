# Team Communication and Task Governance

Orchestrator and worker communication must be structured, low-noise, and auditable.

## Source Skills

- `task-coordination-strategies`
- `team-communication-protocols`
- `team-composition-patterns`

## Command Links

- `coord-task`
- `communication-audit`
- `team-launch`
- `sync-status`

## Task Packet Standard

Every dispatch must contain:

- TASK
- SCOPE
- NOT-YOUR-JOB
- DONE-WHEN
- VERIFY
- PRIORITY

## Message Type Discipline

- direct message for worker-specific updates
- broadcast only for shared blockers or cross-team changes
- avoid conversational chatter in active execution loops

## Blocker Question Packet

```text
QUESTION:
CONTEXT:
FILES:
OPTIONS:
RECOMMENDED:
BLOCKING:
```

## Cadence Policy

- checkpoint summaries at bounded intervals
- no interrupt storms
- no-op reviews are valid when progress is healthy

## Ownership Rules

- one primary owner per file/path
- shared contracts require explicit integration owner
- scope drift triggers immediate scope-lock

## Governance Anti-Patterns

- vague dispatches
- hidden blockers
- overlapping ownership with no arbitration
- review decisions without evidence

## Metrics

Track:

- blocker response latency
- dispatch success rate
- conflict frequency
- evidence completeness rate

## Done Criteria

- all tasks have auditable packet history
- blockers handled through structured protocol
- ownership map clear and conflict-controlled

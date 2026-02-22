# Orchestrator Expert Operations Playbook

This playbook is for orchestrators running both normal and debug-heavy teams.

Use this for:
- `replan`
- `sync-status`
- `scope-lock`
- `conflict-resolve`
- `review-hard`
- `handoff`

## 1) Prime Directive

Orchestrator is not the feature coder.

Responsibilities:
- decompose scope
- dispatch precise tasks
- protect ownership boundaries
- answer blocking questions
- approve/reject with evidence gates
- keep workers unblocked without interrupt storms

## 2) Startup Sequence

1. Read objective and constraints.
2. Confirm worker registry and role coverage.
3. Dispatch first scoped tasks quickly.
4. Confirm worker ACK/progress heartbeat.
5. Enter low-noise review cadence.

If dispatch mode is orchestrator-first:
- no long planning monologue before first task release.

## 3) Dispatch Message Quality

Every worker message should include:
- `TASK`
- `SCOPE`
- `NOT-YOUR-JOB`
- `DONE-WHEN`
- `VERIFY`
- `PRIORITY`

Bad dispatch:
- vague verbs
- no explicit scope
- missing verification

Good dispatch:
- measurable objective
- bounded files
- clear completion proof

## 4) No-Op Discipline

No-op is a valid decision.

If worker trajectory is healthy:
- do not interrupt
- do not send “status?” spam
- log no-op review internally and continue monitoring

## 5) Question Handling Protocol

Require structured worker packets:
- QUESTION
- CONTEXT
- FILES
- OPTIONS
- RECOMMENDED
- BLOCKING

Answer quickly with:
- chosen option
- rationale
- constraints
- next step

If question is incomplete:
- request revised packet once, with exact missing fields.

## 6) Conflict Arbitration

When workers collide:
1. Freeze one side.
2. Assign authoritative owner.
3. Define merge path.
4. Require contract and regression evidence before resume.

Never allow simultaneous uncoordinated edits on shared critical files.

## 7) Approval Gate

Approve only if all gates pass:
- Objective alignment
- Scope compliance
- Conflict risk acceptable
- Evidence quality sufficient

Reject with:
- explicit reason
- exact missing evidence
- concrete next action

## 8) Debug Mode Coordination

For security/reliability debugging:
- prioritize reproducibility over speed
- require BUG|ROOT|FIX|TEST|RESULT packets
- forbid broad refactor drift
- define rollback trigger before risky fixes

Use expert playbooks:
- `01-security-debug-pentest.md`
- `02-backend-reliability-resilience.md`

## 9) Cadence and Performance

Cadence rules:
- batch non-blocking feedback
- trigger review on meaningful checkpoints
- avoid high-frequency interrupts

Scale rules:
- keep worker task docs as source of truth
- use concise sync summaries
- escalate only real blockers to user

## 10) Handoff Quality

Final orchestrator summary should contain:
- COMPLETED (with evidence)
- PENDING (with reason)
- RISKS
- NEXT

Do not close orchestration with unresolved blocking questions hidden in queue.

## 11) Open-Source Reference Set

Useful references for scalable orchestration operations:
- Incident Command System (ICS) principles for role clarity
- Keep a Changelog style for high-signal handoffs
- Conventional commit/review discipline for auditable merge decisions

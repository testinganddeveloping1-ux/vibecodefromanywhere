# Orchestrator Core (Backend, Agent Contracts, and Edge Cases)

## 1) Purpose
This document defines the backend orchestration core for FromYourPhone.
It is intentionally specific.
It is written to remove ambiguity across Creator, Orchestrator, Worker, Improver, and UI layers.
It is also written so a frontend-design agent can implement UI without guessing backend semantics.

## 2) Product outcome
The system must let one user run multiple coding CLIs concurrently.
The user must be able to run one project or many projects.
The user must be able to choose single session, grouped sessions, or orchestrator-led groups.
The user must see only app-created tasks by default.
The user must be able to act quickly on pending approvals.
The user must not get crowded by random machine sessions.

## 3) Scope
In scope:
- Task creation planning.
- Orchestrator + worker session orchestration.
- Dispatch command bus.
- Digest-based non-interruptive synchronization.
- Approval inbox and action routing.
- Worker isolation and cleanup.
- Role-specific behavior controls.

Out of scope:
- MCP-first orchestration runtime.
- External scheduler dependency.
- Multi-tenant cloud auth design.

## 4) Why HTTP/WS command bus (instead of MCP-first)
The current core is HTTP/WS first.
Reason 1: lower operational complexity.
Reason 2: easier to inspect and debug.
Reason 3: works consistently across Codex, Claude, OpenCode transports.
Reason 4: aligns with existing API and mobile app data flow.
Reason 5: easier testability in unit/integration tests.

MCP is not forbidden.
MCP is deferred.
MCP can be introduced later for specialized external tools.
MCP is not required for reliable orchestrator-to-worker coordination.

## 5) Core entities
Entity: FYP Session.
Definition: server-managed runtime terminal or codex-app-server session.
Identity: `sessions.id`.

Entity: Tool Session.
Definition: native CLI thread/session identity.
Examples: Codex thread, Claude session, OpenCode session id.

Entity: Task.
Definition: user-facing grouping of one or more FYP sessions.
Kinds: single, group, orchestrator.

Entity: Orchestration.
Definition: parent coordinator session plus worker session set and metadata.
Identity: orchestration id.

Entity: Attention item (Inbox item).
Definition: actionable approval/question requiring response or dismissal.

## 6) Runtime roles
Role: Creator.
Goal: build deterministic plan before coding starts.
Output: recommended worker split, model/tool choices, initial prompts, behavior plan.
API surface: `POST /api/harness/creator/recommend` and `POST /api/harness/creator/build`.

Role: Orchestrator.
Goal: dispatch, monitor, replan, integrate, summarize.
Constraint: should not do most implementation directly.
Constraint: should enforce file ownership boundaries.
API surface: orchestration routes plus dispatch command bus.

Role: Worker.
Goal: execute scoped implementation tasks with verification evidence.
Constraint: avoid overlapping edits unless explicitly reassigned.
Constraint: use subagents only inside configured policy.

Role: Improver.
Goal: evolve reusable command recipes and system prompts.
Constraint: produce measurable commands, not vague instructions.

Role: User.
Goal: define objective, set constraints, approve critical actions, review outputs.
Constraint: should not be forced to micromanage every worker turn.

## 7) Agent capability assumptions
Codex workers are strong at backend implementation and debugging.
Claude workers are strong at architecture and frontend quality.
OpenCode workers can be cost-efficient for planning and lightweight tasks.
These are defaults.
Creator can override based on user budget and quality priority.

## 8) Cost and quality policy
Budget mode `low` prefers low-cost creator profile.
Budget mode `balanced` uses balanced free/cheap planning profile.
Budget mode `high` permits premium planning/orchestration profile.
Quality priority may route orchestrator toward Claude.
Backend-heavy tasks tend to route workers toward Codex.
Frontend-heavy tasks should include dedicated frontend worker.

## 9) Creation lifecycle
Step 1: collect objective and constraints.
Step 2: optional workspace scan summary.
Step 3: creator recommendation.
Step 4: build ready orchestration payload.
Step 5: create orchestration.
Step 6: spawn workers.
Step 7: spawn orchestrator.
Step 8: optional initial dispatch.
Step 9: run loop with digest sync.
Step 10: cleanup and archive.

## 10) New creator build endpoint
Endpoint: `POST /api/harness/creator/build`.
Goal: produce a ready `POST /api/orchestrations` payload with behavior controls included.
Required fields: objective, projectPath.
Optional fields: prefs, behavior, manual workers, orchestrator overrides.

Returned fields:
- recommendation.
- behavior (normalized).
- orchestrationSpec (ready to submit).
- postCreateActions (sync policy patch template).
- notes.

This removes UI-side guesswork.
This keeps creation deterministic.

## 11) Behavior control model
`coordinationStyle`:
- strict.
- balanced.
- exploratory.

`approvalPolicy`:
- manual.
- guarded-auto.

`interruptPolicy`:
- manual.
- on-blocker.
- never.

`enforceFileOwnership`:
- true or false.

`allowWorkerSubagents`:
- true or false.

`maxWorkerSubagents`:
- integer, clamped.

`autoDispatchInitialPrompts`:
- true or false.

`sync`:
- mode.
- intervalMs.
- deliverToOrchestrator.
- minDeliveryGapMs.

## 12) Behavior intent per control
Strict coordination style:
- no ambiguous work requests.
- no scope creep.
- tighter acceptance checks.

Balanced coordination style:
- moderate autonomy.
- moderate replan frequency.

Exploratory style:
- more freedom for alternatives.
- still must report evidence.

Manual approval:
- no auto-approve.
- user or explicit orchestrator decision required.

Guarded-auto approval:
- can auto-approve only low-risk reversible operations.
- must escalate destructive/external-risk operations.

Manual interrupt:
- default no interrupt.
- user decides interrupt moments.

On-blocker interrupt:
- interrupt only when blocked or unsafe.

Never interrupt:
- preserve momentum unless user explicitly overrides.

## 13) Context packages by role
Creator context package:
- objective.
- budget and quality preferences.
- workspace scan summary.
- worker limits.
- behavior defaults.

Orchestrator context package:
- objective.
- worker registry.
- dispatch mode.
- command bus examples.
- behavior controls.
- sync policy target.

Worker context package:
- objective.
- explicit worker role.
- assigned task.
- anti-slop and verification contract.
- peer worker list.
- file ownership rule.

Improver context package:
- current command catalog.
- observed failure patterns.
- quality targets.

## 14) Prompt contracts
Prompt contract for creator must include:
- explicit ownership split.
- non-goals per worker.
- acceptance checks per worker.
- rationale for worker count.

Prompt contract for orchestrator must include:
- dispatch plan.
- blockers protocol.
- integration protocol.
- escalation protocol.

Prompt contract for worker must include:
- assigned scope.
- forbidden scope.
- deliverables.
- verification evidence requirement.

Prompt contract for improver must include:
- trigger condition.
- command input shape.
- command output shape.
- rollback guidance where relevant.

## 15) File ownership strategy
Default policy: disjoint ownership.
Each worker should own a module area.
Integration worker owns cross-cutting glue.
No duplicate implementations in parallel branches.
No shadow feature copies in alternate folders.

When overlap is unavoidable:
- orchestrator pauses new dispatch to conflicting workers.
- orchestrator issues integration checkpoint.
- workers hand off in defined sequence.

## 16) Git/worktree strategy
Default worker isolation: enabled.
Each worker can use dedicated worktree and branch.
Branch naming is deterministic with worker index and name slug.
Cleanup path is tracked per orchestration.

If isolation disabled per worker:
- worker edits project path directly.
- higher risk of conflicts.
- orchestrator should tighten ownership instructions.

## 17) Dispatch strategy
Default mode is `orchestrator-first`.
Workers spawn idle.
Orchestrator receives registry first.
Orchestrator decides first dispatch order.

Alternative mode is `worker-first`.
Backend dispatches worker prompts during creation.
This is useful for fast batch start.
This is weaker for orchestrator-driven sequencing.

## 18) Dispatch target semantics
Supported target forms:
- `all`.
- worker index.
- `worker:<name>`.
- worker session id.
- worker name fallback.

Dispatch can include `interrupt=true`.
Interrupt handling is transport-aware.
Codex native turns can be interrupted with app-server API when available.
PTY sessions use interrupt signal path.

## 19) Sync engine strategy
Sync is digest-based.
Sync should be non-interruptive by default.
Sync should avoid spamming orchestrator.

Digest includes:
- worker running state.
- attention count.
- preview line.
- event watermark.
- changed worker count.

Auto sync interval mode should skip delivery when:
- no meaningful change.
- orchestrator already has pending attention.
- min delivery gap not satisfied.

## 20) Approval model
All approvals flow through inbox routes.
Approval items are deduplicated by signature when possible.
Each approval response creates an event trail.
Dismiss action also creates an event trail.

Guarded-auto recommendation logic:
- allow low-risk read-only operations.
- allow clearly reversible formatting operations.
- deny destructive operations without explicit user signal.
- deny network-impact actions when policy unclear.

## 21) Edge scenarios and required behavior
Scenario 1: stale native session linking.
Requirement: never auto-link new app session to old unrelated native session id.
Mitigation: excluded id snapshot at spawn + cwd-aware linking.

Scenario 2: duplicated worker names.
Requirement: deterministic resolution.
Mitigation: creator build should normalize names.

Scenario 3: worker created without prompt.
Requirement: reject payload.
Mitigation: validation error on missing worker prompt.

Scenario 4: worker project path outside allowed roots.
Requirement: reject payload.
Mitigation: validateCwd on worker projectPath.

Scenario 5: orchestrator session starts but worker fails.
Requirement: rollback partially created sessions/worktrees.
Mitigation: create lock + reverse cleanup rollback path.

Scenario 6: cleanup while sync in flight.
Requirement: no double-mutating operation.
Mitigation: orchestration lock and operation owner tracking.

Scenario 7: too many idle tasks in inbox list.
Requirement: keep default task surfaces clean.
Mitigation: hide idle tasks by default; include with explicit flag.

Scenario 8: user wants raw terminal disabled.
Requirement: wrapper-only mode remains fully functional.
Mitigation: feature flag gate for terminal mode.

Scenario 9: dispatch to non-running worker.
Requirement: do not crash orchestration.
Mitigation: per-target failure capture and partial success response.

Scenario 10: rapid repeated dispatch spam.
Requirement: preserve server stability.
Mitigation: orchestrator should batch prompts and respect sync cadence.

Scenario 11: approval arrives during long worker run.
Requirement: quick triage path.
Mitigation: inbox priority and direct-open action target.

Scenario 12: orchestrator over-edits directly.
Requirement: maintain worker delegation model.
Mitigation: orchestrator system prompt hard rule.

Scenario 13: worker subagents explode output noise.
Requirement: preserve quality over volume.
Mitigation: maxWorkerSubagents clamp and anti-slop delivery contract.

Scenario 14: race in session state updates.
Requirement: no invalid event order assumptions.
Mitigation: UI sorts by timestamp and append sequence.

Scenario 15: digest delivery loops with no changes.
Requirement: avoid noisy loops.
Mitigation: unchanged hash skip and cooldown checks.

Scenario 16: branch cleanup failure.
Requirement: retry before giving up.
Mitigation: robust worktree removal with prune + retries.

Scenario 17: orchestration lock stale owner.
Requirement: avoid deadlock forever.
Mitigation: stale lock timeout and owner replacement.

Scenario 18: user uses manual workers in creator build.
Requirement: preserve custom tasks with strict validation.
Mitigation: manual worker list accepted and normalized.

Scenario 19: objective too broad.
Requirement: creator still returns measurable split.
Mitigation: role-specific prompts with verification contract.

Scenario 20: expensive orchestrator on small task.
Requirement: do not overspend by default.
Mitigation: budget-aware creator profile selection.

## 22) Anti-slop policy
No broad rewrites without explicit scope.
No duplicate utilities in parallel directories.
No speculative architecture changes without acceptance criteria.
No hidden side effects in unrelated modules.
Always include verification evidence.

## 23) Verification contract per worker completion
Worker completion report must include:
- exact files touched.
- commands run.
- test results or deterministic checks.
- known risks.
- explicit next step.

Orchestrator should reject incomplete reports.
Orchestrator should request rework if evidence is missing.

## 24) Orchestrator operating loop
Loop step 1: plan.
Loop step 2: dispatch.
Loop step 3: observe.
Loop step 4: evaluate blockers.
Loop step 5: replan or continue.
Loop step 6: integrate.
Loop step 7: summarize.

## 25) Creator operating loop
Loop step 1: parse objective.
Loop step 2: estimate complexity.
Loop step 3: choose worker count.
Loop step 4: assign tools and profiles.
Loop step 5: generate scoped prompts.
Loop step 6: emit orchestration payload.

## 26) Improver operating loop
Loop step 1: inspect recurring failures.
Loop step 2: identify vague command patterns.
Loop step 3: rewrite command definitions to be measurable.
Loop step 4: add rollback and escalation hints.
Loop step 5: validate with real traces.

## 27) API contract summary
Creator prompts endpoint:
- `GET /api/harness/prompts`.

Creator recommendation endpoint:
- `POST /api/harness/creator/recommend`.

Creator build endpoint:
- `POST /api/harness/creator/build`.

Create orchestration endpoint:
- `POST /api/orchestrations`.

Dispatch endpoint:
- `POST /api/orchestrations/:id/dispatch`.

Sync endpoint:
- `POST /api/orchestrations/:id/sync`.

Sync policy endpoint:
- `PATCH /api/orchestrations/:id/sync-policy`.

Cleanup endpoint:
- `POST /api/orchestrations/:id/cleanup`.

Inbox list endpoint:
- `GET /api/inbox`.

Inbox respond endpoint:
- `POST /api/inbox/:id/respond`.

## 28) WS events that matter to UI
Global events include:
- sessions changed.
- tasks changed.
- inbox changed.
- orchestrations changed.
- orchestration create progress.

Per-session events include:
- output chunks.
- input echoes.
- status changes.
- inbox response events.

## 29) UI implications
Inbox-first can be implemented safely because backend already tracks task and attention states.
Parent/child navigation is deterministic via task members and orchestration view.
Double-tap to pending target can use open-target endpoint.
Wrapper mode can stay default without losing control capabilities.
Terminal mode can be feature-gated with `/api/features`.

## 30) Security controls
Token auth for API calls.
Cookie upgrade flow for phone usage.
No implicit external network authorization in approval flow.
No hidden approval auto-accept in manual policy.

## 31) Reliability controls
Locking around orchestration mutations.
Retry logic for cleanup.
Event persistence for auditability.
State hydration for legacy tasks.
Transport-aware interrupt handling.

## 32) Observability controls
Digest hash and changed-worker counts are surfaced.
Session previews provide lightweight progress snapshots.
Attention counts are available per session and per task.
Orchestration lock state is visible in orchestration view.

## 33) Performance controls
Session list and tool-session parsing use bounded limits.
Workspace scans are capped.
Sync ticker uses interval and in-flight guards.
UI should request expanded history only on demand.

## 34) Failure recovery runbook
If orchestration create fails:
- rollback created sessions.
- rollback created worktrees.
- return structured error payload.

If dispatch fails partially:
- report sent and failed arrays.
- keep orchestration running.
- orchestrator replans around failed worker.

If cleanup fails partially:
- keep summary with failed counts.
- allow idempotent retry.

## 35) Demo-safe operating defaults
Use `orchestrator-first`.
Use wrapper mode as default UI mode.
Use `manual` or `guarded-auto` approval policy explicitly.
Use sync mode `manual` for noisy sessions.
Use interval sync only with sane cooldown values.

## 36) Testing strategy
Unit coverage should include:
- creator recommend behavior.
- creator build payload validity.
- orchestrator-first deferred worker prompts.
- dispatch target resolution.
- env sanitization.

Integration coverage should include:
- orchestration creation and cleanup.
- lock conflict behavior.
- sync digest generation and skip rules.

## 37) Definition of done for backend core
Done means:
- APIs validate payloads deterministically.
- orchestration can run without stale session linking.
- inbox actions route correctly.
- cleanup is idempotent.
- tests pass in full suite.
- docs are explicit enough for separate frontend agent implementation.

## 38) Practical create flow (recommended)
1. Call creator build endpoint with objective, projectPath, prefs, and behavior.
2. Review returned orchestrationSpec.
3. Submit orchestrationSpec to orchestration create endpoint.
4. Apply postCreate sync policy action.
5. Observe orchestrator and workers from inbox/task views.
6. Use dispatch endpoint for controlled follow-up prompts.
7. Cleanup when complete.

## 39) Example creator build request
```json
{
  "objective": "Understand workspace and fix backend bugs quickly with high reliability",
  "projectPath": "/home/user/repo",
  "prefs": {
    "budget": "balanced",
    "priority": "quality",
    "maxWorkers": 4,
    "allowWorkspaceScan": true
  },
  "behavior": {
    "coordinationStyle": "strict",
    "approvalPolicy": "guarded-auto",
    "interruptPolicy": "on-blocker",
    "enforceFileOwnership": true,
    "allowWorkerSubagents": true,
    "maxWorkerSubagents": 2,
    "sync": {
      "mode": "interval",
      "intervalMs": 120000,
      "deliverToOrchestrator": true,
      "minDeliveryGapMs": 45000
    }
  }
}
```

## 40) Example post-create sync policy patch
```json
{
  "mode": "interval",
  "intervalMs": 120000,
  "deliverToOrchestrator": true,
  "minDeliveryGapMs": 45000
}
```

## 41) What this enables immediately
A cheap or premium creator can generate deterministic orchestration plans.
A strong orchestrator can control specialist workers with explicit contracts.
Workers can use their own subagents inside bounded policy.
The user can stay mostly at orchestrator level and intervene only when needed.
The system scales to multi-project operation without flooding UI with random sessions.

## 42) Final guardrails
Do not reintroduce ambiguous prompts.
Do not let worker ownership drift silently.
Do not auto-approve destructive actions.
Do not couple UI behavior to undocumented assumptions.
Do not bypass lock and cleanup safety paths.

## 43) Short checklist for maintainers
- Validate objective and project path.
- Normalize behavior controls.
- Build explicit worker prompts.
- Build orchestrator system prompt with runtime controls.
- Keep dispatch mode intentional.
- Keep sync policy explicit.
- Keep tests green.
- Keep docs explicit.

## 44) External best-practice adoption loop
Use `docs/agent-command-library/25-agentic-implementation-critical-thinking-loop.md` as a process hardening baseline.

Minimum behavioral requirements:
- evidence-before-claims in every worker handoff;
- risk-tiered approval and escalation for medium/high risk actions;
- no-op/no-message discipline when workers are on-track;
- reproducibility pack for meaningful bugfix/regression work;
- security evidence for security-sensitive changes.

This is intentionally process-focused.
It targets implementation quality, dispatch quality, and review quality.

## 45) References
Codex non-interactive:
https://developers.openai.com/codex/noninteractive

Codex app-server:
https://developers.openai.com/codex/app-server

Claude Code docs:
https://docs.anthropic.com/en/docs/claude-code

Claude Code CLI reference:
https://docs.claude.com/en/docs/claude-code/cli-reference

OpenCode docs:
https://opencode.ai/docs

OpenCode SDK types:
https://raw.githubusercontent.com/sst/opencode/dev/packages/sdk/js/src/gen/types.gen.ts

# Maintainer Quick Map

This file is a compact map of the repo so contributors can find the right place fast.

## What This Project Is
- A phone-first web UI that controls local/remote CLI agents (`codex`, `claude`, `opencode`).
- A backend that manages sessions, orchestration, automation, and inbox/approval flows.
- A frontend wrapper that renders chat + tool execution details in mobile-friendly views.

## Core Code Areas
- `server/src/app.ts`
  - Main API surface and orchestration runtime.
  - Session create/input/interrupt/cleanup routes.
  - Orchestration create/dispatch/sync/automation/cleanup routes.
  - Worker/orchestrator directive parsing (`FYP_DISPATCH_JSON`, `FYP_SEND_TASK_JSON`, `FYP_ANSWER_QUESTION_JSON`).
- `server/src/orchestration_control.ts`
  - Shared parsing for orchestrator control directives.
  - Normalizes `forceInterrupt`/dispatch/question-answer packets.
- `server/src/orchestration_objective.ts`
  - Objective extraction and objective-to-worker-task injection helpers.
- `server/src/harness_command_schema.ts`
  - Per-command JSON-schema style payload contracts and strict validator used by command execution API.
- `server/src/harness_command_policy.ts`
  - Policy-as-code authorization gates by command risk tier (`low`/`medium`/`high`).
- `server/src/sessions/session_manager.ts`
  - PTY session lifecycle and IO plumbing for tool CLIs.
- `server/src/store.ts`
  - SQLite-backed persistence for sessions, tasks, events, inbox attention, orchestration records.
  - Includes persisted orchestration command idempotency replay cache (restart-safe command retries).
- `web/src/ui/App.tsx`
  - Main app state, page layout, orchestration/team creation UI, settings, inbox, polling.
- `web/src/ui/components/WrapperChatView.tsx`
  - Render pipeline for wrapper mode, tool-call metadata extraction, command cards.

## Orchestration Flow (High-Level)
1. `POST /api/orchestrations` creates orchestrator + worker sessions.
2. Worker startup bootstrap is sent and runtime docs are scaffolded under `.agents/` and `.fyp/`.
3. Orchestrator dispatches work with:
   - `FYP_DISPATCH_JSON` or
   - `FYP_SEND_TASK_JSON` (preferred for tasking workers).
4. Workers report progress via task files and may ask structured blocker questions.
5. Orchestrator answers via inbox response API or `FYP_ANSWER_QUESTION_JSON`.
6. Sync/automation endpoints provide status digests and steering hooks.

## Runtime Artifacts (Git-Ignored)
- `.agents/` (task cards, orchestration bootstrap docs, runtime contracts)
- `.fyp/` (worker task progress and runtime coordination state)
- `memory/` (local runtime/helper artifacts)
- `.fyp-worktrees-*` (auto-created per-worker worktrees)

These are intentionally local and should not be committed.

## Expert Command/Skill Library
- `docs/agent-command-library/README.md`
- `docs/agent-command-library/01-security-debug-pentest.md`
- `docs/agent-command-library/02-backend-reliability-resilience.md`
- `docs/agent-command-library/03-api-integration-contracts.md`
- `docs/agent-command-library/04-frontend-quality-accessibility.md`
- `docs/agent-command-library/05-orchestrator-expert-operations.md`
- `docs/agent-command-library/06-skill-crosswalk-security-orchestration.md`
- `docs/agent-command-library/07-skill-crosswalk-frontend-mobile.md`
- `docs/agent-command-library/08-command-automation-recipes.md`
- `docs/agent-command-library/09-sota-gap-matrix.md`
- `docs/agent-command-library/10-threat-modeling-and-sast-pipeline.md`
- `docs/agent-command-library/11-debug-hypothesis-lab.md`
- `docs/agent-command-library/12-testing-verification-review-gates.md`
- `docs/agent-command-library/13-auth-and-session-hardening.md`
- `docs/agent-command-library/14-error-handling-and-recovery-patterns.md`
- `docs/agent-command-library/15-team-communication-and-task-governance.md`
- `docs/agent-command-library/16-parallel-execution-and-conflict-arbitration.md`
- `docs/agent-command-library/17-release-readiness-rollback-incident.md`
- `docs/agent-command-library/18-frontend-platform-parity-motion.md`
- `docs/agent-command-library/19-observability-and-slo-ops.md`
- `docs/agent-command-library/20-expanded-command-reference.md`
- `docs/agent-command-library/21-deep-research-foundations.md`
- `docs/agent-command-library/22-sota-enforcement-loop.md`
- `docs/agent-command-library/23-live-skill-provenance-model.md`
- `docs/agent-command-library/24-manual-sota-review-2026-02-21.md`

These files are the long-form playbooks referenced by command IDs in orchestrator prompts.

## Useful Commands
- Install + start quickly:
  - `curl -fsSL https://raw.githubusercontent.com/testinganddeveloping1-ux/vibecodefromanywhere/main/quick-install.sh | bash -s -- --start`
- Dev:
  - `npm run dev`
- Typecheck:
  - `npm run typecheck`
- Targeted orchestration tests:
  - `npm run test -- server/test/orchestrations.test.ts`
  - `npm run test -- server/test/two_cli_communication_stability.test.ts`

## Editing Guidelines
- Keep orchestration changes backward-compatible with existing JSON directives.
- Prefer adding regression tests for any dispatch/sync/automation behavior change.
- Avoid broad formatting-only diffs in `server/src/app.ts`; keep changes scoped and test-backed.

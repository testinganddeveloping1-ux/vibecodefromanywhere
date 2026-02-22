# SOTA Enforcement Loop (Skills -> Commands -> Runtime)

This document defines the practical gap between "good docs" and a real state-of-the-art orchestration harness.

The short version:

- Static policy docs are necessary but insufficient.
- SOTA requires runtime-enforced contracts, observable coverage, and feedback loops.
- The harness now includes a real audit loop to tie local skills corpus coverage to executable command behavior.

## What Was Missing Before

Even with rich docs, three issues can still make systems drift:

1. **Static crosswalk drift**:
   - command docs can become disconnected from the actual installed skill corpus.
   - this causes "paper coverage" with no runtime signal.
2. **Weak payload discipline**:
   - free-form command payloads allow malformed inputs and inconsistent behavior.
   - this creates non-reproducible command effects.
3. **No measurable readiness loop**:
   - teams cannot quickly answer "which commands lack domain backing right now?"
   - this blocks targeted hardening.

## Runtime Additions (Implemented)

## 1) Skill-Corpus SOTA Audit Endpoint

- Route: `GET /api/harness/sota-audit`
- Scans real local skill roots:
  - `$CODEX_HOME/skills`
  - `~/.codex/skills`
- Reads discovered `SKILL.md` files.
- Scores each skill for operational quality:
  - trigger rules
  - workflow/checklist
  - verification expectations
  - safety guardrails
  - tooling/examples/fallback guidance
- Maps each harness command to required domains using a deterministic contract table (not only regex heuristics).
- Ranks supporting skills per command and computes a support score/confidence.
- Returns:
  - skill roots / missing roots
  - domain counts
  - domain quality averages
  - per-command coverage (covered/missing domains + supporting skills + support score + confidence)
  - uncovered command list
  - actionable recommendations

This closes the loop between real-day-to-day skill repos and harness command readiness.

## 2) Stricter Command Payload Validation

- Route: `POST /api/orchestrations/:id/commands/execute`
- Added per-command payload schema validation (JSON-schema style) for:
  - command-mode-specific allowed fields
  - command-specific required non-empty fields (`scope-lock.scope`, `verify-completion.verify`, etc.)
  - strict type checks, bounded text/list lengths, numeric ranges
- Invalid payloads now fail fast with:
  - `error: invalid_command_payload`
  - deterministic `reason`

This reduces orchestration ambiguity and makes command behavior more deterministic.

## Why This Is More SOTA

SOTA orchestration is not just "more prompt text." It is:

- **evidence-coupled**:
  - runtime can show what is actually covered.
- **contract-driven**:
  - malformed command envelopes are rejected early.
- **self-diagnosing**:
  - uncovered command domains are reported directly as recommendations.
- **confidence-aware**:
  - weakly-backed commands are flagged even when they technically pass minimal domain coverage.

## Next Hardening Steps

1. Add periodic auto-audit snapshots and trend tracking.
2. Add CI gate for uncovered/low-confidence critical commands (`coord-task`, `diag-evidence`, `verify-completion`).

Implemented status (current):

- Idempotency replay is now persisted in SQLite for restart-safe retries.
- Per-command JSON-schema style payload validation is enforced before execution.
- Policy-as-code gate is enforced by command risk tier (`low`, `medium`, `high`) with explicit high-risk authorization fields.
- Optional high-risk override is environment-gated (`FYP_HARNESS_POLICY_ALLOW_HIGH_RISK=1`) and still requires explicit `policyOverride=true`.

## Operational Rule

If coverage audit and command validation disagree with docs, **runtime truth wins** and docs must be updated.

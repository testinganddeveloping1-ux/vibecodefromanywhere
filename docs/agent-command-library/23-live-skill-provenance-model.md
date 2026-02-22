# Live Skill Provenance Model

This document explains how the harness now decides whether command behavior is genuinely backed by day-to-day skill repositories, not just by static prose.

## Why This Exists

A common failure mode in orchestration systems:

- command docs look complete,
- prompts are long,
- but runtime decisions still drift because there is no measurable link to real installed skills.

The provenance model closes that gap with runtime evidence.

## Runtime Inputs

- Skill corpus roots:
  - `$CODEX_HOME/skills`
  - `~/.codex/skills`
  - optional `roots` query override in `GET /api/harness/sota-audit`
- Skill files:
  - discovered `SKILL.md` files

## Scoring Model

Each discovered skill receives:

- `domain`: inferred from name/description/path
- `qualityScore` (0-10): based on operational signals:
  - trigger clarity
  - workflow/checklist structure
  - verification expectations
  - safety constraints
  - tooling/examples/fallback guidance

Each command receives:

- required domains from deterministic command-domain contract
- top supporting skills ranked by:
  - domain alignment
  - lexical relevance to command intent
  - skill quality score
- `supportScore` (0-100) and confidence tier (`high`/`medium`/`low`)

## Why This Is Better Than Prompt Inflation

- Deterministic domain contract avoids brittle regex-only behavior.
- Support ranking shows which real skills back each command.
- Confidence tiers highlight weak command backing before incidents happen.
- Recommendations become actionable (which domain/command to improve), not generic.

## Operational Usage

1. Call `GET /api/harness/sota-audit`.
2. Look at:
   - `uncoveredCommands`
   - low-confidence commands (`commandCoverage[].confidence === "low"`)
   - `domainQuality`
3. Improve only the missing or weak skills/commands.
4. Re-run audit and verify confidence improvements.

## Non-Goals

- It does not claim semantic perfection of every skill.
- It does not replace code-level tests or integration verification.
- It does not authorize risky behavior outside approved scope.

Use this model as a readiness meter, then enforce with verification gates (`verify-completion`, `review-hard`, `integration-gate`).

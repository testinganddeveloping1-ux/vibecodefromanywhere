# Agentic Implementation Critical-Thinking Loop

This document captures process-level best practices adapted from strong open-source agentic/debug/security projects, and turns them into enforceable behavior for this repository.

It targets implementation quality, not just code quality.

## External references used

- SWE-agent: https://github.com/SWE-agent/SWE-agent
- SWE-agent docs: https://swe-agent.com/latest/
- OpenHands: https://github.com/OpenHands/OpenHands
- Aider: https://github.com/Aider-AI/aider
- LangGraph overview: https://docs.langchain.com/oss/python/langgraph/overview
- Semgrep docs: https://semgrep.dev/docs/
- OpenSSF Scorecard: https://github.com/ossf/scorecard

## What we take from each source

### SWE-agent

- Reproducible execution with explicit config and documented flows.
- Strong expectation of deterministic, benchmark-style task execution.
- Clear separation between task definition and run execution.

### OpenHands

- Real software development workflow focus (issue to PR behavior).
- Emphasis on controlled runtime environments for reliability.
- Evaluation-oriented framing rather than ad-hoc subjective success.

### Aider

- Fast edit/test/iterate loop.
- Explicit integration with lint/test commands.
- Practical ergonomics for high-frequency coding cycles.

### LangGraph

- Durable orchestration model.
- Human-in-the-loop control points.
- Interruptibility and checkpoint-like flow control.

### Semgrep + Scorecard

- Policy-as-code security posture.
- CI-friendly security scanning baseline.
- Trackable, repeatable security hygiene signals.

## Process flaws to avoid (implementation-level)

1. Prompt-first without evidence-first
- Symptom: long instruction packets, weak verification artifacts.
- Fix: require repro pack + fresh verify output before status claims.

2. Ambiguous approval boundaries
- Symptom: auto-approve behavior on medium/high risk work.
- Fix: enforce LOW/MEDIUM/HIGH tiering with strict escalation rules.

3. Over-interrupting active workers
- Symptom: progress collapse due to unnecessary steering pings.
- Fix: explicit no-message/no-op policy when worker is on-track.

4. Completion claims without deterministic reruns
- Symptom: “looks fixed” but flaky or non-reproducible behavior.
- Fix: same command before/after, record signals, mark non-determinism as blocker.

5. Security posture treated as optional
- Symptom: auth/supply-chain/security changes merged with no security evidence.
- Fix: mandatory security scan evidence for security-sensitive surfaces.

6. Weak retrospective discipline
- Symptom: same orchestration failure patterns repeat.
- Fix: small recurring process review with tracked corrective actions.

## Repository adoption rules

These are now baseline operating rules:

- Evidence-before-claims: no completion statement without fresh command output.
- Repro pack required for meaningful bugfixes and regressions.
- Risk-tiered approval:
  - LOW: orchestrator may approve with evidence.
  - MEDIUM: evidence plus orchestrator review required.
  - HIGH: hard review plus explicit user confirmation.
- Security gate:
  - Run security checks for auth/security/dependency-sensitive changes.
  - Missing security evidence blocks high-risk integration.
- No-op discipline:
  - If worker is on-track and unblocked, do not interrupt.
- Continuous improvement:
  - Review one recent orchestration for process failures and update this guide.

## Standard loop (implementation operations)

1. Define objective and measurable done conditions.
2. Build scoped task packets with ownership boundaries.
3. Capture repro pack before patching.
4. Execute minimal scoped change.
5. Run deterministic verification commands.
6. Run security checks when risk surface requires.
7. Review with severity + evidence.
8. Integrate or rollback with explicit rationale.
9. Record process lessons and update rules when needed.

## Repro pack template

Use this exact shape:

```text
BASE_COMMIT:
REPRO_COMMAND:
EXPECTED_PRE_FIX_SIGNAL:
OBSERVED_PRE_FIX_SIGNAL:
PATCH_SCOPE:
VERIFY_COMMAND:
OBSERVED_POST_FIX_SIGNAL:
RUNTIME_VERSION:
TIMESTAMP:
```

## Risk log template

```text
RISK_TIER: LOW|MEDIUM|HIGH
BLAST_RADIUS:
SECURITY_SURFACE:
APPROVAL_REQUIRED:
ROLLBACK_PLAN:
```

## Review standard

- Findings ordered by severity first.
- Each finding tied to file/path and concrete evidence.
- Explicit residual risk section (what is still unknown).
- Explicit rollback condition for risky merges.

## Continuous improvement cadence

- Per meaningful orchestration: quick retrospective (5-10 minutes).
- Weekly: one deeper process audit against this document.
- Update only rules that improve measurable reliability or operator clarity.

## Non-goals

- This document is not a replacement for test coverage.
- This document is not an excuse for over-bureaucracy.
- This document does not require heavyweight tooling for low-risk edits.

# Backend Reliability + Resilience Playbook

This playbook is for:
- `backend-hardening`
- `perf-regression-lab`
- `data-integrity-audit`
- `dependency-risk-audit` (runtime stability angle)

## 1) Reliability Goals

Target properties:
- Deterministic behavior under retries/timeouts.
- No state corruption on partial failure.
- Bounded resource usage.
- Fast failure with clear error semantics.
- Safe recovery and rollback.

## 2) Triage Workflow

Use this loop:
1. Reproduce failure deterministically.
2. Define expected invariant.
3. Identify violating transition/path.
4. Patch minimal root cause.
5. Re-run targeted + broad checks.

Required status format:

```text
BUG:
ROOT:
FIX:
TEST:
RESULT:
```

## 3) Failure Modes to Check

- Retry storms due to missing backoff or wrong retry conditions.
- Timeout mismatches between caller/callee.
- Idempotency failures on duplicate requests.
- Transaction gaps causing partial writes.
- Race conditions in shared mutable state.
- Locking order deadlocks.
- Resource leaks (connections, handles, timers).
- Lost updates from concurrent writes.
- Incorrect rollback after partial success.
- Cleanup hooks skipped on exceptional paths.

## 4) Invariant-Centered Debugging

For each incident, write:
- Invariant statement.
- Violating event sequence.
- Scope of affected entities.
- Recovery strategy.

Examples:
- “Every accepted payment event has exactly one committed ledger record.”
- “Session state transitions are monotonic and validated per transition edge.”

## 5) Patch Patterns

Retries/timeouts:
- Retry only transient failures.
- Exponential backoff + jitter.
- Retry budget/circuit limits.
- End-to-end timeout envelope consistency.

Idempotency:
- Stable idempotency keys at boundary.
- Uniqueness constraints or dedupe stores.
- Exactly-once effect simulation for externally visible writes.

Concurrency:
- Minimize shared mutable state.
- Synchronize only critical section.
- Use transactional integrity for coupled writes.

Cleanup:
- Ensure cleanup in success + failure + cancellation paths.
- Add cleanup verification tests.

## 6) Data Integrity Audit

Audit areas:
- Referential integrity guarantees.
- Transaction isolation assumptions.
- Migration forward/backward safety.
- Replay/reconciliation behavior.

Data safety checklist:
- [ ] Invariants enumerated.
- [ ] Corruption scenarios tested.
- [ ] Recovery procedure validated.
- [ ] Manual repair tooling documented.

## 7) Performance Regression Lab

Process:
1. Establish baseline in representative workload.
2. Reproduce regression with same profile.
3. Isolate bottleneck (CPU, IO, lock contention, alloc pressure).
4. Apply narrow optimization.
5. Compare before/after with same harness.

Never claim perf win without:
- Measured delta.
- Test conditions.
- Confidence interval or repeated runs.

## 8) Verification Matrix

Run, at minimum:
- Targeted regression test for bug path.
- Cross-module integration subset.
- Broad suite for touched subsystem.

For critical paths:
- Add stress/concurrency run.
- Add failure-injection check.
- Add cancellation/interruption check.

## 9) Rollback Discipline

Define before merge:
- Rollback trigger.
- Rollback method.
- Validation of rollback state.

Common triggers:
- New failures outside scoped bug.
- Latency/throughput regression beyond threshold.
- Non-deterministic behavior across reruns.

## 10) Observability Requirements

Instrument:
- Correlation IDs across request path.
- Retry attempt counters.
- Timeout reason categories.
- State transition markers.
- Cleanup completion events.

Good evidence:
- concise logs with timestamps and IDs
- command outputs proving pass/fail deltas
- no “it should be fixed” assertions without trace

## 11) Handoff Contract

Deliver:
- Files changed.
- Invariant restored.
- Verification commands + key output lines.
- Known residual risks.
- Next safest follow-up if unresolved.

## 12) Open-Source Reference Set

Use these references for deeper reliability hardening:
- Google SRE Workbook (incident and reliability patterns)
- OpenTelemetry specs (trace/metric/log correlation)
- CNCF resiliency patterns (timeouts, retries, circuit breakers)
- PostgreSQL docs on transactions/isolation/locking for data-integrity audits

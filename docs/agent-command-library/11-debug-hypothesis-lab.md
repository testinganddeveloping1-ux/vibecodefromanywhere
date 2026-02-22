# Debug Hypothesis Lab

Use this for deep bug hunts where cause is uncertain and speculative fixes are dangerous.

## Source Skills

- `systematic-debugging`
- `debugging-strategies`
- `parallel-debugging`

## Command Links

- `diag-evidence`
- `flake-hunt`
- `resilience-chaos-check`
- `verify-completion`

## Core Rule

No patch before reproducible evidence.

## Hypothesis Cycle

1. Reproduce deterministically.
2. Capture evidence at each boundary.
3. List hypotheses (minimum 3 for complex issues).
4. Define disproof signal for each.
5. Test one change at a time.
6. Confirm root cause.
7. Patch minimally.
8. Verify targeted and broad behavior.

## Evidence Packet

```text
BUG:
REPRO_COMMAND:
EXPECTED_FAIL_SIGNAL:
OBSERVED_FAIL_SIGNAL:
TRACE_PATH:
HYPOTHESES:
DISPROOF_SIGNALS:
```

## Layered Instrumentation Map

- API boundary logs
- business logic checkpoints
- data store calls
- queue/pub-sub boundaries
- external dependency latency/failure markers

## Flake-Hunt Protocol

1. Isolate test/environment variables.
2. Repeat N runs with deterministic seed.
3. Capture failure frequency and patterns.
4. Identify timing/shared-state assumptions.
5. Stabilize test or implementation.

## Chaos/Interruption Protocol

Inject controlled faults for:

- network timeout
- process interruption
- partial write failure
- duplicate request replay

Validate:

- cleanup occurs
- retries are bounded
- state remains valid

## Anti-Patterns

- Try random fixes until green.
- Change multiple moving parts per iteration.
- Ignore intermittent failures as "CI noise."
- Claim root cause without disproof evidence.

## Bug Closure Format

```text
BUG:
ROOT:
FIX:
TEST:
RESULT:
ROLLBACK_TRIGGER:
```

## Debug Exit Criteria

- Repro is stable and documented.
- Root cause confirmed by disproof of alternatives.
- Fix is minimal and scoped.
- Regression coverage is added.
- Verification output is fresh.

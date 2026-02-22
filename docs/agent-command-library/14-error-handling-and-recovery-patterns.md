# Error Handling and Recovery Patterns

Define robust failure semantics and recovery behavior across services.

## Source Skills

- `error-handling-patterns`
- `backend-reliability-resilience` (library doc)

## Command Links

- `error-path-audit`
- `backend-hardening`
- `resilience-chaos-check`

## Principles

- Fail predictably.
- Preserve context.
- Avoid error swallowing.
- Clean up reliably.
- Degrade safely.

## Error Taxonomy

- user-input errors
- dependency/transient errors
- state/invariant errors
- security/policy errors
- unknown/system errors

Each category must map to:

- response semantics
- retry policy
- logging level
- alerting policy

## Retry Policy Rules

- retry only idempotent operations unless explicit safeguards exist
- exponential backoff with jitter
- bounded attempts
- deadline-aware cancellation

## Cleanup Contract

On failure or cancellation:

- release locks
- close handles
- rollback partial state
- emit completion/failure telemetry

## Observability Requirements

- correlation IDs
- error class and cause chain
- retry counts
- timeout reason
- cleanup success marker

## Testing Rules

- inject dependency failure
- inject timeout
- inject cancellation
- verify no state corruption
- verify retry bounds

## Anti-Patterns

- catch-all with silent continue
- logging the same error repeatedly at each layer
- returning generic success after partial failure

## Done Criteria

- error paths audited and documented
- failure-injection tests passing
- cleanup behavior verified
- telemetry sufficient for triage

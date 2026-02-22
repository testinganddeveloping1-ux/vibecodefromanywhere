# Parallel Execution and Conflict Arbitration

Run multiple workers safely without duplicate implementations or merge chaos.

## Source Skills

- `parallel-feature-development`
- `parallel-debugging`
- `multi-reviewer-patterns`

## Command Links

- `ownership-audit`
- `conflict-resolve`
- `integration-gate`
- `contract-drift-check`

## Parallelization Rules

- parallelize only independent scopes or contract-bounded scopes
- define interface contracts before coding in parallel
- assign authoritative owner for each shared boundary

## Conflict Detection

Detect early using:

- file overlap checks
- contract diff checks
- duplicate logic signatures
- conflicting test expectations

## Arbitration Protocol

1. Freeze conflicting workers.
2. Identify authoritative owner.
3. Preserve best evidence-backed implementation.
4. Reconcile integration tests.
5. Re-dispatch narrowed follow-up tasks.

## Integration Gate Checklist

- [ ] ownership map clean
- [ ] no unresolved contract drift
- [ ] regression tests green
- [ ] critical review findings resolved

## Multi-Reviewer Merge Standard

Before final merge, combine findings by dimensions:

- correctness
- reliability
- security
- performance
- accessibility (if UI touched)

## Anti-Patterns

- late conflict discovery near release
- two workers editing same contract without owner
- bypassing arbitration due time pressure

## Done Criteria

- conflicts resolved with explicit decisions
- shared contracts stable
- integration gate passes

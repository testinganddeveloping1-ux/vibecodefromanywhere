# Testing, Verification, and Review Gates

This is the quality spine for all implementation work.

## Source Skills

- `test-driven-development`
- `verification-before-completion`
- `requesting-code-review`
- `receiving-code-review`
- `multi-reviewer-patterns`
- `javascript-testing-patterns`

## Command Links

- `test-tdd`
- `verify-completion`
- `review-request`
- `review-hard`

## Gate Sequence

1. TDD gate (red -> green -> refactor)
2. Verification gate (fresh command output)
3. Review gate (severity-based remediation)
4. Final integration gate

## TDD Gate

Required artifacts:

- failing test output
- implementation diff
- passing test output
- edge-case tests

## Verification Gate

Completion claims must include:

- command executed
- exit status
- key output lines
- timestamp or run context

No completion claim is valid without this evidence.

## Review Gate Severity Policy

- Critical: must fix before merge
- High: must fix or explicitly approve risk
- Medium: fix when in scope; otherwise document
- Low: backlog allowed with owner

## Multi-Reviewer Dimensions

For high-risk changes, require at least two dimensions:

- correctness
- reliability
- security
- performance
- accessibility (UI work)

## Evidence Format

```text
GATE:
STATUS:
COMMANDS:
OUTPUT_SNIPPETS:
BLOCKERS:
NEXT_ACTION:
```

## Review Response Rules

- Restate feedback in your own words.
- Verify concern technically before coding.
- Accept/reject with evidence.
- Never blindly agree to unverified suggestions.

## Anti-Patterns

- "Looks good" without test/verify outputs.
- Running tests once early and reusing stale result.
- Treating review as optional for risky diffs.

## Final Ready Criteria

- All required gates passed.
- Open risk explicitly documented.
- No hidden blockers.

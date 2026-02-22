# API + Integration Contracts Playbook

This playbook is for:
- `contract-audit`
- `conflict-resolve`
- `scope-lock`
- `review-hard` on shared interfaces

## 1) Contract Ownership Model

Every shared contract must have:
- Canonical owner worker/team.
- Consumers list.
- Compatibility strategy.
- Migration path.

If ownership is ambiguous, orchestrator must assign one owner before edits proceed.

## 2) Contract Surfaces

- HTTP/REST response shapes and error codes.
- GraphQL schema and resolver behavior.
- Event payload schemas and ordering guarantees.
- Shared TypeScript types/interfaces.
- Queue/topic message contracts.
- CLI control-bus payload formats.

## 3) Drift Detection Workflow

1. Enumerate producer and all consumers.
2. Diff contract pre vs post change.
3. Identify breaking vs non-breaking deltas.
4. Validate consumers against new contract.
5. Approve only with evidence.

Use these artifacts:
- contract matrix table
- changed-field list
- compatibility notes
- migration steps

## 4) Backward Compatibility Rules

Prefer:
- additive fields over destructive replacement.
- deprecation windows over sudden removal.
- feature flags for risky transitions.

Breaking changes require:
- explicit migration plan
- consumer rollout order
- fallback/rollback strategy

## 5) Conflict Resolution Protocol

When two workers touch shared contracts:
- Freeze one path temporarily.
- Pick authoritative owner.
- Merge from single canonical contract definition.
- Re-test all affected consumers.

Conflict report template:

```text
CONFLICT_SURFACE:
WORKER_A_CHANGE:
WORKER_B_CHANGE:
AUTHORITATIVE_VERSION:
MERGE_PLAN:
VERIFY_CMDS:
```

## 6) Contract Test Strategy

Minimum:
- Producer contract tests.
- Consumer expectation tests.
- Integration tests for edge/error states.

Recommended:
- Schema snapshot tests for intentional deltas.
- Negative tests for invalid/missing fields.
- Versioned fixture tests.

## 7) Error Contract Discipline

Error behavior must be stable:
- predictable status/error code mapping
- consistent payload shape
- actionable error details without secret leakage

Never silently change:
- status code semantics
- required fields
- retriable vs non-retriable classification

## 8) Orchestrator Approval Gates

Approve contract changes only if:
- owner is explicit.
- all direct consumers checked.
- compatibility risk is documented.
- tests prove producer + consumer alignment.
- rollback path exists.

Reject when:
- “works on my side” evidence only.
- consumer impact unknown.
- migration order not defined.

## 9) Dispatch Prompts for Contract Work

Use explicit scope:
- shared schema files
- transport adapter files
- consumer parsing/validation locations

Include `NOT-YOUR-JOB` to prevent unrelated feature edits while resolving contracts.

## 10) Integration Handoff

Completion packet must include:
- contracts changed
- consumers validated
- migration notes
- test evidence
- remaining risk and owner

## 11) Open-Source Reference Set

Use these standards/tools for contract rigor:
- OpenAPI Specification (3.x) for HTTP contracts
- JSON Schema for payload validation
- GraphQL specification for schema behavior and compatibility rules
- Pact (consumer-driven contract testing)

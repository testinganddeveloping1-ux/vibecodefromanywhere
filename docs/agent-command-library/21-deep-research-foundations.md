# Deep Research Foundations for Harness Commands

This document captures external standards used to shape executable harness command behavior.

## Research Goals

- Ensure command execution is predictable and safe.
- Keep retries safe under unstable networks.
- Maintain clear evidence and auditability.
- Use defensive security and accessibility baselines.

## Key Standards and Sources

## 1) Idempotency and Retry Safety

- IETF HTTPAPI Idempotency-Key header draft:
  - `https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/`
- RFC 7231 HTTP method semantics and idempotency context:
  - `https://www.rfc-editor.org/rfc/rfc7231`
- Stripe idempotent request behavior as practical API pattern:
  - `https://docs.stripe.com/api/idempotent_requests`

Applied implications:

- Command execution endpoint accepts idempotency keys.
- Duplicate retries with same key replay cached response.
- Cache has bounded TTL and bounded size.

## 2) Command Payload Validation

- JSON Schema specification (draft 2020-12):
  - `https://json-schema.org/draft/2020-12`

Applied implications:

- Command payloads should have explicit required/optional fields.
- Arrays and enums should be normalized defensively.
- Unknown command IDs should fail with available options listed.

## 3) Security Engineering Baselines

- OWASP ASVS project:
  - `https://owasp.org/www-project-application-security-verification-standard/`
- NIST SSDF (Secure Software Development Framework):
  - `https://csrc.nist.gov/pubs/sp/800/218/final`

Applied implications:

- Threat and control mapping is required for security commands.
- Security fixes require explicit verification evidence.
- Risk acceptance and residual risk logging are first-class outputs.

## 4) Accessibility and UX Quality Baselines

- WCAG 2.2 Recommendation:
  - `https://www.w3.org/TR/WCAG22/`

Applied implications:

- Accessibility commands are enforced as quality gates.
- Touch target, focus, contrast, and reduced-motion checks are non-optional.

## Design Principles Derived from Research

1. Explicit command envelope with deterministic routing.
2. Idempotent retry behavior for command execution.
3. Separation of worker-dispatch commands and system commands.
4. Evidence-first completion with replayable audit trail.
5. Safety-by-default for security and accessibility-critical workflows.

## Current Implementation Hooks

- `GET /api/harness/commands`
- `POST /api/orchestrations/:id/commands/execute`
- idempotency key support in command execution endpoint
- command mode routing (`worker.send_task`, `worker.dispatch`, `system.sync`, `system.review`, `orchestrator.input`)

## Future Hardening

- Full JSON Schema validation per command family.
- Persistent idempotency storage (DB-backed) for process restart durability.
- Signed command receipts for stronger audit guarantees.
- Policy engine for per-command authorization rules.

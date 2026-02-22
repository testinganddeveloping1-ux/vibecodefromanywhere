# Auth and Session Hardening

This document defines hardened auth/session behavior for debug and normal modes.

## Source Skills

- `auth-implementation-patterns`
- `security-requirement-extraction`
- `threat-mitigation-mapping`

## Command Links

- `auth-hardening`
- `security-requirements`
- `mitigation-map`

## Hardening Scope

- credential handling
- token lifecycle
- session storage and invalidation
- authorization boundaries
- abuse protections

## Mandatory Invariants

- Passwords are never stored in plaintext.
- Session and refresh token rotation is enforced.
- Authorization checks are server-side and explicit.
- Token/session invalidation works across all active devices where policy requires.

## Token Policy Baseline

- short-lived access tokens
- bounded refresh lifespan
- replay detection or token family invalidation
- issuer/audience validation
- strict clock-skew handling policy

## Session Policy Baseline

- server-side revocation path
- session fixation prevention
- secure cookie attributes where applicable
- inactivity and absolute timeout policies

## Authorization Model Checks

- role/permission matrix defined
- default-deny for privileged routes
- cross-tenant access guards
- owner checks for mutable resources

## Abuse Resistance

- rate limits on auth endpoints
- lockout or progressive delay policy
- suspicious login telemetry and alerting
- brute-force detection

## Verification Matrix

- success path tests
- invalid token tests
- expired token tests
- revoked token tests
- missing permission tests
- cross-tenant denial tests

## Incident Hooks

Auth incidents require:

- impacted scope summary
- forced revocation procedure
- user communication path (if required)
- post-incident control upgrades

## Done Criteria

- invariants hold under tests
- threat-linked requirements implemented
- controls mapped and monitored
- residual risk documented

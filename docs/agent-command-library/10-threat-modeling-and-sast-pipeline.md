# Threat Modeling and SAST Pipeline (SOTA Baseline)

This document operationalizes threat modeling and SAST as a continuous gate, not a one-off checklist.

## Source Skills

- `stride-analysis-patterns`
- `attack-tree-construction`
- `security-requirement-extraction`
- `threat-mitigation-mapping`
- `sast-configuration`

## Command Links

- `threat-model-stride`
- `attack-tree-map`
- `security-requirements`
- `mitigation-map`
- `security-sast`

## Pipeline Overview

1. Model architecture and trust boundaries
2. Run STRIDE analysis
3. Build attack trees for top-risk flows
4. Extract concrete security requirements
5. Map requirements to controls and owners
6. Run SAST and triage findings
7. Validate mitigations with tests
8. Publish residual risk and next controls

## STRIDE Packet Template

```text
SYSTEM_BOUNDARIES:
ASSETS:
TRUST_ZONES:
SPOOFING:
TAMPERING:
REPUDIATION:
INFO_DISCLOSURE:
DENIAL_OF_SERVICE:
ELEVATION_OF_PRIVILEGE:
TOP_3_RISKS:
```

## Attack Tree Rules

- Root node must represent attacker objective.
- Use AND nodes for required preconditions.
- Use OR nodes for alternative paths.
- Annotate each leaf with effort, likelihood, and detectability.
- Map each leaf to at least one control.

## Security Requirement Quality Bar

Every requirement must be:

- threat-referenced
- testable
- owner-assigned
- measurable
- implementation-ready

Bad example:

- "Make auth secure"

Good example:

- "Reject refresh tokens older than 30 days, rotate on each use, and invalidate previous token family on replay detection."

## Control Mapping Standard

Each threat maps to:

- preventive controls
- detective controls
- corrective controls

Minimum mapping row:

```text
THREAT_ID | CONTROL_ID | CONTROL_TYPE | OWNER | TEST | STATUS | RESIDUAL_RISK
```

## SAST Integration Standard

Local and CI both required.

Local flow:

1. Run targeted scans in touched paths.
2. Triage true positives and false positives.
3. Add suppression only with explicit rationale.

CI flow:

1. Run full configured scan profile.
2. Fail on policy-level findings.
3. Publish SARIF or equivalent artifact.

## Triage Policy

### Priority 0

- exploitable auth bypass
- injection in privileged routes
- secret exposure path

### Priority 1

- data integrity compromise path
- high-likelihood denial path in critical services

### Priority 2+

- medium/low severity findings with compensating controls

## Required Verification Evidence

For each critical finding:

- before state proof
- mitigation diff
- after state proof
- regression test output

## Residual Risk Reporting

Report explicitly when:

- mitigation is partial
- control rollout is phased
- dependent component is pending

Format:

```text
RISK:
IMPACT:
TEMP_CONTROL:
PERM_CONTROL:
ETA:
OWNER:
```

## Common Failure Modes

- Threat model done but never linked to tests.
- SAST output ignored as "noise."
- Security requirement too vague to test.
- Control exists but no owner.
- No rollback plan for hardening changes.

## Definition of Done

- STRIDE model completed for scope.
- Attack tree built for top risks.
- Requirements extracted and testable.
- Controls mapped with ownership.
- SAST run and triaged.
- Critical findings remediated or risk-accepted with documented approval.

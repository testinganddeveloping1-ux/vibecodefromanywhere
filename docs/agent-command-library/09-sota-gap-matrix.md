# SOTA Gap Matrix and Adoption Plan

This matrix measures command/playbook maturity for orchestrator and worker operations.

## Scoring Model

Scale: 0 to 5

- 0: missing
- 1: ad-hoc
- 2: partial
- 3: solid baseline
- 4: strong and repeatable
- 5: best-in-class with automation and evidence traceability

## Dimensions

| Dimension | Current target | Why it matters |
|---|---:|---|
| Reproducibility discipline | 5 | Prevents speculative fixes |
| TDD enforcement | 5 | Reduces regression and ambiguity |
| Verification-before-completion | 5 | Stops false-done outcomes |
| Security threat-to-control traceability | 5 | Converts findings into durable controls |
| SAST CI integration | 4 | Early vulnerability detection |
| Task ownership and conflict control | 5 | Prevents multi-worker drift |
| Orchestrator decision quality | 5 | Core reliability of autonomous loop |
| Frontend/mobile accessibility quality gate | 5 | Prevents UI regressions and compliance misses |
| Cross-platform responsiveness discipline | 4 | Required for wrapper/mobile UX consistency |
| Evidence-rich handoff quality | 5 | Session continuity and trust |

## Policy Requirements per Score

### To claim 4+

- Standard command packets in use
- All high-risk work includes verify outputs
- Worker reports include BUG/ROOT/FIX/TEST/RESULT where applicable
- Ownership boundaries explicit in dispatches

### To claim 5

- Command-level automation recipes are used consistently
- No completion claim without machine-verifiable evidence
- Security controls mapped from threat model and tested
- Review and rollback gates are enforced for high-risk changes

## Maturity Checklists

## A) Debug/Backend Track

- [ ] Deterministic repro packet exists before fix
- [ ] TDD fail-before-fix evidence captured
- [ ] Verification gate passed with fresh output
- [ ] Multi-dimension review completed
- [ ] Rollback trigger defined and validated

## B) Security Track

- [ ] STRIDE/attack-tree context captured
- [ ] Security requirements extracted and testable
- [ ] Control mapping covers preventive/detective/corrective
- [ ] SAST run in CI and local validation path
- [ ] Residual risk documented

## C) Frontend/Mobile Track

- [ ] Mobile-first responsive checks passed
- [ ] WCAG hard checks passed
- [ ] Touch target and focus behavior validated
- [ ] Reduced-motion behavior validated
- [ ] Interaction reliability states validated

## D) Orchestrator Track

- [ ] Task packets are structured and scoped
- [ ] Question handling is blocker-first and concise
- [ ] No interrupt storms; no-op discipline followed
- [ ] Conflicts resolved with explicit ownership
- [ ] Final summary includes evidence and pending risks

## 30-Day Adoption Plan

### Week 1

- Roll out command packets (`diag-evidence`, `coord-task`, `verify-completion`).
- Train workers on mandatory report formats.

### Week 2

- Enforce TDD and review-request gates on debug mode.
- Add SAST gate to security-sensitive paths.

### Week 3

- Enforce frontend accessibility hard-gate on all UI tasks.
- Add responsive evidence snapshots/checks.

### Week 4

- Audit adherence and score each dimension.
- Close highest-impact gaps and update policy docs.

## Quarterly Review Template

```text
PERIOD:
SCORECARD:
TOP FAILURES:
ROOT CAUSES:
POLICY UPDATES:
AUTOMATION UPDATES:
NEXT QUARTER TARGETS:
```

## Related Documents

- `06-skill-crosswalk-security-orchestration.md`
- `07-skill-crosswalk-frontend-mobile.md`
- `08-command-automation-recipes.md`

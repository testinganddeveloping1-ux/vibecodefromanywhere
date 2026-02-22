# Skill Crosswalk: Frontend, Responsive, Mobile, and Accessibility

This document turns UI-related skills into enforceable quality gates for workers and orchestrators.

## Sources Audited (full read)

- `/home/archu/.codex/skills/anthropics-skills/skills/frontend-design/SKILL.md`
- `/home/archu/.codex/skills/wshobson-agents/plugins/ui-design/skills/responsive-design/SKILL.md`
- `/home/archu/.codex/skills/wshobson-agents/plugins/ui-design/skills/mobile-android-design/SKILL.md`
- `/home/archu/.codex/skills/wshobson-agents/plugins/ui-design/skills/mobile-ios-design/SKILL.md`
- `/home/archu/.codex/skills/wshobson-agents/plugins/ui-design/skills/accessibility-compliance/SKILL.md`
- `/home/archu/.codex/skills/wshobson-agents/plugins/accessibility-compliance/skills/wcag-audit-patterns/SKILL.md`
- `/home/archu/.codex/skills/wshobson-agents/plugins/ui-design/skills/interaction-design/SKILL.md`
- `/home/archu/.codex/skills/wshobson-agents/plugins/ui-design/skills/visual-design-foundations/SKILL.md`

## SOTA UX Pipeline

1. Define visual direction (purpose, audience, tone, differentiator)
2. Build mobile-first layout and component structure
3. Apply platform-specific patterns (Android/iOS/web)
4. Implement accessibility semantics and keyboard/touch behavior
5. Add purposeful interactions and loading/feedback states
6. Verify responsiveness, accessibility, and interaction reliability
7. Ship only after hard-gate checks pass

## Unified Frontend Hard Gate

### A) Visual Direction Gate

- No generic style output.
- Typography, palette, spacing, and motion reflect explicit design intent.
- Document why this UI is distinguishable from default boilerplate.

### B) Responsive Gate

- Mobile-first base implementation.
- Fluid scales using `clamp` and container-aware behavior.
- Breakpoints based on content constraints, not arbitrary device lists.
- Overflow behavior is intentional and tested.

### C) Platform Gate

- Android flows respect Material 3 patterns and touch ergonomics.
- iOS flows respect HIG principles and safe-area/navigation conventions.
- Shared web wrappers preserve consistency without flattening platform identity.

### D) Accessibility Gate

- WCAG 2.2 AA checks enforced.
- Semantic structure and ARIA where needed.
- Keyboard navigation and focus order validated.
- Touch targets never below 44x44; prefer platform-native larger sizes.
- Motion respects reduced-motion preferences.

### E) Interaction Reliability Gate

- Every critical action has loading/success/error states.
- Feedback is immediate and understandable.
- Animations are purposeful and performant (`transform`/`opacity` first).

## Cross-Skill Reconciliation Rules

### 1) Distinctive design vs safe defaults

`frontend-design` pushes uniqueness; `visual-design-foundations` emphasizes safe readable systems.

Policy:

- Use expressive display style where context allows.
- Keep body text and UI controls legible and tested.
- If a stylistic choice hurts readability/accessibility, accessibility wins.

### 2) Touch target discrepancy

- WCAG minimum is 44x44 CSS px.
- Android patterns often push 48dp.
- iOS controls commonly need equivalent ergonomic size.

Policy:

- Default target size is 48x48 where possible.
- Absolute minimum remains 44x44 for compliance.

### 3) Motion vs accessibility

- `interaction-design` encourages motion feedback.
- Accessibility requires reduced-motion support.

Policy:

- Build animation and reduced-motion variant together.
- Never ship animation-only state communication.

## Command Crosswalk for UI Work

| Command | Purpose |
|---|---|
| `frontend-pass` | Visual and interaction polish against explicit acceptance goals |
| `accessibility-hard-check` | WCAG-based semantic, keyboard, contrast, and screen-reader verification |
| `review-hard` | Final multi-dimension quality gate (UX + regressions + accessibility evidence) |

## Worker Dispatch Templates

### Frontend implementation packet

```text
TASK: Implement <screen/component> with mobile-first responsive behavior and explicit visual direction.
SCOPE: <exact files/dirs>
NOT-YOUR-JOB: backend changes, unrelated refactors
DONE-WHEN: responsive + interaction + a11y checks documented with evidence
VERIFY: <component tests>; <a11y checks>; <responsive checks>
PRIORITY: HIGH
```

### Frontend accessibility pass packet

```text
TASK: Run hard accessibility pass and remediate violations for <surface>.
SCOPE: <exact files/dirs>
NOT-YOUR-JOB: visual redesign outside listed surface
DONE-WHEN: no blocking WCAG violations remain and fixes are verified
VERIFY: <axe/lighthouse/manual keyboard/screen reader checks>
PRIORITY: HIGH
```

## QA Matrix (must include evidence)

| Dimension | Required checks |
|---|---|
| Responsive | Phone portrait, phone landscape, tablet, desktop, overflow behavior |
| Accessibility | Keyboard, focus indicators, semantics, labels, contrast, reduced motion |
| Interaction | Loading/success/error states, disabled states, retry/undo where relevant |
| Performance | Avoid layout thrashing, excessive re-rendering, heavy paint animations |

## Mobile-Specific Checklist

- [ ] Safe-area respected.
- [ ] Gesture and tap behavior consistent with platform norms.
- [ ] Navigation structure matches platform conventions.
- [ ] Dynamic text/font scaling tested.
- [ ] Light/dark and dynamic theming checked.
- [ ] Screen reader labels are meaningful and complete.

## Accessibility Audit Packet Format

```text
SURFACE:
CHECKS_RUN:
VIOLATIONS_FOUND:
FIXES_APPLIED:
REMAINING_RISK:
EVIDENCE:
```

## Integration with Existing Playbooks

Use this crosswalk with:

- `04-frontend-quality-accessibility.md`
- `05-orchestrator-expert-operations.md`

If conflicts arise, prioritize:

1. Accessibility and correctness
2. Interaction reliability
3. Responsive behavior
4. Visual distinctiveness

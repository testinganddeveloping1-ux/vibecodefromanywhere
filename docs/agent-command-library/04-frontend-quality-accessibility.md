# Frontend Quality + Accessibility Playbook

This playbook is for:
- `frontend-pass`
- `accessibility-hard-check`
- `review-hard` for UI surfaces

## 1) Quality Priorities

Ship UI that is:
- understandable
- keyboard operable
- readable on mobile/desktop
- resilient to loading/error/empty states
- visually coherent under real content lengths

## 2) Responsive First Checklist

- [ ] Small viewport (phone portrait) is primary reference.
- [ ] Medium viewport (tablet/small laptop) validated.
- [ ] No clipped text/buttons at common breakpoints.
- [ ] Overflow behavior intentional (wrap/scroll/truncate).
- [ ] Touch targets meet practical size.

## 3) Accessibility Hard Checks

Keyboard:
- Tab order matches visual order.
- Focus states visible.
- No keyboard traps.

Semantics:
- Correct heading hierarchy.
- Buttons are buttons, links are links.
- Form labels are explicit.

Screen reader:
- Meaningful control names.
- Status updates are announced when needed.
- Icon-only controls include accessible labels.

Color/contrast:
- Text contrast meets policy threshold.
- Error/success is not color-only.

## 4) Interaction Reliability

Every critical flow needs:
- loading state
- success state
- recoverable error state
- retry path where applicable

Avoid:
- silent failures
- dead buttons
- optimistic UI with no rollback handling

## 5) Regression Strategy

For changed components:
- targeted component tests
- integration flow check
- manual keyboard pass
- viewport sanity snapshots (small + medium)

When animations exist:
- verify reduced-motion behavior
- ensure interaction still works without timing assumptions

## 6) UX Defect Taxonomy

Track defects as:
- functional break (cannot complete task)
- accessibility break (assistive/keyboard failure)
- responsive break (layout unusable on viewport)
- clarity break (ambiguous label/flow)
- polish break (visual inconsistency)

Prioritize in that order.

## 7) Dispatch Contract for Frontend Workers

Include:
- exact screens/components in scope
- non-goals (no backend/refactor drift)
- acceptance checks (keyboard + viewport + error states)
- verify commands/tests

## 8) Orchestrator Review Criteria

Approve frontend change only with:
- scope alignment
- proof of keyboard/semantic checks
- mobile viewport confirmation
- no regressions in neighboring screens

Reject when:
- visual-only “looks fine” claim without interaction evidence
- inaccessible fallback states
- uncontrolled layout overflow

## 9) Handoff Format

```text
SCREENS_CHANGED:
KEY_INTERACTIONS_VALIDATED:
A11Y_CHECKS:
RESPONSIVE_CHECKS:
TEST_EVIDENCE:
RESIDUAL_RISK:
```

## 10) Open-Source Reference Set

Use these baseline references for UI quality and accessibility:
- W3C WCAG 2.2
- WAI-ARIA Authoring Practices Guide (APG)
- MDN accessibility and semantic HTML guidance
- axe-core ruleset references for automated accessibility checks

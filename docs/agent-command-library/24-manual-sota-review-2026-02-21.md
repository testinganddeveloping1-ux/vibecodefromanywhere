# Manual SOTA Review — 2026-02-21

This review was executed manually (not scheduled automation), then code was updated from findings.

## Manual Audit Run

Command used:

```bash
npx tsx -e "import {buildHarnessSotaAudit, defaultCommandCatalog} from './server/src/harness.ts'; const a=buildHarnessSotaAudit({commandCatalog: defaultCommandCatalog(), sampleSize: 30}); const low=a.commandCoverage.filter(c=>c.confidence==='low').map(c=>c.commandId); const med=a.commandCoverage.filter(c=>c.confidence==='medium').map(c=>c.commandId); console.log(JSON.stringify({generatedAt:a.generatedAt, skillCount:a.skillCount, averageSkillQuality:a.averageSkillQuality, skillsByDomain:a.skillsByDomain, domainQuality:a.domainQuality, uncoveredCommands:a.uncoveredCommands, lowConfidenceCommands:low, mediumConfidenceCount:med.length, recommendations:a.recommendations.slice(0,10)},null,2));"
```

## Findings

Initial manual pass exposed a classification flaw:

- Accessibility skills were being incorrectly classified as testing because `inferSkillDomain` checked generic testing terms before accessibility terms.
- This produced false command coverage gaps for:
  - `frontend-pass`
  - `accessibility-hard-check`
  - `motion-reduced-check`
  - `design-parity-matrix`

## Fix Applied

- Reordered domain inference precedence in `server/src/harness.ts`:
  - accessibility detection now runs before generic testing.
  - observability/orchestration/reliability/mobile/frontend/debugging/testing order improved to reduce false positives.

## Post-Fix Manual Audit Result

- `skillCount`: `237`
- `averageSkillQuality`: `5.72`
- `uncoveredCommands`: `[]`
- `lowConfidenceCommands`: `[]`
- `mediumConfidenceCount`: `0`
- Recommendation:
  - `All commands have at least one discovered skill backing each required domain contract.`

## Usability Fixes Applied During Review

- Improved API error rendering so policy/schema failures include concrete unmet fields in UI (`web/src/ui/lib/api.ts`).
- Added client-side prechecks in command deck for policy fields (prevents needless failed round trips for high-risk commands) (`web/src/ui/components/OrchestrationCommandPanel.tsx`).

## Intent Alignment

This review was done manually first, then code changes were made from actual findings. No periodic auto-snapshot scheduler was added in this pass.

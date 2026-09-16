# ADR 0271: Settings usage statistics destination (amends D335 / ADR 0173)

- Status: Superseded (2026-09-16) — D335 / ADR 0173 stands
- Related: D331, D335, ADR 0171, ADR 0173

## Context

ADR 0173 removed the Settings usage destination in favor of the
`pi.token-insights` plugin. A branch series then reintroduced a first-party
host-scope usage view here.

## Decision

Superseded. The maintainer's call on the upstream proposal keeps the boundary
where ADR 0173 put it: the cross-session dashboard is plugin-owned, and Settings
ships no `usage` destination and reserves no group for one. The host-owned
aggregation the page was built on (`stats.summary` / `stats.topSessions`) is
kept on the Core surface.

## Consequences

- `apps/desktop/src/components/settings/StatsPage.tsx` and the `stats.*` copy in
  the locale bundles are retained, but nothing routes to them, so a plugin can
  reuse the page without a re-translate pass.
- `token-usage-settings.test.mjs` guards both directions: it fails if the
  destination creeps back into the rail, and it fails if the retained component
  or its RPCs are deleted as dead code.
- `scripts/e2e-stats.mjs` reports SKIPPED with a stated reason instead of
  asserting against whichever settings tab happens to be active.
- The workspace index destination lands in the existing `Workspace` group rather
  than in a group of its own.

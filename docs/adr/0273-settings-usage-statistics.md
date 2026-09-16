# ADR 0273: Settings usage statistics destination (amends D335 / ADR 0173)

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

- The Settings page component was removed entirely; what stays on the Core
  surface is the stats RPC (`stats.summary` / `stats.topSessions`), its shared
  types, and the locale-agnostic host tests. A plugin (e.g. `pi.token-insights`)
  ships its own UI and cannot import app internals.
- `token-usage-settings.test.mjs` keeps guarding the rail: it fails if the
  `usage` destination creeps back into Settings.
- The workspace index destination lands in the existing `Workspace` group rather
  than in a group of its own.

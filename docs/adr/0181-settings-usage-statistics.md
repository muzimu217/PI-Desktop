# ADR 0181: Settings usage statistics destination (amends D335 / ADR 0173)

- Status: Accepted (fork decision, 2026-09-14)
- Related: D331, D335, ADR 0171, ADR 0173

## Context

ADR 0173 removed the Settings usage destination in favor of the
`pi.token-insights` plugin. The Data & Statistics settings group (this
branch series) reintroduces a first-party usage view.

## Decision

1. Settings gains a `usage` destination inside the new `Data & Statistics`
   group, backed by `stats.summary` / `stats.topSessions` (host-owned
   aggregation of completed turns; no new write path).
2. `pi.token-insights` remains the cross-tool dashboard (PI-Desktop +
   Claude Code + Codex + OpenCode); the Settings page is the host-scope view.
3. `stats.getTokenUsageHistory` is unchanged and stays available.

## Consequences

- `token-usage-settings.test.mjs` now asserts the destination exists
  (amending the earlier no-usage contract).
- The plugin continues to fold host remainders per ADR 0173; both surfaces
  read the same durable turns data.

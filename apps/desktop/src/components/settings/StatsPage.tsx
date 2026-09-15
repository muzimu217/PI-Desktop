import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectRecord, StatsSummary, StatsTopSession } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Button, Select, cx } from "../ui";
import { IconBarChart, IconClock, IconFlame, IconRefresh, IconTrendUp } from "../icons";
import { MetricTile } from "./MetricTile";
import { buildStatsDataset, buildTrend, sliceRecent } from "./stats/dataset";
import { Donut } from "./stats/Donut";
import { download } from "./stats/export";
import { formatDuration, formatLastActive, formatTokens } from "./stats/format";
import { Heatmap } from "./stats/Heatmap";
import { ProjectUsage } from "./stats/ProjectUsage";
import { Trend } from "./stats/Trend";
import { GRANULARITIES, type Granularity, type Range } from "./stats/types";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; code: string | null }
  | { kind: "ready"; summary: StatsSummary; sessions: StatsTopSession[] };

export function StatsPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language ?? "";
  const selectSession = useAppStore((state) => state.selectSession);
  // Same entry the settings rail's back-to-app button uses (SettingsPage's
  // `data-nav="back-to-app"` control calls setPage("chat")), so the empty
  // state's CTA lands the user on the work view with the nav stack recorded.
  const setPage = useAppStore((state) => state.setPage);
  const [range, setRange] = useState<Range>(30);
  // Activity-card granularity (daily grid / weekly bars / cumulative area).
  const [granularity, setGranularity] = useState<Granularity>("daily");
  // The trend switch is scoped to the trend chart only; it defaults to — and
  // re-follows — the global toolbar range whenever that changes.
  const [trendRange, setTrendRange] = useState<Range>(30);
  const [projectId, setProjectId] = useState<number | undefined>(undefined);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const load = useCallback(async (days: Range, project?: number, force?: boolean) => {
    setState({ kind: "loading" });
    try {
      const [summary, top] = await Promise.all([
        api.statsSummary(days, project, { force }),
        api.statsTopSessions(days, project),
      ]);
      setState({ kind: "ready", summary, sessions: top.sessions ?? [] });
    } catch (error) {
      // `invoke` (lib/api.ts) attaches the host error code; HOST_UNAVAILABLE
      // means the transport is gone and the honest message is "retry", while
      // anything else is a data failure the user cannot fix by waiting.
      const code = (error as { code?: unknown } | null)?.code;
      setState({ kind: "error", code: typeof code === "string" ? code : null });
    }
  }, []);

  // The filter list comes from the project registry, not from summary.projectUsage:
  // the summary is already narrowed to the active scope, so sourcing options from
  // it would collapse the dropdown to the single selected project.
  useEffect(() => {
    let active = true;
    void api
      .listProjects()
      .then((result) => {
        if (active) setProjects(result.projects ?? []);
      })
      .catch(() => {
        if (active) setProjects([]);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    void load(range, projectId);
  }, [load, range, projectId]);

  useEffect(() => {
    setTrendRange(range);
  }, [range]);

  const dataset = useMemo(
    () => (state.kind === "ready" ? buildStatsDataset(state.summary, state.sessions) : null),
    [state],
  );

  if (state.kind === "loading") {
    // Spec §2.2: the four metric cards hold `--` placeholders while the
    // aggregate computes, so the page frame never pops in from nothing.
    return (
      <div className="settings-stack" role="status" aria-label={t("stats.loading")}>
        <div className="stats-cards">
          {[t("stats.totalTokens"), t("stats.peakDay"), t("stats.longestChat"), t("stats.currentStreak")].map(
            (label) => (
              <MetricTile key={label} icon={null} label={label} value="--" />
            ),
          )}
        </div>
        {/* Two stacked notes: what is happening, then the privacy answer the
            audit found missing from the loading posture. */}
        <div className="stats-loading-notes">
          <span className="idx-state">{t("stats.loading")}</span>
          <span className="idx-state">{t("stats.loadingPrivacy")}</span>
        </div>
      </div>
    );
  }
  if (state.kind === "error") {
    const hostDown = state.code === "HOST_UNAVAILABLE";
    return (
      <div className="settings-stack">
        <div className="settings-panel">
          <div className="settings-row">
            <div className="settings-row-copy">
              <div className="settings-row-title">
                {hostDown ? t("stats.loadErrorHost") : t("stats.loadError")}
              </div>
            </div>
            <div className="settings-row-control">
              <Button onClick={() => void load(range, projectId, true)}>{t("index.retry")}</Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const { summary, sessions } = state;
  if (!dataset) return null;
  // Page-level empty state: zero completed conversations in the scoped range
  // means every chart below would render as all-zero chrome. This replaces the
  // whole page; the quieter per-card "no sessions in this range" row stays for
  // the filtered-but-nonempty case (turnCount > 0, sessions list empty).
  if (summary.cards.turnCount === 0) {
    return (
      <div className="settings-stack">
        <section className="settings-card-block">
          <div className="settings-panel">
            <div className="stats-empty">
              <h3 className="stats-empty-title">{t("stats.emptyTitle")}</h3>
              <p className="stats-empty-desc">{t("stats.emptyDesc")}</p>
              <Button onClick={() => setPage("chat")}>{t("stats.emptyAction")}</Button>
            </div>
          </div>
        </section>
      </div>
    );
  }
  const { cards, diagnostics, heatmap, models, aria } = dataset;
  // The trend card re-derives its chart from the same per-model rows sliced to
  // its own 7/30-day window — no second RPC, no host involvement.
  const trend = buildTrend(sliceRecent(trendRange, dataset.dailyByModel));
  const slicePeak = trend.totals.reduce<{ date: string; tokens: number }>(
    (best, value, index) =>
      value > best.tokens ? { date: trend.dates[index] ?? "", tokens: value } : best,
    { date: "", tokens: 0 },
  );
  // The charts' aria summaries need formatted numbers; the dataset keeps raw
  // values, so formatting happens here (the consumer) at render time.
  const heatAria = {
    days: aria.heatmap.days,
    tokens: formatTokens(aria.heatmap.totalTokens),
    peakTokens: formatTokens(aria.heatmap.peakTokens),
    peakDate: aria.heatmap.peakDate ?? "—",
  };
  const trendAria = {
    days: trendRange,
    tokens: formatTokens(trend.totals.reduce((sum, value) => sum + value, 0)),
    peakTokens: formatTokens(trend.peak),
    peakDate: slicePeak.date || "—",
  };

  return (
    <div className="settings-stack stats-scope">
      <p className="stats-subtitle">{t("stats.provenanceShort")}</p>
      <div className="stats-toolbar">
        <div className="settings-segment" role="group" aria-label={t("stats.range")}>
          {([7, 30] as const).map((days) => (
            <button
              key={days}
              type="button"
              className={cx("settings-segment-item", range === days && "active")}
              aria-pressed={range === days}
              onClick={() => setRange(days)}
            >
              {t(days === 7 ? "stats.range7" : "stats.range30")}
            </button>
          ))}
        </div>
        {projects.length > 0 ? (
          <Select
            className="stats-project-filter"
            aria-label={t("stats.projectFilter")}
            value={projectId === undefined ? "" : String(projectId)}
            onChange={(event) =>
              setProjectId(event.target.value === "" ? undefined : Number(event.target.value))
            }
          >
            <option value="">{t("stats.allProjects")}</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </Select>
        ) : null}
        <Button
          variant="ghost"
          aria-label={t("stats.refresh")}
          onClick={() => void load(range, projectId, true)}
        >
          <IconRefresh size={14} />
        </Button>
        <Button variant="ghost" onClick={() => download(dataset, summary, sessions, "csv")}>
          {t("stats.exportCsv")}
        </Button>
        <Button variant="ghost" onClick={() => download(dataset, summary, sessions, "json")}>
          {t("stats.exportJson")}
        </Button>
      </div>

      <div className="stats-cards">
        <MetricTile
          icon={<IconBarChart size={14} />}
          tone="accent"
          label={t("stats.totalTokens")}
          value={formatTokens(cards.totalTokens)}
          caption={t("stats.inclSubagents")}
        />
        <MetricTile
          icon={<IconTrendUp size={14} />}
          tone="accent"
          label={t("stats.peakDay")}
          value={formatTokens(cards.peakDayTokens)}
          // The mockup labels the peak value with the day it happened on.
          caption={dataset?.peakDay.date ?? undefined}
          badge={cards.peakDayTokens > 0 ? <span className="idx-badge idx-badge-warn">{t("stats.badgeHighest")}</span> : undefined}
        />
        <MetricTile
          icon={<IconClock size={14} />}
          tone="accent"
          label={t("stats.longestChat")}
          value={formatDuration(cards.longestChatMs)}
          caption={t("stats.pureChat")}
          badge={cards.longestChatMs > 0 ? <span className="idx-badge">{t("stats.badgeRecord")}</span> : undefined}
        />
        <MetricTile
          icon={<IconFlame size={14} />}
          tone={cards.currentStreakDays > 0 ? "success" : "accent"}
          label={t("stats.currentStreak")}
          value={t("stats.days", { count: cards.currentStreakDays })}
          caption={t("stats.longestStreak", { count: cards.longestStreakDays })}
          badge={cards.currentStreakDays > 0 ? <span className="idx-badge idx-badge-ok">{t("stats.badgeOnTrack")}</span> : undefined}
        />
      </div>

      <div className="stats-pair">
        <section className="settings-card-block">
          <div className="settings-panel stats-chart-panel">
            <div className="stats-card-head">
              <h3 className="settings-card-heading">{t("stats.activity")}</h3>
              <div className="settings-segment" role="group" aria-label={t("stats.activity")}>
                {GRANULARITIES.map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={cx("settings-segment-item", granularity === mode && "active")}
                    aria-pressed={granularity === mode}
                    onClick={() => setGranularity(mode)}
                  >
                    {mode === "daily"
                      ? t("stats.granularityDaily")
                      : mode === "weekly"
                        ? t("stats.granularityWeekly")
                        : t("stats.granularityCumulative")}
                  </button>
                ))}
              </div>
            </div>
            <Heatmap heatmap={heatmap} granularity={granularity} ariaSummary={heatAria} />
          </div>
        </section>
        <section className="settings-card-block">
          <div className="settings-panel stats-chart-panel">
            <h3 className="settings-card-heading">{t("stats.modelUsage")}</h3>
            <Donut models={models} />
          </div>
        </section>
      </div>

      <div className="stats-pair">
        <section className="settings-card-block">
          <div className="settings-panel stats-chart-panel">
            <div className="stats-card-head">
              <h3 className="settings-card-heading">{t("stats.trend")}</h3>
              {/* Scoped to the trend chart; independent of the global range. */}
              <div className="settings-segment" role="group" aria-label={t("stats.range")}>
                {([7, 30] as const).map((days) => (
                  <button
                    key={days}
                    type="button"
                    className={cx("settings-segment-item", trendRange === days && "active")}
                    aria-pressed={trendRange === days}
                    onClick={() => setTrendRange(days)}
                  >
                    {t(days === 7 ? "stats.range7" : "stats.range30")}
                  </button>
                ))}
              </div>
            </div>
            <Trend trend={trend} ariaSummary={trendAria} />
          </div>
        </section>
        <section className="settings-card-block">
          <div className="settings-panel stats-chart-panel">
            <h3 className="settings-card-heading">{t("stats.insights")}</h3>
            <ul className="stats-insights">
              <li>
                <span>{t("stats.cacheLeverage")}</span>
                <span className="stats-insights-value">{Math.round(diagnostics.cacheLeverage * 100)}%</span>
              </li>
              <li>
                <span>{t("stats.largeContext")}</span>
                <span className="stats-insights-value">{Math.round(diagnostics.largeContextTurnShare * 100)}%</span>
              </li>
              <li>
                <span>{t("stats.top5Share")}</span>
                <span
                  className={cx(
                    "stats-insights-value",
                    diagnostics.top5Concentrated && "idx-status warn",
                  )}
                >
                  {Math.round(diagnostics.top5SessionShare * 100)}%
                </span>
              </li>
            </ul>
          </div>
        </section>
      </div>

      {/*
        Project breakdown as its own full-width row: the share bars need
        horizontal room to encode proportion, and project names are unbounded
        strings that would starve both columns of the pair grid. Full-width
        also keeps it the same width class as the top-sessions list that
        follows, so the page reads pairs → row cards.
      */}
      <section className="settings-card-block">
        <div className="settings-panel">
          <h3 className="settings-card-heading">{t("stats.projectUsage")}</h3>
          <ProjectUsage projects={dataset.projectUsage} />
        </div>
      </section>

      <section className="settings-card-block">
        <div className="settings-panel">
          <h3 className="settings-card-heading">{t("stats.topSessions")}</h3>
          {sessions.length === 0 ? (
            <div className="settings-row">
              <div className="settings-row-copy">
                <div className="settings-row-title">{t("stats.empty")}</div>
              </div>
            </div>
          ) : (
            sessions.map((session, index) => {
              // The sessions table stores title as NOT NULL DEFAULT '', so an
              // untitled session arrives as an empty string rather than null —
              // a nullish check would leave the row label blank.
              const title = session.title?.trim() || session.sessionId.slice(0, 8);
              const lastActive = formatLastActive(session.lastActiveMs, locale);
              return (
                // A real button keeps the row Tab-reachable with native
                // Enter/Space activation. `.settings-row` already carries the
                // tile background, so the styles owner only needs to add a
                // button reset on `stats-session-row` (width:100%,
                // text-align:left, font:inherit, cursor:pointer) plus a visible
                // `:focus-visible` ring.
                <button
                  type="button"
                  className="settings-row stats-session-row"
                  key={session.sessionId}
                  aria-label={t("stats.openSession", { title })}
                  onClick={() => {
                    // Navigation is best-effort: the session may have been
                    // deleted since the stats snapshot, and selectSession
                    // rejects in that case. Swallow it rather than surfacing an
                    // error for a row that is already stale.
                    void selectSession(session.sessionId).catch(() => undefined);
                  }}
                >
                  <div className="settings-row-copy">
                    <div className="settings-row-title">
                      {index + 1}. {title}
                    </div>
                    {session.turnCount > 0 || session.lastActiveMs > 0 ? (
                      <div className="settings-row-desc">
                        {t("stats.turns", { count: session.turnCount })}
                        {lastActive ? ` · ${t("stats.lastActive", { time: lastActive })}` : ""}
                      </div>
                    ) : null}
                  </div>
                  <div className="settings-row-control idx-status ok">{formatTokens(session.tokens)}</div>
                </button>
              );
            })
          )}
        </div>
      </section>

      {/* Provenance footer: what the numbers are, how fresh they are, and what
          they cover. The relative "updated" phrase reuses the same
          Intl.RelativeTimeFormat helper as the session rows. */}
      <div className="stats-provenance" role="note">
        {(() => {
          const updatedAgo = formatLastActive(dataset.generatedAt, locale);
          return [
            t("stats.provenance"),
            updatedAgo ? t("stats.lastUpdated", { time: updatedAgo }) : null,
            t("stats.provenanceFields"),
          ]
            .filter(Boolean)
            .join(" · ");
        })()}
      </div>
    </div>
  );
}

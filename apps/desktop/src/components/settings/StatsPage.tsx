import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ProjectRecord, StatsSummary, StatsTopSession } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Button, Select, cx } from "../ui";
import {
  IconBarChart,
  IconClock,
  IconFlame,
  IconRefresh,
  IconTrendUp,
} from "../icons";
import { MetricTile } from "./MetricTile";
import {
  buildStatsDataset,
  type StatsAriaSummary,
  type StatsDataset,
  type StatsHeatmap,
  type StatsModelSlice,
  type StatsTrend,
} from "./stats/dataset";

type Range = 7 | 30;
type LoadState =
  | { kind: "loading" }
  | { kind: "error"; code: string | null }
  | { kind: "ready"; summary: StatsSummary; sessions: StatsTopSession[] };

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

// Axis labels read like the mockup ("200K", "50K", "0") — no trailing ".0".
function formatAxis(value: number): string {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}K`;
  return String(value);
}

function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// The repo has no shared relative-time helper (each page keeps a small local
// one), so the session rows reuse the same Intl.RelativeTimeFormat pattern as
// NotificationCenter / ProjectsPage rather than inventing a new format.
function formatLastActive(ms: number, locale: string): string {
  if (!ms) return "";
  const delta = ms - Date.now();
  const absolute = Math.abs(delta);
  try {
    const formatter = new Intl.RelativeTimeFormat(locale || undefined, { numeric: "auto" });
    if (absolute < 60 * 60_000) return formatter.format(Math.round(delta / 60_000), "minute");
    if (absolute < 24 * 60 * 60_000) return formatter.format(Math.round(delta / (60 * 60_000)), "hour");
    if (absolute < 7 * 24 * 60 * 60_000) {
      return formatter.format(Math.round(delta / (24 * 60 * 60_000)), "day");
    }
    return new Intl.DateTimeFormat(locale || undefined, {
      month: "short",
      day: "numeric",
      year: new Date(ms).getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleDateString();
  }
}

/** Quote a CSV field only when it contains a delimiter, quote, or newline. */
function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function download(
  dataset: StatsDataset,
  summary: StatsSummary,
  sessions: StatsTopSession[],
  format: "csv" | "json",
) {
  // File-name only: the UTC slice here is intentional and unrelated to the
  // local-date bucketing the heatmap uses for its cells.
  const base = `pi-usage-${new Date(summary.generatedAt).toISOString().slice(0, 10)}`;
  const anchor = document.createElement("a");
  if (format === "json") {
    const blob = new Blob([JSON.stringify({ summary, sessions }, null, 2)], {
      type: "application/json",
    });
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `${base}.json`;
  } else {
    const { exportMeta, exportRows } = dataset;
    const lines: string[] = [
      `# range: ${exportMeta.rangeDays}, generatedAt: ${exportMeta.generatedAtIso}, scope: ${exportMeta.scope}`,
      "# sections: daily, modelUsage, projectUsage, diagnostics, topSessions",
    ];
    const sections: Array<[string, string[][]]> = [
      ["daily", exportRows.daily],
      ["modelUsage", exportRows.modelUsage],
      ["projectUsage", exportRows.projectUsage],
      ["diagnostics", exportRows.diagnostics],
      ["topSessions", exportRows.topSessions],
    ];
    for (const [name, rows] of sections) {
      lines.push("", `[${name}]`, ...rows.map((row) => row.map(csvField).join(",")));
    }
    const blob = new Blob([`${lines.join("\n")}\n`], { type: "text/csv" });
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `${base}.csv`;
  }
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

/**
 * Heatmap — one cell per local calendar day, last 365 days ending today.
 *
 * Cells come from `dataset.heatmap`, whose keys are local dates. The host
 * buckets turns by local date (`stats.rs::local_date`), so `toISOString()`
 * would shift each day's 00:00–08:00 spend (UTC+8) into the previous column
 * and misalign the whole grid by one day.
 */
function Heatmap({ heatmap, ariaSummary }: { heatmap: StatsHeatmap; ariaSummary: StatsAriaSummary }) {
  const { t } = useTranslation();
  const weekdayLabels = t("stats.heatWeekdays").split(",");
  const { cells, monthTicks } = heatmap;
  return (
    <>
      <svg
        className="stats-heatmap"
        viewBox="0 0 664 126"
        role="img"
        aria-label={t("stats.heatmapAria", ariaSummary)}
      >
        {/* Left gutter carries the Mon–Sun row axis, matching the mockup. */}
        {weekdayLabels.map((label, row) => (
          <text
            key={label}
            className="stats-heat-month"
            x={22}
            y={16 + row * 12 + 8}
            textAnchor="end"
          >
            {label}
          </text>
        ))}
        {monthTicks.map((tick, position) => {
          // One label per month would collide at 12px columns; keep every other
          // tick so the axis stays readable at any window width.
          if (position % 2 === 1) return null;
          return (
            <text
              key={`${tick.label}-${tick.column}`}
              className="stats-heat-month"
              x={24 + tick.column * 12}
              y={10}
            >
              {tick.label}
            </text>
          );
        })}
        {cells.map((cell, index) => (
          <rect
            key={cell.date}
            // `stats-heat-today` marks the current local day; the CSS lives with
            // the other stats-heat-* rules (added by the styles owner).
            className={cx(
              "stats-heat-cell",
              `stats-heat-${cell.level}`,
              cell.isToday && "stats-heat-today",
            )}
            x={24 + Math.floor(index / 7) * 12}
            y={16 + (index % 7) * 12}
            width={10}
            height={10}
          >
            <title>{`${cell.date}: ${cell.tokens}`}</title>
          </rect>
        ))}
        <text className="stats-heat-axis" x={24} y={120}>{t("stats.heatLow")}</text>
        <g transform="translate(88, 116)">
          {[0, 1, 2, 3, 4].map((level) => (
            <rect key={level} className={`stats-heat-cell stats-heat-${level}`} x={level * 12} y={0} width={10} height={10} />
          ))}
        </g>
        <text className="stats-heat-axis" x={156} y={120}>{t("stats.heatHigh")}</text>
      </svg>
      {/*
       * Screen-reader twin of the heatmap: the same 365 daily values the cells
       * paint, as a real table. `stats-sr-table` is the page-scoped hook the
       * styles owner uses for the visually-hidden rule; `sr-only` is the
       * Tailwind utility already applied elsewhere in the renderer, so the
       * table stays hidden even before that CSS lands.
       */}
      <table className="stats-sr-table sr-only">
        <caption>{t("stats.heatmapTableCaption")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("stats.tableDate")}</th>
            <th scope="col">{t("stats.tableTokens")}</th>
          </tr>
        </thead>
        <tbody>
          {cells.map((cell) => (
            <tr key={cell.date}>
              <th scope="row">{cell.date}</th>
              <td>{cell.tokens}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Trend({ trend, ariaSummary }: { trend: StatsTrend; ariaSummary: StatsAriaSummary }) {
  const { t } = useTranslation();
  const { series, dates, axisMax, totals } = trend;

  if (dates.length === 0) {
    return <div className="stats-trend-tick">{t("stats.empty")}</div>;
  }

  const plotWidth = TREND.right - TREND.left;
  const plotHeight = TREND.bottom - TREND.top;
  const xAt = (index: number) =>
    TREND.left + (dates.length === 1 ? plotWidth / 2 : (index / (dates.length - 1)) * plotWidth);
  const yAt = (value: number) => TREND.bottom - (value / axisMax) * plotHeight;
  const toPoints = (values: number[]) =>
    values.map((value, index) => `${xAt(index)},${yAt(value)}`).join(" ");
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => ({
    value: axisMax * fraction,
    y: yAt(axisMax * fraction),
  }));
  // Five evenly spaced date labels read like the mockup without crowding.
  const labelCount = Math.min(5, dates.length);
  const xTicks = Array.from({ length: labelCount }, (_, position) => {
    const index = labelCount === 1 ? 0 : Math.round((position / (labelCount - 1)) * (dates.length - 1));
    return { date: dates[index], x: xAt(index) };
  });

  return (
    <div className="stats-scope">
      <svg
        viewBox={`0 0 ${TREND.width} ${TREND.height}`}
        className="stats-trend"
        role="img"
        aria-label={t("stats.trendAria", ariaSummary)}
      >
        {yTicks.map((tick) => (
          <g key={tick.value}>
            <line
              className="stats-trend-axis"
              x1={TREND.left}
              y1={tick.y}
              x2={TREND.right}
              y2={tick.y}
            />
            <text className="stats-trend-tick" x={TREND.left - 8} y={tick.y + 3} textAnchor="end">
              {formatAxis(Math.round(tick.value))}
            </text>
          </g>
        ))}
        {totals.length > 0 ? (
          <polygon
            className="stats-trend-area"
            points={`${TREND.left},${TREND.bottom} ${toPoints(totals)} ${TREND.right},${TREND.bottom}`}
          />
        ) : null}
        {totals.length > 0 ? (
          <polyline className="stats-trend-line stats-trend-total" points={toPoints(totals)} />
        ) : null}
        {series.map((entry, index) => (
          <polyline
            key={entry.modelId}
            // Models start at chart-2 so the total keeps the primary blue.
            className={`stats-trend-line stats-trend-${index + 1}`}
            points={toPoints(entry.values)}
          />
        ))}
        {xTicks.map((tick) => (
          <text
            key={tick.date}
            className="stats-trend-tick"
            x={tick.x}
            y={TREND.bottom + 18}
            textAnchor="middle"
          >
            {tick.date.slice(5)}
          </text>
        ))}
      </svg>
      <ul className="stats-trend-legend">
        <li>
          <span className="stats-swatch stats-swatch-0" aria-hidden="true" />
          <span>{t("stats.trendTotal")}</span>
        </li>
        {series.map((entry, index) => (
          <li key={entry.modelId}>
            <span className={`stats-swatch stats-swatch-${index + 1}`} aria-hidden="true" />
            <span>{entry.modelId}</span>
          </li>
        ))}
      </ul>
      {/* Screen-reader twin of the trend lines; values are the plotted ones. */}
      <table className="stats-sr-table sr-only">
        <caption>{t("stats.trendTableCaption")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("stats.tableDate")}</th>
            <th scope="col">{t("stats.trendTotal")}</th>
            {series.map((entry) => (
              <th scope="col" key={entry.modelId}>
                {entry.modelId}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dates.map((date, index) => (
            <tr key={date}>
              <th scope="row">{date}</th>
              <td>{totals[index]}</td>
              {series.map((entry) => (
                <td key={entry.modelId}>{entry.values[index]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Donut({ models }: { models: StatsModelSlice[] }) {
  const { t } = useTranslation();
  const total = models.reduce((sum, model) => sum + model.tokens, 0);
  const denominator = total || 1;
  let offset = 0;
  return (
    <div className="stats-donut-wrap stats-scope">
      <svg viewBox="0 0 42 42" className="stats-donut" role="img" aria-hidden="true">
        {models.slice(0, 6).map((model, index) => {
          const fraction = model.tokens / denominator;
          const circle = (
            <circle
              key={model.modelId}
              className={`stats-donut-seg stats-seg-${index}`}
              cx="21"
              cy="21"
              r="15.9"
              fill="none"
              strokeDasharray={`${fraction * 100} ${100 - fraction * 100}`}
              strokeDashoffset={25 - offset * 100}
            />
          );
          offset += fraction;
          return circle;
        })}
        <text className="stats-donut-total" x="21" y="21" textAnchor="middle">
          {formatTokens(total)}
        </text>
        <text className="stats-donut-total-label" x="21" y="25.5" textAnchor="middle">
          {t("stats.totalTokens")}
        </text>
      </svg>
      <ul className="stats-legend">
        {models.slice(0, 6).map((model, index) => (
          <li key={model.modelId}>
            <span className={`stats-swatch stats-swatch-${index}`} aria-hidden="true" />
            <span>{model.modelId}</span>
            <span className="stats-legend-value">
              {Math.round(model.share * 100)}% · {formatTokens(model.tokens)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Plot geometry in viewBox units. The SVG keeps its aspect ratio (no
// preserveAspectRatio="none"), so axis text never stretches with the card.
// Right inset leaves room for the final "MM-DD" label, which is centred on the
// last gridline and would otherwise be clipped by the viewBox edge.
const TREND = { width: 720, height: 200, left: 52, right: 688, top: 12, bottom: 150 };

export function StatsPage() {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language ?? "";
  const selectSession = useAppStore((state) => state.selectSession);
  const [range, setRange] = useState<Range>(30);
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

  const dataset = useMemo(
    () => (state.kind === "ready" ? buildStatsDataset(state.summary, state.sessions) : null),
    [state],
  );

  if (state.kind === "loading") {
    return (
      <div className="settings-stack" role="status">
        <span className="idx-state">{t("stats.loading")}</span>
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
  const { cards, diagnostics, heatmap, trend, models, aria } = dataset;
  // The charts' aria summaries need formatted numbers; the dataset keeps raw
  // values, so formatting happens here (the consumer) at render time.
  const heatAria = {
    days: aria.heatmap.days,
    tokens: formatTokens(aria.heatmap.totalTokens),
    peakTokens: formatTokens(aria.heatmap.peakTokens),
    peakDate: aria.heatmap.peakDate ?? "—",
  };
  const trendAria = {
    days: aria.trend.days,
    tokens: formatTokens(aria.trend.totalTokens),
    peakTokens: formatTokens(aria.trend.peakTokens),
    peakDate: aria.trend.peakDate ?? "—",
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
          <h3 className="settings-card-heading">{t("stats.activity")}</h3>
          <div className="settings-panel stats-chart-panel">
            <Heatmap heatmap={heatmap} ariaSummary={heatAria} />
          </div>
        </section>
        <section className="settings-card-block">
          <h3 className="settings-card-heading">{t("stats.modelUsage")}</h3>
          <div className="settings-panel stats-chart-panel">
            <Donut models={models} />
          </div>
        </section>
      </div>

      <div className="stats-pair">
        <section className="settings-card-block">
          <h3 className="settings-card-heading">{t("stats.trend")}</h3>
          <div className="settings-panel stats-chart-panel">
            <Trend trend={trend} ariaSummary={trendAria} />
          </div>
        </section>
        <section className="settings-card-block">
          <h3 className="settings-card-heading">{t("stats.insights")}</h3>
          <div className="settings-panel stats-chart-panel">
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

      <section className="settings-card-block">
        <h3 className="settings-card-heading">{t("stats.topSessions")}</h3>
        <div className="settings-panel">
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

      <div className="idx-error-line" role="note">
        {t("stats.provenance")}
      </div>
    </div>
  );
}

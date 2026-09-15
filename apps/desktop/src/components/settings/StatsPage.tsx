import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ProjectRecord,
  StatsDayModel,
  StatsDayTotal,
  StatsSummary,
  StatsTopSession,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { Button, Select, cx } from "../ui";
import {
  IconBarChart,
  IconClock,
  IconFlame,
  IconPieChart,
  IconRefresh,
  IconSparkles,
  IconTrendUp,
} from "../icons";
import { MetricTile } from "./MetricTile";

type Range = 7 | 30;
type LoadState =
  | { kind: "loading" }
  | { kind: "error" }
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

function download(summary: StatsSummary, sessions: StatsTopSession[], format: "csv" | "json") {
  const base = `pi-usage-${new Date(summary.generatedAt).toISOString().slice(0, 10)}`;
  const anchor = document.createElement("a");
  if (format === "json") {
    const blob = new Blob([JSON.stringify({ summary, sessions }, null, 2)], {
      type: "application/json",
    });
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `${base}.json`;
  } else {
    const rows = [
      ["date", "tokens"],
      ...summary.dailyTotals.map((day) => [day.date, String(day.tokens)]),
    ];
    const blob = new Blob([rows.map((row) => row.join(",")).join("\n")], { type: "text/csv" });
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `${base}.csv`;
  }
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}


const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function Heatmap({ days }: { days: StatsDayTotal[] }) {
  const byDate = useMemo(() => new Map(days.map((day) => [day.date, day.tokens])), [days]);
  const cells = useMemo(() => {
    const list: { date: string; tokens: number }[] = [];
    const today = new Date();
    for (let offset = 364; offset >= 0; offset -= 1) {
      const date = new Date(today);
      date.setDate(today.getDate() - offset);
      const key = date.toISOString().slice(0, 10);
      list.push({ date: key, tokens: byDate.get(key) ?? 0 });
    }
    return list;
  }, [byDate]);
  const max = Math.max(1, ...days.map((day) => day.tokens));
  const monthTicks = useMemo(() => {
    const ticks: { label: string; column: number }[] = [];
    cells.forEach((cell, index) => {
      const month = Number(cell.date.slice(5, 7)) - 1;
      const previous = index > 0 ? Number(cells[index - 1].date.slice(5, 7)) - 1 : -1;
      if (month !== previous) ticks.push({ label: MONTHS[month], column: Math.floor(index / 7) });
    });
    return ticks;
  }, [cells]);
  const { t } = useTranslation();
  const weekdayLabels = t("stats.heatWeekdays").split(",");
  return (
    <svg className="stats-heatmap" viewBox="0 0 664 126" role="img" aria-label={t("stats.heatmapAria")}>
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
      {cells.map((cell, index) => {
        const level = cell.tokens === 0 ? 0 : Math.min(4, Math.ceil((cell.tokens / max) * 4));
        return (
          <rect
            key={cell.date}
            className={`stats-heat-cell stats-heat-${level}`}
            x={24 + Math.floor(index / 7) * 12}
            y={16 + (index % 7) * 12}
            width={10}
            height={10}
          >
            <title>{`${cell.date}: ${cell.tokens}`}</title>
          </rect>
        );
      })}
      <text className="stats-heat-axis" x={24} y={120}>{t("stats.heatLow")}</text>
      <g transform="translate(88, 116)">
        {[0, 1, 2, 3, 4].map((level) => (
          <rect key={level} className={`stats-heat-cell stats-heat-${level}`} x={level * 12} y={0} width={10} height={10} />
        ))}
      </g>
      <text className="stats-heat-axis" x={156} y={120}>{t("stats.heatHigh")}</text>
    </svg>
  );
}

// Axis tops read like the mockup (0 / 50K / 100K / 150K / 200K) instead of
// ending on the raw peak, so the gridline labels stay round numbers.
function niceCeil(value: number): number {
  if (value <= 0) return 1;
  const base = 10 ** Math.floor(Math.log10(value));
  const normalized = value / base;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return step * base;
}

// Plot geometry in viewBox units. The SVG keeps its aspect ratio (no
// preserveAspectRatio="none"), so axis text never stretches with the card.
// Right inset leaves room for the final "MM-DD" label, which is centred on the
// last gridline and would otherwise be clipped by the viewBox edge.
const TREND = { width: 720, height: 200, left: 52, right: 688, top: 12, bottom: 150 };

function Trend({ days }: { days: StatsDayModel[] }) {
  const { t } = useTranslation();
  const { series, dates, axisMax, totalValues } = useMemo(() => {
    const byModel = new Map<string, Map<string, number>>();
    const totals = new Map<string, number>();
    const dateSet = new Set<string>();
    for (const day of days) {
      dateSet.add(day.date);
      const model = byModel.get(day.modelId) ?? new Map<string, number>();
      model.set(day.date, (model.get(day.date) ?? 0) + day.tokens);
      byModel.set(day.modelId, model);
      totals.set(day.date, (totals.get(day.date) ?? 0) + day.tokens);
    }
    const sortedDates = [...dateSet].sort();
    const ordered = [...byModel.entries()]
      .map(([modelId, values]) => ({
        modelId,
        values: sortedDates.map((date) => values.get(date) ?? 0),
        total: [...values.values()].reduce((sum, value) => sum + value, 0),
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 5);
    const sum = sortedDates.map((date) => totals.get(date) ?? 0);
    const peak = Math.max(0, ...sum, ...ordered.flatMap((entry) => entry.values));
    return { series: ordered, dates: sortedDates, axisMax: niceCeil(peak), totalValues: sum };
  }, [days]);

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
        aria-label={t("stats.trendAria")}
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
        {totalValues.length > 0 ? (
          <polygon
            className="stats-trend-area"
            points={`${TREND.left},${TREND.bottom} ${toPoints(totalValues)} ${TREND.right},${TREND.bottom}`}
          />
        ) : null}
        {totalValues.length > 0 ? (
          <polyline className="stats-trend-line stats-trend-total" points={toPoints(totalValues)} />
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
    </div>
  );
}

function Donut({ models }: { models: StatsSummary["modelUsage"] }) {
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

export function StatsPage() {
  const { t } = useTranslation();
  const [range, setRange] = useState<Range>(30);
  const [projectId, setProjectId] = useState<number | undefined>(undefined);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const load = useCallback(async (days: Range, project?: number) => {
    setState({ kind: "loading" });
    try {
      const [summary, top] = await Promise.all([
        api.statsSummary(days, project),
        api.statsTopSessions(days, project),
      ]);
      setState({ kind: "ready", summary, sessions: top.sessions ?? [] });
    } catch {
      setState({ kind: "error" });
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

  if (state.kind === "loading") {
    return (
      <div className="settings-stack" role="status">
        <span className="idx-state">{t("stats.loading")}</span>
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="settings-stack">
        <div className="settings-panel">
          <div className="settings-row">
            <div className="settings-row-copy">
              <div className="settings-row-title">{t("stats.loadError")}</div>
            </div>
            <div className="settings-row-control">
              <Button onClick={() => void load(range, projectId)}>{t("index.retry")}</Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const { summary, sessions } = state;
  const { cards, diagnostics } = summary;
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
        <Button variant="ghost" aria-label={t("stats.refresh")} onClick={() => void load(range, projectId)}>
          <IconRefresh size={14} />
        </Button>
        <Button variant="ghost" onClick={() => download(summary, sessions, "csv")}>
          {t("stats.exportCsv")}
        </Button>
        <Button variant="ghost" onClick={() => download(summary, sessions, "json")}>
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
            <Heatmap days={summary.heatmap} />
          </div>
        </section>
        <section className="settings-card-block">
          <h3 className="settings-card-heading">{t("stats.modelUsage")}</h3>
          <div className="settings-panel stats-chart-panel">
            <Donut models={summary.modelUsage} />
          </div>
        </section>
      </div>

      <div className="stats-pair">
        <section className="settings-card-block">
          <h3 className="settings-card-heading">{t("stats.trend")}</h3>
          <div className="settings-panel stats-chart-panel">
            <Trend days={summary.dailyByModel as StatsDayModel[]} />
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
                    diagnostics.top5SessionShare > 0.35 && "idx-status warn",
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
            sessions.map((session, index) => (
              <div className="settings-row" key={session.sessionId}>
                <div className="settings-row-copy">
                  <div className="settings-row-title">
                    {index + 1}. {session.title ?? session.sessionId.slice(0, 8)}
                  </div>
                </div>
                <div className="settings-row-control idx-status ok">{formatTokens(session.tokens)}</div>
              </div>
            ))
          )}
        </div>
      </section>

      <div className="idx-error-line" role="note">
        {t("stats.provenance")}
      </div>
    </div>
  );
}

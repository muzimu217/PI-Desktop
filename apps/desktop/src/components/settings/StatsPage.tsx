import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  buildTrend,
  cumulativeSeries,
  parseDateKey,
  sliceRecent,
  weeklyBuckets,
  MONTHS,
  type StatsAriaSummary,
  type StatsCumulativePoint,
  type StatsDataset,
  type StatsHeatmap,
  type StatsModelSlice,
  type StatsTrend,
  type StatsWeeklyBucket,
} from "./stats/dataset";

type Range = 7 | 30;
/** Heatmap card granularity: daily grid, ISO-week bars, or running total. */
type Granularity = "daily" | "weekly" | "cumulative";
const GRANULARITIES: readonly Granularity[] = ["daily", "weekly", "cumulative"];
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

/** Localized long date ("2026年9月9日" / "September 9, 2026") for tooltips. */
function formatFullDate(key: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale || undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
    }).format(parseDateKey(key));
  } catch {
    return key;
  }
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
 * Heatmap card — one cell per local calendar day, last 365 days ending today.
 *
 * Cells come from `dataset.heatmap`, whose keys are local dates. The host
 * buckets turns by local date (`stats.rs::local_date`), so `toISOString()`
 * would shift each day's 00:00–08:00 spend (UTC+8) into the previous column
 * and misalign the whole grid by one day.
 *
 * The granularity switch re-shapes the same daily cells in the renderer:
 * daily keeps the week-column grid, weekly aggregates into ISO-week bars and
 * cumulative draws the running total — no extra RPC, no host change.
 */
// Plot geometry in viewBox units, shared by the tooltip pixel mapping.
const HEATMAP_VIEW = { width: 664, height: 126, left: 24, top: 16, step: 12, cell: 10, rows: 7 };
// Bubble max-width lives in `.stats-tooltip` (220px); half of it is the
// horizontal clamp so the bubble never straddles the panel edge.
const TOOLTIP_HALF = 110;
// Estimated bubble height + gap: anchors nearer the top than this flip the
// bubble below the hovered cell instead of above it.
const TOOLTIP_ROOM = 76;

type HeatTip = { index: number; left: number; top: number; below: boolean };

function Heatmap({
  heatmap,
  granularity,
  ariaSummary,
}: {
  heatmap: StatsHeatmap;
  granularity: Granularity;
  ariaSummary: StatsAriaSummary;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language ?? "";
  const [tip, setTip] = useState<HeatTip | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const weekdayLabels = t("stats.heatWeekdays").split(",");
  const { cells, monthTicks } = heatmap;
  const daily = useMemo(() => cells.map(({ date, tokens }) => ({ date, tokens })), [cells]);
  const weekly = useMemo(() => weeklyBuckets(daily), [daily]);
  const cumulative = useMemo(() => cumulativeSeries(daily), [daily]);

  // The bubble is anchored to daily-grid cells; leaving the daily view (or any
  // re-shape of it) must drop the stale anchor instead of floating over the
  // weekly bars / cumulative area.
  useEffect(() => {
    setTip(null);
  }, [granularity]);

  // Anchor the bubble on the hovered cell: viewBox cell coords mapped to
  // pixels inside the positioned wrapper (the SVG scales with the panel).
  const showTip = (index: number) => {
    const wrap = wrapRef.current;
    const svg = svgRef.current;
    if (!wrap || !svg || svg.clientWidth === 0) return;
    const wrapRect = wrap.getBoundingClientRect();
    const svgRect = svg.getBoundingClientRect();
    if (svgRect.width === 0 || svgRect.height === 0) return;
    const scaleX = svgRect.width / HEATMAP_VIEW.width;
    const scaleY = svgRect.height / HEATMAP_VIEW.height;
    const column = Math.floor(index / HEATMAP_VIEW.rows);
    const row = index % HEATMAP_VIEW.rows;
    const centreX =
      svgRect.left -
      wrapRect.left +
      (HEATMAP_VIEW.left + column * HEATMAP_VIEW.step + HEATMAP_VIEW.cell / 2) * scaleX;
    const cellTop = (HEATMAP_VIEW.top + row * HEATMAP_VIEW.step) * scaleY;
    const below = cellTop < TOOLTIP_ROOM;
    setTip({
      index,
      left: Math.min(Math.max(centreX, TOOLTIP_HALF), Math.max(wrapRect.width - TOOLTIP_HALF, TOOLTIP_HALF)),
      top: below ? cellTop + HEATMAP_VIEW.cell * scaleY + 6 : cellTop - 6,
      below,
    });
  };

  const tipCell = tip ? cells[tip.index] : null;

  return (
    <div className="stats-heat-wrap" ref={wrapRef}>
      {granularity === "daily" ? (
        <svg
          ref={svgRef}
          className="stats-heatmap"
          viewBox={`0 0 ${HEATMAP_VIEW.width} ${HEATMAP_VIEW.height}`}
          role="img"
          aria-label={t("stats.heatmapAria", ariaSummary)}
          onMouseLeave={() => setTip(null)}
        >
          {/* Left gutter carries the Mon–Sun row axis, matching the mockup. */}
          {weekdayLabels.map((label, row) => (
            <text
              key={label}
              className="stats-heat-month"
              x={22}
              y={HEATMAP_VIEW.top + row * HEATMAP_VIEW.step + 8}
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
                x={HEATMAP_VIEW.left + tick.column * HEATMAP_VIEW.step}
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
              x={HEATMAP_VIEW.left + Math.floor(index / HEATMAP_VIEW.rows) * HEATMAP_VIEW.step}
              y={HEATMAP_VIEW.top + (index % HEATMAP_VIEW.rows) * HEATMAP_VIEW.step}
              width={HEATMAP_VIEW.cell}
              height={HEATMAP_VIEW.cell}
              onMouseEnter={() => showTip(index)}
            />
          ))}
          <text className="stats-heat-axis" x={HEATMAP_VIEW.left} y={120}>{t("stats.heatLow")}</text>
          <g transform="translate(88, 116)">
            {[0, 1, 2, 3, 4].map((level) => (
              <rect key={level} className={`stats-heat-cell stats-heat-${level}`} x={level * 12} y={0} width={10} height={10} />
            ))}
          </g>
          <text className="stats-heat-axis" x={156} y={120}>{t("stats.heatHigh")}</text>
        </svg>
      ) : granularity === "weekly" ? (
        <WeeklyActivity buckets={weekly} ariaSummary={ariaSummary} />
      ) : (
        <CumulativeActivity points={cumulative} ariaSummary={ariaSummary} />
      )}
      {tip && tipCell ? (
        // Rich hover hint: localized date, then tokens · turns. aria-hidden —
        // the sr-only table below already carries the numbers for AT.
        <div
          className="stats-tooltip"
          aria-hidden="true"
          style={{
            left: tip.left,
            top: tip.top,
            transform: tip.below ? "translateX(-50%)" : "translate(-50%, -100%)",
          }}
        >
          <div className="stats-tooltip-date">{formatFullDate(tipCell.date, locale)}</div>
          <div className="stats-tooltip-value">
            {formatTokens(tipCell.tokens)} {t("stats.tableTokens")}
            {" · "}
            {t("stats.tooltipTurns", { count: tipCell.turns })}
          </div>
        </div>
      ) : null}
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
    </div>
  );
}

/** ISO-week bar view of the 365-day window: x = week index, height = tokens. */
function WeeklyActivity({
  buckets,
  ariaSummary,
}: {
  buckets: StatsWeeklyBucket[];
  ariaSummary: StatsAriaSummary;
}) {
  const { t } = useTranslation();
  if (buckets.length === 0) {
    return <div className="stats-trend-tick">{t("stats.empty")}</div>;
  }
  const left = 24;
  const right = 660;
  const top = 20;
  const bottom = 116;
  const max = Math.max(1, ...buckets.map((bucket) => bucket.tokens));
  const step = (right - left) / buckets.length;
  const barWidth = Math.max(3, Math.min(10, step - 4));
  // Month axis: one tick where the bucket's Monday enters a new month, thinned
  // like the daily grid so 12 labels never collide.
  const monthTicks: Array<{ label: string; column: number }> = [];
  buckets.forEach((bucket, index) => {
    const month = Number(bucket.start.slice(5, 7)) - 1;
    const previous = index > 0 ? Number(buckets[index - 1].start.slice(5, 7)) - 1 : -1;
    if (month !== previous) monthTicks.push({ label: MONTHS[month], column: index });
  });
  return (
    <svg
      className="stats-heatmap"
      viewBox="0 0 664 126"
      role="img"
      aria-label={t("stats.heatmapAria", ariaSummary)}
    >
      {monthTicks.map((tick, position) =>
        // Odd positions thin the axis; column 0 would sit under the max-value
        // label, so the axis starts from the second month.
        position % 2 === 1 || tick.column === 0 ? null : (
          <text
            key={`${tick.label}-${tick.column}`}
            className="stats-heat-month"
            x={left + tick.column * step}
            y={10}
          >
            {tick.label}
          </text>
        ),
      )}
      <text className="stats-heat-axis" x={left} y={top - 6} textAnchor="start">
        {formatAxis(max)}
      </text>
      {buckets.map((bucket, index) => {
        const height = (bucket.tokens / max) * (bottom - top);
        return (
          <rect
            key={bucket.start}
            className="stats-week-bar"
            x={left + index * step + (step - barWidth) / 2}
            y={bottom - height}
            width={barWidth}
            height={height}
            rx={2}
          />
        );
      })}
      <line className="stats-trend-axis" x1={left} y1={bottom} x2={right} y2={bottom} />
      <text className="stats-heat-axis" x={left} y={bottom + 14} textAnchor="start">
        0
      </text>
    </svg>
  );
}

/** Running-total area view: the annotation at the line's end is the window total. */
function CumulativeActivity({
  points,
  ariaSummary,
}: {
  points: StatsCumulativePoint[];
  ariaSummary: StatsAriaSummary;
}) {
  const { t } = useTranslation();
  if (points.length === 0) {
    return <div className="stats-trend-tick">{t("stats.empty")}</div>;
  }
  const left = 24;
  const right = 648;
  const top = 20;
  const bottom = 116;
  const total = points[points.length - 1].tokens;
  const max = Math.max(1, total);
  const xAt = (index: number) =>
    points.length === 1
      ? (left + right) / 2
      : left + (index / (points.length - 1)) * (right - left);
  const yAt = (value: number) => bottom - (value / max) * (bottom - top);
  const line = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${xAt(index)},${yAt(point.tokens)}`)
    .join(" ");
  const area = `M${xAt(0)},${bottom} ${points
    .map((point, index) => `L${xAt(index)},${yAt(point.tokens)}`)
    .join(" ")} L${xAt(points.length - 1)},${bottom} Z`;
  return (
    <svg
      className="stats-heatmap"
      viewBox="0 0 664 126"
      role="img"
      aria-label={t("stats.heatmapAria", ariaSummary)}
    >
      <line className="stats-trend-axis" x1={left} y1={bottom} x2={right} y2={bottom} />
      <path className="stats-cumulative-area" d={area} />
      <path className="stats-cumulative-line" d={line} />
      {/* The end label is the whole point of this view: the window total. */}
      <text className="stats-heat-axis" x={xAt(points.length - 1)} y={Math.max(12, yAt(total) - 8)} textAnchor="end">
        {formatTokens(total)}
      </text>
    </svg>
  );
}

type TrendTip = { index: number; left: number };

function Trend({ trend, ariaSummary }: { trend: StatsTrend; ariaSummary: StatsAriaSummary }) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language ?? "";
  const [tip, setTip] = useState<TrendTip | null>(null);
  const plotRef = useRef<HTMLDivElement | null>(null);
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

  // Snap to the nearest plotted day in viewBox space, then convert that point
  // back to pixels inside the positioned plot wrapper for the bubble.
  const onMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const plot = plotRef.current;
    if (!plot) return;
    const plotRect = plot.getBoundingClientRect();
    const svgRect = event.currentTarget.getBoundingClientRect();
    if (svgRect.width === 0) return;
    const viewX = ((event.clientX - svgRect.left) / svgRect.width) * TREND.width;
    const fraction = dates.length === 1 ? 0.5 : (viewX - TREND.left) / plotWidth;
    const index = Math.min(dates.length - 1, Math.max(0, Math.round(fraction * (dates.length - 1))));
    const left = svgRect.left - plotRect.left + xAt(index) * (svgRect.width / TREND.width);
    setTip({
      index,
      left: Math.min(
        Math.max(left, TOOLTIP_HALF),
        Math.max(plotRect.width - TOOLTIP_HALF, TOOLTIP_HALF),
      ),
    });
  };

  return (
    <div className="stats-scope">
      {/* Legend above the plot (mockup posture), one truncatable row. */}
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
      <div className="stats-trend-plot" ref={plotRef}>
        <svg
          viewBox={`0 0 ${TREND.width} ${TREND.height}`}
          className="stats-trend"
          role="img"
          aria-label={t("stats.trendAria", ariaSummary)}
          onMouseMove={onMove}
          onMouseLeave={() => setTip(null)}
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
          {tip ? (
            <g>
              <line
                className="stats-trend-crosshair"
                x1={xAt(tip.index)}
                y1={TREND.top}
                x2={xAt(tip.index)}
                y2={TREND.bottom}
              />
              {/* Anchor dots on the hovered day, one per plotted series. */}
              {[{ values: totals, className: "stats-trend-marker-total" }].concat(
                series.map((entry, index) => ({
                  values: entry.values,
                  className: `stats-trend-marker-${index + 1}`,
                })),
              ).map((marker, markerIndex) => (
                <circle
                  key={markerIndex}
                  className={`stats-trend-marker ${marker.className}`}
                  cx={xAt(tip.index)}
                  cy={yAt(marker.values[tip.index])}
                  r={3}
                />
              ))}
            </g>
          ) : null}
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
        {tip ? (
          // Per-day readout: date, then total and each model with its swatch.
          <div
            className="stats-tooltip"
            aria-hidden="true"
            style={{ left: tip.left, top: 6, transform: "translateX(-50%)" }}
          >
            <div className="stats-tooltip-date">{formatFullDate(dates[tip.index], locale)}</div>
            <div className="stats-tooltip-row">
              <span className="stats-swatch stats-swatch-0" aria-hidden="true" />
              <span>{t("stats.trendTotal")}</span>
              <span className="stats-tooltip-num">{formatTokens(totals[tip.index])}</span>
            </div>
            {series.map((entry, index) => (
              <div className="stats-tooltip-row" key={entry.modelId}>
                <span className={`stats-swatch stats-swatch-${index + 1}`} aria-hidden="true" />
                <span>{entry.modelId}</span>
                <span className="stats-tooltip-num">{formatTokens(entry.values[tip.index])}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
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
          <div className="settings-panel stats-chart-panel">
            <Heatmap heatmap={heatmap} granularity={granularity} ariaSummary={heatAria} />
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

      <div className="stats-provenance" role="note">
        {t("stats.provenance")}
      </div>
    </div>
  );
}

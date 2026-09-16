import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cx } from "../../ui";
import {
  cumulativeSeries,
  weeklyBuckets,
  type StatsAriaSummary,
  type StatsHeatmap,
} from "./dataset";
import { formatFullDate, formatTokens } from "./format";
import { HEATMAP_VIEW, TOOLTIP_HALF, TOOLTIP_ROOM, type HeatTip } from "./geometry";
import type { Granularity } from "./types";
import { CumulativeActivity } from "./CumulativeActivity";
import { WeeklyActivity } from "./WeeklyActivity";

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
export function Heatmap({
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
  // Carry `turns` through: the weekly bars re-aggregate it so their tooltip
  // reads like the daily one (tokens · turns) off the same single RPC.
  const daily = useMemo(
    () => cells.map(({ date, tokens, turns }) => ({ date, tokens, turns })),
    [cells],
  );
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
      {granularity === "daily" && tip && tipCell ? (
        // Rich hover hint: localized date, then tokens · turns. aria-hidden —
        // the sr-only table below already carries the numbers for AT. Only the
        // daily grid anchors here; the weekly and cumulative views own their
        // own bubble inside their plot wrapper.
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

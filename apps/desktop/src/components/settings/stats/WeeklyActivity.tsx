import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cx } from "../../ui";
import { niceCeil, type StatsAriaSummary, type StatsWeeklyBucket } from "./dataset";
import { formatFullDate, formatTokens } from "./format";
import {
  ACTIVITY_VIEW,
  TOOLTIP_HALF,
  axisLabelIndices,
  axisTicks,
  monthTicksFor,
} from "./geometry";
import { AxisGrid } from "./AxisGrid";

/**
 * ISO-week bar view of the 365-day window: x = week index, height = tokens.
 *
 * Every week paints a full-height `stats-week-track` and only the weeks with
 * spend draw a bar on top of it. Without the track a sparse year (one active
 * week out of ~53) renders as a single bar floating in an empty card; with it
 * the window's full extent — and which weeks are genuinely idle — reads at a
 * glance. Hovering a column adds a crosshair plus the same rich bubble the
 * daily grid uses, so the two views read the same way.
 */
export function WeeklyActivity({
  buckets,
  ariaSummary,
}: {
  buckets: StatsWeeklyBucket[];
  ariaSummary: StatsAriaSummary;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language ?? "";
  const [tip, setTip] = useState<{ index: number; left: number } | null>(null);
  const plotRef = useRef<HTMLDivElement | null>(null);
  if (buckets.length === 0) {
    return <div className="stats-trend-tick">{t("stats.empty")}</div>;
  }
  const { left, right, top, bottom, width, height } = ACTIVITY_VIEW;
  const axisMax = niceCeil(Math.max(1, ...buckets.map((bucket) => bucket.tokens)));
  const step = (right - left) / buckets.length;
  // ~8 units wide at the 53-column density, capped so a short series does not
  // turn into fat slabs.
  const barWidth = Math.max(2, Math.min(26, step - 3));
  const centreX = (index: number) => left + (index + 0.5) * step;
  const barHeight = (tokens: number) => (tokens / axisMax) * (bottom - top);
  const monthTicks = monthTicksFor(
    buckets.map((bucket) => bucket.start),
    centreX,
  );
  const labelIndices = axisLabelIndices(buckets.length);
  const tipBucket = tip ? buckets[tip.index] : null;

  // Snap to the hovered column, then convert that column back to pixels inside
  // the positioned wrapper for the bubble (same mapping as the trend chart).
  const onMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const plot = plotRef.current;
    if (!plot) return;
    const plotRect = plot.getBoundingClientRect();
    const svgRect = event.currentTarget.getBoundingClientRect();
    if (svgRect.width === 0) return;
    const viewX = ((event.clientX - svgRect.left) / svgRect.width) * ACTIVITY_VIEW.width;
    const index = Math.min(
      buckets.length - 1,
      Math.max(0, Math.floor(((viewX - left) / (right - left)) * buckets.length)),
    );
    const anchor =
      svgRect.left - plotRect.left + centreX(index) * (svgRect.width / ACTIVITY_VIEW.width);
    setTip({
      index,
      left: Math.min(
        Math.max(anchor, TOOLTIP_HALF),
        Math.max(plotRect.width - TOOLTIP_HALF, TOOLTIP_HALF),
      ),
    });
  };

  return (
    <div className="stats-trend-plot" ref={plotRef}>
      <svg
        className="stats-heatmap"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={t("stats.heatmapAria", ariaSummary)}
        onMouseMove={onMove}
        onMouseLeave={() => setTip(null)}
      >
        <AxisGrid ticks={axisTicks(axisMax)} />
        {monthTicks.map((tick) => (
          <text
            key={`${tick.label}-${tick.x}`}
            className="stats-heat-month"
            x={tick.x}
            y={10}
            textAnchor="middle"
          >
            {tick.label}
          </text>
        ))}
        {buckets.map((bucket, index) => {
          const x = left + index * step + (step - barWidth) / 2;
          return (
            <g key={bucket.start}>
              <rect
                className="stats-week-track"
                x={x}
                y={top}
                width={barWidth}
                height={bottom - top}
                rx={2}
              />
              {bucket.tokens > 0 ? (
                <rect
                  className={cx("stats-week-bar", tip?.index === index && "stats-week-bar-active")}
                  x={x}
                  y={bottom - barHeight(bucket.tokens)}
                  width={barWidth}
                  height={barHeight(bucket.tokens)}
                  rx={2}
                />
              ) : null}
            </g>
          );
        })}
        <line className="stats-trend-axis" x1={left} y1={bottom} x2={right} y2={bottom} />
        {labelIndices.map((index) => (
          <text
            key={buckets[index].start}
            className="stats-trend-tick"
            x={centreX(index)}
            y={bottom + 14}
            textAnchor="middle"
          >
            {buckets[index].start.slice(5)}
          </text>
        ))}
        {tip ? (
          <line
            className="stats-trend-crosshair"
            x1={centreX(tip.index)}
            y1={top}
            x2={centreX(tip.index)}
            y2={bottom}
          />
        ) : null}
      </svg>
      {tip && tipBucket ? (
        // Week range on the first line, tokens · turns on the second — the same
        // shape as the daily bubble so hovering either view reads identically.
        <div
          className="stats-tooltip"
          aria-hidden="true"
          style={{ left: tip.left, top: 6, transform: "translateX(-50%)" }}
        >
          <div className="stats-tooltip-date">
            {tipBucket.start === tipBucket.end
              ? formatFullDate(tipBucket.start, locale)
              : `${formatFullDate(tipBucket.start, locale)} – ${formatFullDate(tipBucket.end, locale)}`}
          </div>
          <div className="stats-tooltip-value">
            {formatTokens(tipBucket.tokens)} {t("stats.tableTokens")}
            {" · "}
            {t("stats.tooltipTurns", { count: tipBucket.turns })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { niceCeil, type StatsAriaSummary, type StatsCumulativePoint } from "./dataset";
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
 * Running-total area view: the annotation at the line's end is the window
 * total. The axis, the month row and the per-day date labels come from the same
 * helpers as the weekly bars, so the two views share one frame; hovering a day
 * reads out the running total *and* that day's own spend, which is the delta
 * the line alone cannot show.
 */
export function CumulativeActivity({
  points,
  ariaSummary,
}: {
  points: StatsCumulativePoint[];
  ariaSummary: StatsAriaSummary;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? i18n.language ?? "";
  const [tip, setTip] = useState<{ index: number; left: number } | null>(null);
  const plotRef = useRef<HTMLDivElement | null>(null);
  if (points.length === 0) {
    return <div className="stats-trend-tick">{t("stats.empty")}</div>;
  }
  const { left, right, top, bottom, width, height } = ACTIVITY_VIEW;
  const total = points[points.length - 1].tokens;
  const axisMax = niceCeil(Math.max(1, total));
  const xAt = (index: number) =>
    points.length === 1
      ? (left + right) / 2
      : left + (index / (points.length - 1)) * (right - left);
  const yAt = (value: number) => bottom - (value / axisMax) * (bottom - top);
  const line = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${xAt(index)},${yAt(point.tokens)}`)
    .join(" ");
  const area = `M${xAt(0)},${bottom} ${points
    .map((point, index) => `L${xAt(index)},${yAt(point.tokens)}`)
    .join(" ")} L${xAt(points.length - 1)},${bottom} Z`;
  const monthTicks = monthTicksFor(
    points.map((point) => point.date),
    xAt,
  );
  const labelIndices = axisLabelIndices(points.length);
  const tipPoint = tip ? points[tip.index] : null;
  const lastIndex = points.length - 1;
  // Running total minus the previous day's: the spend of the hovered day.
  const dayDelta = tip ? points[tip.index].tokens - (tip.index > 0 ? points[tip.index - 1].tokens : 0) : 0;

  const onMove = (event: React.MouseEvent<SVGSVGElement>) => {
    const plot = plotRef.current;
    if (!plot) return;
    const plotRect = plot.getBoundingClientRect();
    const svgRect = event.currentTarget.getBoundingClientRect();
    if (svgRect.width === 0) return;
    const viewX = ((event.clientX - svgRect.left) / svgRect.width) * ACTIVITY_VIEW.width;
    const fraction = points.length === 1 ? 0.5 : (viewX - left) / (right - left);
    const index = Math.min(lastIndex, Math.max(0, Math.round(fraction * lastIndex)));
    const anchor =
      svgRect.left - plotRect.left + xAt(index) * (svgRect.width / ACTIVITY_VIEW.width);
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
        <line className="stats-trend-axis" x1={left} y1={bottom} x2={right} y2={bottom} />
        <path className="stats-cumulative-area" d={area} />
        <path className="stats-cumulative-line" d={line} />
        {labelIndices.map((index) => (
          <text
            key={points[index].date}
            className="stats-trend-tick"
            x={xAt(index)}
            y={bottom + 14}
            textAnchor="middle"
          >
            {points[index].date.slice(5)}
          </text>
        ))}
        {tip ? (
          <line
            className="stats-trend-crosshair"
            x1={xAt(tip.index)}
            y1={top}
            x2={xAt(tip.index)}
            y2={bottom}
          />
        ) : null}
        {/*
         * The end label is the whole point of this view: the window total. Its
         * dot is dropped while the last day is hovered so the marker below does
         * not draw a second ring on the same spot.
         */}
        <text
          className="stats-heat-axis"
          x={xAt(lastIndex)}
          y={Math.max(12, yAt(total) - 8)}
          textAnchor="end"
        >
          {formatTokens(total)}
        </text>
        {tip?.index === lastIndex ? null : (
          <circle className="stats-trend-marker stats-trend-marker-total" cx={xAt(lastIndex)} cy={yAt(total)} r={3} />
        )}
        {tip ? (
          <circle
            className="stats-trend-marker stats-trend-marker-total"
            cx={xAt(tip.index)}
            cy={yAt(points[tip.index].tokens)}
            r={3}
          />
        ) : null}
      </svg>
      {tip && tipPoint ? (
        <div
          className="stats-tooltip"
          aria-hidden="true"
          style={{ left: tip.left, top: 6, transform: "translateX(-50%)" }}
        >
          <div className="stats-tooltip-date">{formatFullDate(tipPoint.date, locale)}</div>
          <div className="stats-tooltip-row">
            <span>{t("stats.totalTokens")}</span>
            <span className="stats-tooltip-num">{formatTokens(tipPoint.tokens)}</span>
          </div>
          <div className="stats-tooltip-row">
            <span>{t("stats.dayDelta")}</span>
            <span className="stats-tooltip-num">{formatTokens(dayDelta)}</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

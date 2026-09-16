import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { StatsAriaSummary, StatsTrend } from "./dataset";
import { formatAxis, formatFullDate, formatTokens } from "./format";
import { TOOLTIP_HALF, TREND } from "./geometry";

/**
 * Token trend card: total plus per-model lines over a 7/30-day window the
 * card owns, with a hover crosshair and a per-day readout.
 */

type TrendTip = { index: number; left: number };

export function Trend({ trend, ariaSummary }: { trend: StatsTrend; ariaSummary: StatsAriaSummary }) {
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

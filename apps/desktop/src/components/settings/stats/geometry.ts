import { MONTHS } from "./dataset";

/**
 * Plot geometry and axis helpers shared by the stats charts.
 *
 * One viewBox per chart family, plus the tick and month-label maths the daily
 * grid, the weekly bars and the cumulative area all reuse.
 */

// Plot geometry in viewBox units, shared by the tooltip pixel mapping.
export const HEATMAP_VIEW = { width: 664, height: 126, left: 24, top: 16, step: 12, cell: 10, rows: 7 };
// Bubble max-width lives in `.stats-tooltip` (220px); half of it is the
// horizontal clamp so the bubble never straddles the panel edge.
export const TOOLTIP_HALF = 110;
// Estimated bubble height + gap: anchors nearer the top than this flip the
// bubble below the hovered cell instead of above it.
export const TOOLTIP_ROOM = 76;

export type HeatTip = { index: number; left: number; top: number; below: boolean };

/*
 * Weekly bars and the cumulative area share one plot box instead of their own
 * ad-hoc numbers: the same 664 × 126 canvas as the daily grid, so the activity
 * card keeps a single height across the granularity switch, with a left gutter
 * for the y-axis labels and a bottom row for the x-axis dates.
 */
export const ACTIVITY_VIEW = { width: 664, height: 126, left: 46, right: 648, top: 24, bottom: 102 };

/**
 * Y-axis stops from 0 to a round top. The step is derived from the top so the
 * labels stay distinct at every magnitude — five quarter stops would print
 * "0, 0, 1, 1, 1" on a small axis — and the last stop is always `axisMax`, so
 * the axis is visibly capped by the real data instead of floating above it.
 */
export function axisTicks(axisMax: number) {
  const raw = axisMax / 4;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalised = raw / magnitude;
  const step = (normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 5 ? 5 : 10) * magnitude;
  const values = [0];
  for (let value = step; value < axisMax - step / 1000; value += step) values.push(value);
  values.push(axisMax);
  const plotHeight = ACTIVITY_VIEW.bottom - ACTIVITY_VIEW.top;
  return values.map((value) => ({
    value,
    y: ACTIVITY_VIEW.bottom - (value / axisMax) * plotHeight,
  }));
}
/**
 * Month labels for the row above a plot: one per month, dropped when it would
 * land closer than a three-letter label plus a gap to the previous one, so the
 * axis thins itself out in a narrow card instead of overlapping.
 *
 * A window that opens mid-month starts on a partial period whose label would
 * sit hard against the y-axis and then push the *next* month out of the axis
 * entirely (a 365-day window loses October that way), so a leading partial
 * period is skipped and the axis starts on the first whole month.
 */
export function monthTicksFor(dates: string[], xAt: (index: number) => number) {
  const ticks: Array<{ label: string; x: number }> = [];
  dates.forEach((date, index) => {
    const month = Number(date.slice(5, 7)) - 1;
    const previous = index > 0 ? Number(dates[index - 1].slice(5, 7)) - 1 : -1;
    if (month === previous) return;
    if (index === 0 && date.slice(8) !== "01") return;
    const x = xAt(index);
    if (ticks.length > 0 && x - ticks[ticks.length - 1].x < 34) return;
    ticks.push({ label: MONTHS[month], x });
  });
  return ticks;
}

/** Evenly spaced x-axis label positions, capped so the axis never crowds. */
export function axisLabelIndices(count: number, limit = 6): number[] {
  if (count === 0) return [];
  const labels = Math.min(limit, count);
  if (labels === 1) return [0];
  const gap = (count - 1) / (labels - 1);
  return Array.from({ length: labels }, (_, position) => Math.round(position * gap));
}
// Plot geometry in viewBox units. The SVG keeps its aspect ratio (no
// preserveAspectRatio="none"), so axis text never stretches with the card.
// Right inset leaves room for the final "MM-DD" label, which is centred on the
// last gridline and would otherwise be clipped by the viewBox edge.
export const TREND = { width: 720, height: 200, left: 52, right: 688, top: 12, bottom: 150 };

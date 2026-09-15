/**
 * StatsDataset — the single semantic data shape for the usage page.
 *
 * The RPC response is projected exactly once, here, into a structured dataset
 * that the three consumers (SVG visualisations, the `sr-only` accessibility
 * tables, and the CSV/JSON export) all read from. Charts are never a data
 * source: every number they paint comes from this object, which is what keeps
 * the hidden tables and the export in lockstep with the graphics.
 *
 * The function is pure and side-effect free. The only ambient input is the
 * current time, which is injected (defaulting to `new Date()`) so the
 * heatmap's "today" column and day fill can be unit tested deterministically.
 *
 * IMPORTANT: local-timezone date keys. The host buckets turns by local date
 * (`stats.rs::local_date`), so every key here is built from the local
 * `getFullYear`/`getMonth`/`getDate` components. Using `toISOString()` would
 * shift each day's 00:00–08:00 spend (UTC+8) into the previous column and
 * misalign the whole heatmap by one day.
 */
import type { StatsDayModel, StatsSummary, StatsTopSession } from "@pi-desktop/shared";

const DAY_MS = 86_400_000;

/** One calendar day in the host's local-date convention (`YYYY-MM-DD`). */
export function localDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Local-timezone day shift; `setDate` normalises month/year rollover. */
function shiftDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

/**
 * Parse `YYYY-MM-DD` into a local-midnight Date. `new Date(key)` would parse
 * as UTC midnight and re-shift the string through the local zone — the same
 * trap `localDateKey` exists to avoid, so decoding stays symmetric with it.
 */
export function parseDateKey(key: string): Date {
  return new Date(
    Number(key.slice(0, 4)),
    Number(key.slice(5, 7)) - 1,
    Number(key.slice(8, 10)),
  );
}

/** Monday that starts the ISO week containing `date` (local calendar). */
export function startOfIsoWeek(date: Date): Date {
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  return monday;
}

/**
 * Aggregate an ascending daily series into ISO-week buckets (Monday-anchored).
 * The bucket `start` is the Monday even when the window begins mid-week, so
 * consecutive buckets are always 7 days apart and a 365-day window maps to
 * ~53 stable columns.
 */
export function weeklyBuckets(days: StatsDailyPoint[]): StatsWeeklyBucket[] {
  const buckets: StatsWeeklyBucket[] = [];
  for (const day of days) {
    const start = localDateKey(startOfIsoWeek(parseDateKey(day.date)));
    const last = buckets[buckets.length - 1];
    if (last && last.start === start) {
      last.tokens += day.tokens;
      last.end = day.date;
    } else {
      buckets.push({ start, end: day.date, tokens: day.tokens });
    }
  }
  return buckets;
}

/** Running total over an ascending daily series (cumulative-view input). */
export function cumulativeSeries(days: StatsDailyPoint[]): StatsCumulativePoint[] {
  let running = 0;
  return days.map((day) => {
    running += day.tokens;
    return { date: day.date, tokens: running };
  });
}

/**
 * Keep only the most recent `days` distinct dates of a point list. Points may
 * repeat a date (dailyByModel has one row per model per day), so the cut is
 * computed on the sorted date set and applied as a filter — every series for a
 * kept day survives together.
 */
export function sliceRecent<T extends { date: string }>(days: number, points: T[]): T[] {
  if (days <= 0 || points.length === 0) return [];
  const dates = [...new Set(points.map((point) => point.date))].sort();
  const keep = new Set(dates.slice(-days));
  return points.filter((point) => keep.has(point.date));
}

/** Round the axis top up to 1/2/2.5/5 × 10ⁿ so gridlines read as round numbers. */
export function niceCeil(value: number): number {
  if (value <= 0) return 1;
  const base = 10 ** Math.floor(Math.log10(value));
  const normalized = value / base;
  const step =
    normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return step * base;
}

/** Session-concentration watch threshold: top-5 share above this is flagged. */
export const STATS_CONCENTRATION_THRESHOLD = 0.35;

/** Short English month labels for the SVG month axes (kept locale-neutral). */
export const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export type StatsDailyPoint = { date: string; tokens: number };

export type StatsHeatCell = {
  date: string;
  tokens: number;
  /** Completed turns that produced the day's tokens (0 when unreported). */
  turns: number;
  /** 0 (empty) … 4 (peak), matching the `stats-heat-<level>` classes. */
  level: number;
  isToday: boolean;
};

/** One ISO-week (Monday-anchored) bucket of the 365-day heatmap window. */
export type StatsWeeklyBucket = { start: string; end: string; tokens: number };

/** One day of the running total over the heatmap window. */
export type StatsCumulativePoint = { date: string; tokens: number };

export type StatsHeatmap = {
  cells: StatsHeatCell[];
  /** Peak tokens across the window; always ≥ 1 so the level scale is finite. */
  max: number;
  today: string;
  monthTicks: Array<{ label: string; column: number }>;
};

export type StatsTrendSeries = { modelId: string; values: number[]; total: number };

export type StatsTrend = {
  dates: string[];
  series: StatsTrendSeries[];
  totals: number[];
  /** Peak of every plotted value (totals and series) — never negative. */
  peak: number;
  /** Nice-ceil Y-axis top derived from the peak of every plotted value. */
  axisMax: number;
};

/**
 * Derive the trend chart data from per-model daily rows: aligned ascending
 * dates, top-5 model series by total, a totals overlay and a nice-ceil axis.
 * Exported so the page can rebuild it from a time-sliced slice of the same
 * rows (the trend card's 7/30-day switch) without a second RPC.
 */
export function buildTrend(dailyByModel: StatsDayModel[]): StatsTrend {
  const byModel = new Map<string, Map<string, number>>();
  const totalsByDate = new Map<string, number>();
  const dateSet = new Set<string>();
  for (const day of dailyByModel) {
    dateSet.add(day.date);
    const model = byModel.get(day.modelId) ?? new Map<string, number>();
    model.set(day.date, (model.get(day.date) ?? 0) + day.tokens);
    byModel.set(day.modelId, model);
    totalsByDate.set(day.date, (totalsByDate.get(day.date) ?? 0) + day.tokens);
  }
  const dates = [...dateSet].sort();
  const series: StatsTrendSeries[] = [...byModel.entries()]
    .map(([modelId, values]) => ({
      modelId,
      values: dates.map((date) => values.get(date) ?? 0),
      total: [...values.values()].reduce((sum, value) => sum + value, 0),
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 5);
  const totals = dates.map((date) => totalsByDate.get(date) ?? 0);
  const peak = Math.max(0, ...totals, ...series.flatMap((entry) => entry.values));
  return { dates, series, totals, peak, axisMax: niceCeil(peak) };
}

export type StatsModelSlice = { modelId: string; tokens: number; share: number };
export type StatsProjectSlice = {
  projectId: number | null;
  projectName: string | null;
  tokens: number;
  share: number;
};

export type StatsExportRow = string[];

/**
 * Interpolation payload for the chart `aria-label` summaries. Raw counts are
 * kept in the dataset; the consumer formats `tokens`/`peakTokens` to display
 * units (e.g. "12.4K") before handing them to i18next.
 */
export type StatsAriaSummary = {
  days: number;
  tokens: string;
  peakTokens: string;
  peakDate: string;
};

export type StatsDataset = {
  range: { days: number; startMs: number; endMs: number };
  scope: { projectId: number | null };
  generatedAt: number;
  cards: StatsSummary["cards"];
  totals: { totalTokens: number; sessionCount: number; turnCount: number };
  /** Ascending, gap-filled to the requested range (missing days read 0). */
  daily: StatsDailyPoint[];
  dailyByModel: StatsDayModel[];
  /** Descending by tokens, shares renormalised to sum to 1. */
  models: StatsModelSlice[];
  projectUsage: StatsProjectSlice[];
  heatmap: StatsHeatmap;
  trend: StatsTrend;
  peakDay: { date: string | null; tokens: number };
  diagnostics: StatsSummary["diagnostics"] & {
    /** Derived: top-5 session concentration above the watch threshold. */
    top5Concentrated: boolean;
  };
  topSessions: StatsTopSession[];
  /** Real numbers behind the `aria-label` summaries, for i18n interpolation. */
  aria: {
    heatmap: { days: number; totalTokens: number; peakTokens: number; peakDate: string | null };
    trend: { days: number; totalTokens: number; peakTokens: number; peakDate: string | null };
  };
  exportMeta: { rangeDays: number; generatedAtIso: string; scope: string };
  exportRows: {
    daily: StatsExportRow[];
    modelUsage: StatsExportRow[];
    projectUsage: StatsExportRow[];
    diagnostics: StatsExportRow[];
    topSessions: StatsExportRow[];
  };
};

/**
 * Project one summary + top-session list into the shared dataset.
 *
 * @param now injectable clock so "today" and the day fill are testable.
 */
export function buildStatsDataset(
  summary: StatsSummary,
  sessions: StatsTopSession[],
  now: Date = new Date(),
): StatsDataset {
  const rangeDays = Math.max(
    1,
    Math.round((summary.range.endMs - summary.range.startMs) / DAY_MS),
  );
  const endLocal = new Date(summary.range.endMs);

  // --- Daily series: sorted ascending, every day in range present. ---------
  const observedDaily = new Map(summary.dailyTotals.map((day) => [day.date, day.tokens]));
  const daily: StatsDailyPoint[] = [];
  const filled = new Set<string>();
  for (let offset = rangeDays - 1; offset >= 0; offset -= 1) {
    const date = localDateKey(shiftDays(endLocal, -offset));
    filled.add(date);
    daily.push({ date, tokens: observedDaily.get(date) ?? 0 });
  }
  // Keep any observed day the range fill did not cover (host clock skew).
  for (const day of summary.dailyTotals) {
    if (!filled.has(day.date)) daily.push({ date: day.date, tokens: day.tokens });
  }
  daily.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // --- Peak day: consume the frozen card field, derive the date if absent. -
  const derivedPeak = daily.reduce<{ date: string | null; tokens: number }>(
    (best, day) => (day.tokens > best.tokens ? { date: day.date, tokens: day.tokens } : best),
    { date: null, tokens: 0 },
  );
  const peakDay = {
    date: summary.cards.peakDayDate ?? (derivedPeak.tokens > 0 ? derivedPeak.date : null),
    tokens:
      summary.cards.peakDayTokens > 0 ? summary.cards.peakDayTokens : derivedPeak.tokens,
  };

  // --- Models: descending, shares renormalised so they sum to 1. -----------
  const modelTotal = summary.modelUsage.reduce((sum, model) => sum + model.tokens, 0);
  const models: StatsModelSlice[] = [...summary.modelUsage]
    .sort((a, b) => b.tokens - a.tokens)
    .map((model) => ({
      modelId: model.modelId,
      tokens: model.tokens,
      share: modelTotal > 0 ? model.tokens / modelTotal : 0,
    }));

  const projectTotal = summary.projectUsage.reduce((sum, project) => sum + project.tokens, 0);
  const projectUsage: StatsProjectSlice[] = [...summary.projectUsage]
    .sort((a, b) => b.tokens - a.tokens)
    .map((project) => ({
      projectId: project.projectId,
      projectName: project.projectName,
      tokens: project.tokens,
      share: projectTotal > 0 ? project.tokens / projectTotal : 0,
    }));

  // --- Heatmap: 365 local-date cells ending today. ------------------------
  const heatByDate = new Map(summary.heatmap.map((day) => [day.date, day]));
  const today = localDateKey(now);
  const max = Math.max(1, ...summary.heatmap.map((day) => day.tokens));
  const cells: StatsHeatCell[] = [];
  for (let offset = 364; offset >= 0; offset -= 1) {
    const date = localDateKey(shiftDays(now, -offset));
    const observed = heatByDate.get(date);
    const tokens = observed?.tokens ?? 0;
    cells.push({
      date,
      tokens,
      turns: observed?.turns ?? 0,
      level: tokens === 0 ? 0 : Math.min(4, Math.ceil((tokens / max) * 4)),
      isToday: date === today,
    });
  }
  const monthTicks: Array<{ label: string; column: number }> = [];
  cells.forEach((cell, index) => {
    const month = Number(cell.date.slice(5, 7)) - 1;
    const previous = index > 0 ? Number(cells[index - 1].date.slice(5, 7)) - 1 : -1;
    if (month !== previous) monthTicks.push({ label: MONTHS[month], column: Math.floor(index / 7) });
  });

  // --- Trend: top 5 models by total, values aligned to the observed dates. -
  const trend = buildTrend(summary.dailyByModel);

  // --- Diagnostics: passthrough plus the concentration flag. --------------
  const diagnostics = {
    ...summary.diagnostics,
    top5Concentrated: summary.diagnostics.top5SessionShare > STATS_CONCENTRATION_THRESHOLD,
  };

  // --- Accessibility summaries: real numbers, formatted by the consumer. --
  const heatTotal = summary.heatmap.reduce((sum, day) => sum + day.tokens, 0);
  const heatPeak = summary.heatmap.reduce<{ date: string | null; tokens: number }>(
    (best, day) => (day.tokens > best.tokens ? { date: day.date, tokens: day.tokens } : best),
    { date: null, tokens: 0 },
  );

  const exportRows = {
    daily: [
      ["date", "tokens"],
      ...daily.map((day) => [day.date, String(day.tokens)]),
    ],
    modelUsage: [
      ["modelId", "tokens", "share"],
      ...models.map((model) => [model.modelId, String(model.tokens), model.share.toFixed(4)]),
    ],
    projectUsage: [
      ["projectId", "projectName", "tokens", "share"],
      ...projectUsage.map((project) => [
        project.projectId === null ? "" : String(project.projectId),
        project.projectName ?? "",
        String(project.tokens),
        project.share.toFixed(4),
      ]),
    ],
    diagnostics: [
      ["metric", "value"],
      ["cacheLeverage", String(diagnostics.cacheLeverage)],
      ["cacheReadTokens", String(diagnostics.cacheReadTokens)],
      ["largeContextTurnShare", String(diagnostics.largeContextTurnShare)],
      ["top5SessionShare", String(diagnostics.top5SessionShare)],
    ],
    topSessions: [
      ["sessionId", "title", "tokens", "turnCount", "lastActiveMs"],
      ...sessions.map((session) => [
        session.sessionId,
        session.title ?? "",
        String(session.tokens),
        String(session.turnCount),
        String(session.lastActiveMs),
      ]),
    ],
  };

  return {
    range: { days: rangeDays, startMs: summary.range.startMs, endMs: summary.range.endMs },
    scope: { projectId: summary.scope.projectId },
    generatedAt: summary.generatedAt,
    cards: summary.cards,
    totals: {
      totalTokens: summary.cards.totalTokens,
      sessionCount: summary.cards.sessionCount,
      turnCount: summary.cards.turnCount,
    },
    daily,
    dailyByModel: summary.dailyByModel,
    models,
    projectUsage,
    heatmap: { cells, max, today, monthTicks },
    trend,
    peakDay,
    diagnostics,
    topSessions: sessions,
    aria: {
      heatmap: {
        days: cells.length,
        totalTokens: heatTotal,
        peakTokens: heatPeak.tokens,
        peakDate: heatPeak.date,
      },
      trend: {
        days: rangeDays,
        totalTokens: summary.cards.totalTokens,
        peakTokens: trend.peak,
        peakDate: peakDay.date,
      },
    },
    exportMeta: {
      rangeDays,
      generatedAtIso: new Date(summary.generatedAt).toISOString(),
      scope: summary.scope.projectId === null ? "all" : String(summary.scope.projectId),
    },
    exportRows,
  };
}

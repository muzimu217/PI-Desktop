/**
 * StatsDataset unit tests.
 *
 * The dataset layer is the only place the usage page turns an RPC response
 * into the numbers its three consumers (SVG, `sr-only` tables, export) read,
 * so these tests exercise it as a pure function: every case builds a summary
 * by hand and asserts the projected shape. The clock is injected, which keeps
 * the heatmap's local-date window deterministic in any timezone.
 *
 * Local-date keys are the point of the timezone regression: the host buckets
 * turns with `stats.rs::local_date`, so a UTC-derived key would shift each
 * day's 00:00–08:00 spend (UTC+8) into the previous heatmap column.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readStatsSource } from "./helpers/source-contracts.mjs";
import {
  STATS_CONCENTRATION_THRESHOLD,
  buildStatsDataset,
  buildTrend,
  cumulativeSeries,
  localDateKey,
  niceCeil,
  sliceRecent,
  weeklyBuckets,
} from "../src/components/settings/stats/dataset.ts";

const DAY_MS = 86_400_000;

/** Local date key for `date` shifted by `days`, independent of the test TZ. */
function keyAt(date, days = 0) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return localDateKey(next);
}

const END = new Date(2026, 2, 10, 12, 0, 0); // local 2026-03-10 12:00
const NOW = new Date(2026, 2, 10, 9, 30, 0);

function summary(overrides = {}) {
  const base = {
    range: { startMs: END.getTime() - 7 * DAY_MS, endMs: END.getTime() },
    scope: { projectId: null },
    cards: {
      totalTokens: 700,
      peakDayTokens: 400,
      peakDayDate: keyAt(END, -2),
      longestChatMs: 3_600_000,
      currentStreakDays: 3,
      longestStreakDays: 9,
      sessionCount: 4,
      turnCount: 12,
    },
    diagnostics: {
      cacheLeverage: 0.5,
      cacheReadTokens: 1200,
      largeContextTurnShare: 0.25,
      top5SessionShare: 0.4,
    },
    dailyTotals: [
      { date: keyAt(END, -2), tokens: 400 },
      { date: keyAt(END), tokens: 300 },
    ],
    dailyByModel: [
      { date: keyAt(END, -2), modelId: "alpha", tokens: 400 },
      { date: keyAt(END), modelId: "alpha", tokens: 200 },
      { date: keyAt(END), modelId: "beta", tokens: 100 },
    ],
    modelUsage: [
      { modelId: "beta", tokens: 100, share: 100 / 700 },
      { modelId: "alpha", tokens: 600, share: 600 / 700 },
    ],
    projectUsage: [
      { projectId: 7, projectName: "workbuddy", tokens: 500, share: 500 / 700 },
      { projectId: null, projectName: null, tokens: 200, share: 200 / 700 },
    ],
    heatmap: [
      { date: keyAt(END, -1), tokens: 50, turns: 2 },
      { date: keyAt(END), tokens: 200, turns: 5 },
    ],
    generatedAt: END.getTime(),
  };
  return { ...base, ...overrides };
}

const SESSIONS = [
  {
    sessionId: "s1",
    title: "First",
    tokens: 500,
    turnCount: 7,
    lastActiveMs: END.getTime() - 60_000,
  },
  {
    sessionId: "s2",
    title: null,
    tokens: 200,
    turnCount: 3,
    lastActiveMs: 0,
  },
];

test("localDateKey builds YYYY-MM-DD from local components, not UTC", () => {
  // A local-time constructor is unambiguous: midnight-local must stay on its
  // own local day regardless of the machine's UTC offset.
  assert.equal(localDateKey(new Date(2026, 0, 1, 0, 0, 0)), "2026-01-01");
  assert.equal(localDateKey(new Date(2026, 11, 31, 23, 59, 0)), "2026-12-31");
  // Pads single-digit months and days.
  assert.equal(localDateKey(new Date(2026, 8, 5, 12, 0, 0)), "2026-09-05");
});

test("daily series is sorted ascending and gap-filled across the range", () => {
  const dataset = buildStatsDataset(summary(), SESSIONS, NOW);
  assert.equal(dataset.range.days, 7);
  assert.equal(dataset.daily.length, 7);
  const dates = dataset.daily.map((day) => day.date);
  assert.deepEqual(dates, [...dates].sort());
  // Sparse input: only the two reported days carry tokens, the rest read 0.
  assert.equal(dataset.daily.find((d) => d.date === keyAt(END, -2))?.tokens, 400);
  assert.equal(dataset.daily.find((d) => d.date === keyAt(END))?.tokens, 300);
  assert.equal(dataset.daily.filter((d) => d.tokens === 0).length, 5);
});

test("models are sorted by tokens descending and shares renormalise to 1", () => {
  const dataset = buildStatsDataset(summary(), SESSIONS, NOW);
  assert.deepEqual(
    dataset.models.map((model) => model.modelId),
    ["alpha", "beta"],
  );
  const share = dataset.models.reduce((sum, model) => sum + model.share, 0);
  assert.ok(Math.abs(share - 1) < 1e-9, `shares sum to ${share}`);
  assert.equal(dataset.models[0].share, 600 / 700);
});

test("zero-total model usage yields zero shares instead of NaN", () => {
  const dataset = buildStatsDataset(
    summary({ modelUsage: [{ modelId: "alpha", tokens: 0, share: 0 }] }),
    SESSIONS,
    NOW,
  );
  assert.equal(dataset.models[0].share, 0);
});

test("peak day consumes the frozen card date and token fields", () => {
  const dataset = buildStatsDataset(summary(), SESSIONS, NOW);
  assert.equal(dataset.peakDay.date, keyAt(END, -2));
  assert.equal(dataset.peakDay.tokens, 400);
});

test("peak day date is derived from the series when the host leaves it null", () => {
  const dataset = buildStatsDataset(
    summary({ cards: { ...summary().cards, peakDayDate: null, peakDayTokens: 0 } }),
    SESSIONS,
    NOW,
  );
  assert.equal(dataset.peakDay.date, keyAt(END, -2));
  assert.equal(dataset.peakDay.tokens, 400);
});

test("diagnostics flag top-5 concentration above the watch threshold", () => {
  const concentrated = buildStatsDataset(summary(), SESSIONS, NOW);
  assert.equal(concentrated.diagnostics.top5Concentrated, true);
  assert.equal(STATS_CONCENTRATION_THRESHOLD, 0.35);

  const spread = buildStatsDataset(
    summary({ diagnostics: { ...summary().diagnostics, top5SessionShare: 0.2 } }),
    SESSIONS,
    NOW,
  );
  assert.equal(spread.diagnostics.top5Concentrated, false);
});

test("heatmap is 365 local-date cells ending today with exactly one today flag", () => {
  const dataset = buildStatsDataset(summary(), SESSIONS, NOW);
  const { cells, today, max } = dataset.heatmap;
  assert.equal(cells.length, 365);
  assert.equal(today, localDateKey(NOW));
  assert.equal(cells[cells.length - 1].date, localDateKey(NOW));
  assert.equal(cells.filter((cell) => cell.isToday).length, 1);
  assert.equal(cells[cells.length - 1].isToday, true);
  // Heatmap values come from the host window, keyed by local date.
  assert.equal(cells.find((c) => c.date === keyAt(NOW, -1))?.tokens, 50);
  assert.equal(cells.find((c) => c.date === keyAt(NOW, 0))?.tokens, 200);
  assert.equal(max, 200);
});

test("heatmap levels scale 0..4 with empty cells pinned to 0", () => {
  const dataset = buildStatsDataset(summary(), SESSIONS, NOW);
  const { cells } = dataset.heatmap;
  const empty = cells.find((cell) => cell.tokens === 0);
  const peak = cells.find((cell) => cell.tokens === 200);
  assert.equal(empty?.level, 0);
  assert.equal(peak?.level, 4);
  assert.ok(cells.every((cell) => cell.level >= 0 && cell.level <= 4));
});

test("heatmap month ticks advance by column", () => {
  const dataset = buildStatsDataset(summary(), SESSIONS, NOW);
  const ticks = dataset.heatmap.monthTicks;
  assert.ok(ticks.length > 0);
  assert.ok(ticks.every((tick, index) => index === 0 || tick.column >= ticks[index - 1].column));
});

test("trend keeps the top five models by total and a nice-ceil axis", () => {
  const many = Array.from({ length: 7 }, (_, index) => ({
    date: keyAt(END, -index),
    modelId: `m${index}`,
    tokens: (index + 1) * 100,
  }));
  const dataset = buildStatsDataset(summary({ dailyByModel: many }), SESSIONS, NOW);
  assert.equal(dataset.trend.series.length, 5);
  assert.deepEqual(
    dataset.trend.series.map((entry) => entry.modelId),
    ["m6", "m5", "m4", "m3", "m2"],
  );
  assert.equal(dataset.trend.axisMax, niceCeil(700));
  assert.equal(dataset.trend.axisMax, 1000);
  // Totals align index-for-index with the sorted date list.
  assert.equal(dataset.trend.totals.length, dataset.trend.dates.length);
  assert.equal(
    dataset.trend.totals[dataset.trend.dates.indexOf(keyAt(END))],
    100,
  );
});

test("niceCeil rounds up to 1/2/2.5/5 x 10^n", () => {
  assert.equal(niceCeil(0), 1);
  assert.equal(niceCeil(1), 1);
  assert.equal(niceCeil(1.5), 2);
  assert.equal(niceCeil(2.1), 2.5);
  assert.equal(niceCeil(3), 5);
  assert.equal(niceCeil(700), 1000);
  assert.equal(niceCeil(180_000), 200_000);
});

test("aria summaries carry the real numbers behind each chart label", () => {
  const dataset = buildStatsDataset(summary(), SESSIONS, NOW);
  assert.deepEqual(dataset.aria.heatmap, {
    days: 365,
    totalTokens: 250,
    peakTokens: 200,
    peakDate: keyAt(END),
  });
  assert.equal(dataset.aria.trend.days, 7);
  assert.equal(dataset.aria.trend.totalTokens, 700);
  assert.equal(dataset.aria.trend.peakTokens, 400);
  assert.equal(dataset.aria.trend.peakDate, keyAt(END, -2));
});

test("export rows cover every section with a header and metadata", () => {
  const dataset = buildStatsDataset(summary(), SESSIONS, NOW);
  const { exportRows, exportMeta } = dataset;
  assert.equal(exportMeta.rangeDays, 7);
  assert.equal(exportMeta.scope, "all");
  assert.equal(exportMeta.generatedAtIso, new Date(END.getTime()).toISOString());

  assert.deepEqual(exportRows.daily[0], ["date", "tokens"]);
  assert.equal(exportRows.daily.length, 8); // header + 7 filled days
  assert.deepEqual(exportRows.modelUsage[0], ["modelId", "tokens", "share"]);
  assert.deepEqual(exportRows.projectUsage[0], ["projectId", "projectName", "tokens", "share"]);
  assert.deepEqual(exportRows.diagnostics[0], ["metric", "value"]);
  assert.equal(
    exportRows.diagnostics.find((row) => row[0] === "top5SessionShare")[1],
    "0.4",
  );
  assert.deepEqual(exportRows.topSessions[0], [
    "sessionId",
    "title",
    "tokens",
    "turnCount",
    "lastActiveMs",
  ]);
  assert.equal(exportRows.topSessions[1][0], "s1");
  assert.equal(exportRows.topSessions[2][1], ""); // null title stays empty
});

test("project scope is exported as its id, not 'all'", () => {
  const dataset = buildStatsDataset(
    summary({ scope: { projectId: 42 } }),
    SESSIONS,
    NOW,
  );
  assert.equal(dataset.exportMeta.scope, "42");
  assert.equal(dataset.scope.projectId, 42);
});

test("dataset is pure: two builds from one summary are deep-equal", () => {
  const source = summary();
  const first = buildStatsDataset(source, SESSIONS, NOW);
  const second = buildStatsDataset(source, SESSIONS, NOW);
  assert.deepEqual(first, second);
});

// --- Source contract: the page must consume the dataset, not re-walk it. ---
//
// The page is one facade plus a `stats/` module per chart, so the contract is
// asserted over the whole surface (`readStatsSource`). The two activity views
// are also read on their own where a test depends on the order the code was
// written in, which a directory-wide concatenation cannot preserve.

const page = await readStatsSource();
const api = await readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8");
const readStatsModule = (name) =>
  readFile(new URL(`../src/components/settings/stats/${name}`, import.meta.url), "utf8");
const weeklySource = await readStatsModule("WeeklyActivity.tsx");
const cumulativeSource = await readStatsModule("CumulativeActivity.tsx");
const trendSource = await readStatsModule("Trend.tsx");

test("StatsPage renders heatmap cells from the dataset, not a UTC date key", () => {
  assert.match(page, /buildStatsDataset/);
  assert.match(page, /import \{[\s\S]*buildStatsDataset[\s\S]*\} from "\.\/stats\/dataset"/);
  // The timezone regression: the old cell loop sliced toISOString().
  assert.doesNotMatch(page, /date\.toISOString\(\)\.slice\(0, 10\)/);
});

test("today's heatmap column carries the stats-heat-today hook class", () => {
  assert.match(page, /stats-heat-today/);
  assert.match(page, /isToday && "stats-heat-today"/);
});

test("heatmap cells carry the per-day turn counts from the host", () => {
  const dataset = buildStatsDataset(summary(), SESSIONS, NOW);
  const { cells } = dataset.heatmap;
  assert.equal(cells.find((cell) => cell.date === keyAt(NOW, -1))?.turns, 2);
  assert.equal(cells.find((cell) => cell.date === keyAt(NOW, 0))?.turns, 5);
  // Days the host did not report read zero turns, never undefined/NaN.
  assert.equal(cells.find((cell) => cell.tokens === 0)?.turns, 0);
  assert.ok(cells.every((cell) => Number.isInteger(cell.turns) && cell.turns >= 0));
});

test("weeklyBuckets returns no buckets for an empty series", () => {
  assert.deepEqual(weeklyBuckets([]), []);
});

test("weeklyBuckets groups a single day into its ISO week (Monday start)", () => {
  // 2026-03-10 is a Tuesday; its ISO week starts Monday 2026-03-09.
  const buckets = weeklyBuckets([{ date: "2026-03-10", tokens: 400 }]);
  assert.deepEqual(buckets, [{ start: "2026-03-09", end: "2026-03-10", tokens: 400, turns: 0 }]);
});

test("weeklyBuckets sums whole weeks and stays stable across a year boundary", () => {
  // 2024-12-30 is a Monday, 2025-01-05 the Sunday of the same ISO week —
  // the bucket spans New Year without splitting.
  const buckets = weeklyBuckets([
    { date: "2024-12-30", tokens: 10 },
    { date: "2024-12-31", tokens: 20 },
    { date: "2025-01-01", tokens: 30 },
    { date: "2025-01-05", tokens: 40 },
    { date: "2025-01-06", tokens: 50 },
  ]);
  assert.deepEqual(buckets, [
    { start: "2024-12-30", end: "2025-01-05", tokens: 100, turns: 0 },
    { start: "2025-01-06", end: "2025-01-06", tokens: 50, turns: 0 },
  ]);
});

test("weeklyBuckets carries the daily turn counts into the week bucket", () => {
  // The heatmap cells report turns; the weekly tooltip reads them straight off
  // the bucket, so the sum has to survive the aggregation (and stay 0 when the
  // source — e.g. stats.dailyTotals — has no turn count at all).
  const buckets = weeklyBuckets([
    { date: "2026-03-09", tokens: 100, turns: 2 },
    { date: "2026-03-10", tokens: 300, turns: 5 },
    { date: "2026-03-11", tokens: 50 },
  ]);
  assert.deepEqual(buckets, [
    { start: "2026-03-09", end: "2026-03-11", tokens: 450, turns: 7 },
  ]);
});

test("weeklyBuckets conserves the total across 365 days", () => {
  const days = Array.from({ length: 365 }, (_, index) => {
    const date = new Date(2026, 2, 10, 12);
    date.setDate(date.getDate() - (364 - index));
    return { date: localDateKey(date), tokens: index + 1 };
  });
  const buckets = weeklyBuckets(days);
  assert.equal(
    buckets.reduce((sum, bucket) => sum + bucket.tokens, 0),
    days.reduce((sum, day) => sum + day.tokens, 0),
  );
  assert.ok(buckets.length > 50 && buckets.length <= 54, `${buckets.length} weekly buckets`);
});

test("cumulativeSeries returns an empty series for empty input", () => {
  assert.deepEqual(cumulativeSeries([]), []);
});

test("cumulativeSeries accumulates a running total and preserves dates", () => {
  assert.deepEqual(
    cumulativeSeries([{ date: "2026-03-10", tokens: 5 }]),
    [{ date: "2026-03-10", tokens: 5 }],
  );
  assert.deepEqual(
    cumulativeSeries([
      { date: "2026-03-08", tokens: 1 },
      { date: "2026-03-09", tokens: 2 },
      { date: "2026-03-10", tokens: 4 },
    ]).map((point) => point.tokens),
    [1, 3, 7],
  );
});

test("sliceRecent keeps the last N distinct dates of a longer series", () => {
  const points = Array.from({ length: 30 }, (_, index) => ({
    date: `2026-01-${String(index + 1).padStart(2, "0")}`,
    tokens: index,
  }));
  const recent = sliceRecent(7, points);
  assert.equal(recent.length, 7);
  assert.equal(recent[0].date, "2026-01-24");
  assert.equal(recent[6].date, "2026-01-30");
});

test("sliceRecent keeps every row of a kept day (per-model rows stay aligned)", () => {
  const byModel = [
    { date: "2026-01-01", modelId: "a", tokens: 1 },
    { date: "2026-01-02", modelId: "a", tokens: 2 },
    { date: "2026-01-02", modelId: "b", tokens: 3 },
    { date: "2026-01-03", modelId: "a", tokens: 4 },
  ];
  const recent = sliceRecent(2, byModel);
  assert.deepEqual(recent, byModel.slice(1));
});

test("sliceRecent keeps everything when the series is shorter than the window", () => {
  const points = [{ date: "2026-01-01", tokens: 1 }, { date: "2026-01-02", tokens: 2 }];
  assert.deepEqual(sliceRecent(7, points), points);
});

test("sliceRecent returns empty for empty input or a non-positive window", () => {
  assert.deepEqual(sliceRecent(7, []), []);
  assert.deepEqual(sliceRecent(0, [{ date: "2026-01-01", tokens: 1 }]), []);
});

test("trend rebuilt from a sliced window scales its own axis", () => {
  const full = buildTrend(
    Array.from({ length: 30 }, (_, index) => ({
      date: `2026-01-${String(index + 1).padStart(2, "0")}`,
      modelId: "alpha",
      tokens: (index + 1) * 100,
    })),
  );
  assert.equal(full.dates.length, 30);
  assert.equal(full.peak, 3000);
  assert.equal(full.axisMax, niceCeil(3000));
  const recent = buildTrend(sliceRecent(7, full.dates.map((date, index) => ({
    date,
    modelId: "alpha",
    tokens: (index + 1) * 100,
  }))));
  assert.equal(recent.dates.length, 7);
  assert.equal(recent.peak, 3000);
  assert.equal(recent.totals.at(-1), 3000);
});

test("heatmap and trend expose sr-only data tables", () => {
  assert.match(page, /className="stats-sr-table sr-only"/);
  assert.match(page, /stats\.heatmapTableCaption/);
  assert.match(page, /stats\.trendTableCaption/);
  assert.match(page, /<caption>/);
});

test("top session rows are buttons that open the session", () => {
  assert.match(page, /selectSession/);
  assert.match(page, /className="settings-row stats-session-row"/);
  assert.match(page, /stats\.openSession/);
  assert.match(page, /stats\.turns/);
  assert.match(page, /stats\.lastActive/);
});

test("load failures branch on the host error code", () => {
  assert.match(page, /HOST_UNAVAILABLE/);
  assert.match(page, /stats\.loadErrorHost/);
  assert.match(page, /stats\.loadError\b/);
});

test("refresh forces a cache-bypassing stats read", () => {
  assert.match(api, /statsSummary: \([\s\S]*?opts\?: \{ force\?: boolean \}/);
  assert.match(page, /api\.statsSummary\(days, project, \{ force \}\)/);
  assert.match(page, /load\(range, projectId, true\)/);
});

test("CSV export is sectioned with a metadata header", () => {
  assert.match(page, /# range: \$\{exportMeta\.rangeDays\}, generatedAt: \$\{exportMeta\.generatedAtIso\}, scope: \$\{exportMeta\.scope\}/);
  for (const section of [
    "daily",
    "modelUsage",
    "projectUsage",
    "diagnostics",
    "topSessions",
  ]) {
    assert.match(page, new RegExp(`\\["${section}", exportRows\\.${section}\\]`));
  }
});

test("heatmap hover uses the rich stats-tooltip, not a <title>", () => {
  // The native <title> would stack with the styled bubble; it must be gone.
  assert.doesNotMatch(page, /<title>/);
  assert.match(page, /stats-tooltip/);
  assert.match(page, /stats\.tooltipTurns/);
  assert.match(page, /formatFullDate/);
});

test("activity card switches daily/weekly/cumulative granularity in the renderer", () => {
  assert.match(page, /stats\.granularityDaily/);
  assert.match(page, /stats\.granularityWeekly/);
  assert.match(page, /stats\.granularityCumulative/);
  assert.match(page, /setGranularity/);
  // Both alternative shapes derive from the same dataset cells — no new RPC.
  assert.match(page, /weeklyBuckets/);
  assert.match(page, /cumulativeSeries/);
});

test("trend card owns a 7/30-day slice independent of the global range", () => {
  assert.match(page, /buildTrend\(sliceRecent\(trendRange, dataset\.dailyByModel\)\)/);
  assert.match(page, /setTrendRange\(days\)/);
  assert.match(page, /setTrendRange\(range\)/);
});

test("trend legend sits above the plot with a hover crosshair readout", () => {
  assert.match(page, /stats-trend-crosshair/);
  assert.match(page, /stats-trend-marker/);
  const legendAt = trendSource.indexOf('"stats-trend-legend"');
  const svgAt = trendSource.indexOf('"stats-trend"');
  assert.ok(legendAt !== -1 && svgAt !== -1 && legendAt < svgAt, "legend must render before the svg");
});

test("tooltip styles are token-based and cannot steal the hover", async () => {
  const css = await readFile(
    new URL("../src/styles/settings.css", import.meta.url),
    "utf8",
  );
  const start = css.indexOf(".stats-tooltip {");
  assert.ok(start !== -1, ".stats-tooltip rule missing");
  const block = css.slice(start, css.indexOf("}", start));
  assert.match(block, /position: absolute/);
  assert.match(block, /pointer-events: none/);
  assert.match(block, /var\(--radius-sm\)/);
  assert.match(block, /var\(--ds-raised\)/);
  assert.match(block, /var\(--text-/);
  // The chart panel must let the bubble escape the tile edge.
  assert.match(css, /\.stats-chart-panel \{[\s\S]*?overflow: visible/);
});

test("y-axis stops stay distinct at every magnitude", () => {
  // A quarter-stop axis printed "0, 0, 1, 1, 1" once the totals were single
  // digit, so the step is derived from the top and the top stop is always the
  // real maximum (the axis is capped by the data, not floating above it).
  assert.match(page, /function axisTicks\(axisMax: number\)/);
  assert.match(page, /values\.push\(axisMax\)/);
  // The baseline label is now the axis' own 0 stop — the bar view used to draw
  // its "0" at y = bottom + 14 inside a 126-unit viewBox, which clipped it into
  // a stray "^" under the plot.
  assert.doesNotMatch(page, /y=\{bottom \+ 14\} textAnchor="start">\s*0/);
});

test("weekly and cumulative views share one axis frame and hover readout", () => {
  // Both alternative shapes of the activity card have to be as legible as the
  // daily grid: a labelled y-axis, a month row, x-axis week/day labels and a
  // hover bubble. They reuse the trend chart's axis/crosshair classes on
  // purpose, so the page keeps a single chart vocabulary.
  assert.match(page, /const ACTIVITY_VIEW = \{/);
  assert.match(page, /<AxisGrid ticks=\{axisTicks\(/);
  assert.match(page, /monthTicksFor\(/);
  assert.match(page, /axisLabelIndices\(/);
  assert.match(page, /stats-week-track/);
  assert.match(page, /stats-week-bar-active/);
  assert.match(page, /stats-cumulative-line/);
  assert.match(page, /stats\.dayDelta/);

  // Each view owns its crosshair, marker and bubble inside its own positioned
  // plot wrapper — a bubble hoisted to the daily grid would never fire here.
  for (const source of [weeklySource, cumulativeSource]) {
    assert.match(source, /stats-trend-crosshair/);
    assert.match(source, /className="stats-trend-plot" ref=\{plotRef\}/);
    assert.match(source, /className="stats-tooltip"/);
  }
});

test("the weekly bar view keeps empty weeks visible and reads turns", () => {
  const body = weeklySource;
  // A sparse year (one active week out of ~53) must not render as a single bar
  // floating in an empty card: every week gets its own track.
  assert.match(body, /className="stats-week-track"/);
  assert.match(body, /height=\{bottom - top\}/);
  assert.match(body, /stats\.tooltipTurns/);
  // And the daily cells' turn counts reach the bucket (see the dataset test).
  assert.match(page, /tokens, turns \}\) => \(\{ date, tokens, turns \}\)/);
});

// --- Source contract: the audit's residual gaps (project breakdown, empty
// --- state, provenance) stay closed. -----------------------------------------

test("project usage slices are descending with shares renormalised to 1", () => {
  const dataset = buildStatsDataset(
    summary({
      projectUsage: [
        { projectId: 3, projectName: "gamma", tokens: 100, share: 0 },
        { projectId: 1, projectName: "alpha", tokens: 500, share: 0 },
        { projectId: null, projectName: null, tokens: 200, share: 0 },
      ],
    }),
    SESSIONS,
    NOW,
  );
  // Descending by tokens, and the host's null project keeps its null id so the
  // render layer — not the dataset — decides how to label it.
  assert.deepEqual(
    dataset.projectUsage.map((project) => project.projectId),
    [1, null, 3],
  );
  assert.equal(dataset.projectUsage[1].projectName, null);
  const total = dataset.projectUsage.reduce((sum, project) => sum + project.share, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `shares renormalise to 1, got ${total}`);
});

test("project breakdown folds the tail into Other and labels the null project", async () => {
  const projectSource = await readStatsModule("ProjectUsage.tsx");
  assert.match(projectSource, /const PROJECT_USAGE_TOP = 8;/);
  // The tail is folded only when it carries tokens, so an all-zero range does
  // not grow a mystery "Other 0%" row.
  assert.match(projectSource, /if \(rest\.length > 0 && otherTokens > 0\)/);
  assert.match(projectSource, /t\("stats\.projectUsageOther"\)/);
  assert.match(projectSource, /project\.projectName \?\? t\("stats\.noProject"\)/);
  assert.match(projectSource, /className="stats-usage-fill"/);
  // The page renders the card full-width, ahead of the top-sessions list.
  assert.match(page, /t\("stats\.projectUsage"\)/);
  assert.match(page, /<ProjectUsage projects=\{dataset\.projectUsage\} \/>/);
  assert.ok(
    page.indexOf('t("stats.projectUsage")') < page.indexOf('t("stats.topSessions")'),
    "the project breakdown renders before the top-sessions list",
  );
});

test("a range with no completed turns renders the whole-page empty state", () => {
  // Keyed on turnCount, not on the sessions list: a project filter can leave
  // turns behind while the top-session list is empty, and that quieter per-card
  // row has to survive.
  assert.match(page, /if \(summary\.cards\.turnCount === 0\) \{/);
  assert.match(page, /t\("stats\.emptyTitle"\)/);
  assert.match(page, /t\("stats\.emptyDesc"\)/);
  assert.match(page, /t\("stats\.emptyAction"\)/);
  // The CTA uses the same nav entry as the settings rail's back-to-app button.
  assert.match(page, /const setPage = useAppStore\(\(state\) => state\.setPage\)/);
  assert.match(page, /setPage\("chat"\)/);
});

test("the loading posture answers the privacy question", () => {
  assert.match(page, /className="stats-loading-notes"/);
  assert.match(page, /t\("stats\.loadingPrivacy"\)/);
});

test("the provenance footer carries freshness and covered fields", () => {
  assert.match(page, /formatLastActive\(dataset\.generatedAt, locale\)/);
  assert.match(page, /t\("stats\.lastUpdated", \{ time: updatedAgo \}\)/);
  assert.match(page, /t\("stats\.provenanceFields"\)/);
});

test("the host's null-model bucket is localised at render time only", () => {
  // The dataset keeps the raw host id, so the CSV/JSON export stays
  // locale-independent; only the legend, tooltip and sr table translate it.
  const dataset = buildStatsDataset(summary(), SESSIONS, NOW);
  assert.ok(dataset.models.every((model) => model.modelId !== "Other models"));
  assert.match(page, /export const OTHER_MODEL_ID = "other";/);
  assert.match(page, /modelId === OTHER_MODEL_ID \? t\("stats\.modelUsageOther"\) : modelId/);
});

test("the donut's accessible name summarises its own shares", () => {
  assert.match(page, /const ariaLabel =/);
  assert.match(page, /aria-label=\{ariaLabel\}/);
  // Not the trend summary: it speaks about days and peaks, not proportions.
  assert.doesNotMatch(page, /aria-label=\{ariaSummary\}/);
});

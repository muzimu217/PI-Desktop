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
import {
  STATS_CONCENTRATION_THRESHOLD,
  buildStatsDataset,
  localDateKey,
  niceCeil,
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
      { date: keyAt(END, -1), tokens: 50 },
      { date: keyAt(END), tokens: 200 },
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

const page = await readFile(
  new URL("../src/components/settings/StatsPage.tsx", import.meta.url),
  "utf8",
);
const api = await readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8");

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

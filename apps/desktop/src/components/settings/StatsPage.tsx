import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  StatsDayModel,
  StatsDayTotal,
  StatsSummary,
  StatsTopSession,
} from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { Button, cx } from "../ui";
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
  return (
    <svg className="stats-heatmap" viewBox="0 0 640 126" role="img" aria-label={t("stats.heatmapAria")}>
      {monthTicks.map((tick, position) => {
        // One label per month would collide at 12px columns; keep every other
        // tick so the axis stays readable at any window width.
        if (position % 2 === 1) return null;
        return (
          <text
            key={`${tick.label}-${tick.column}`}
            className="stats-heat-month"
            x={tick.column * 12}
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
            x={Math.floor(index / 7) * 12}
            y={16 + (index % 7) * 12}
            width={10}
            height={10}
          >
            <title>{`${cell.date}: ${cell.tokens}`}</title>
          </rect>
        );
      })}
      <text className="stats-heat-axis" x={0} y={120}>{t("stats.heatLow")}</text>
      <g transform="translate(64, 116)">
        {[0, 1, 2, 3, 4].map((level) => (
          <rect key={level} className={`stats-heat-cell stats-heat-${level}`} x={level * 12} y={0} width={10} height={10} />
        ))}
      </g>
      <text className="stats-heat-axis" x={132} y={120}>{t("stats.heatHigh")}</text>
    </svg>
  );
}

function Trend({ days }: { days: StatsDayModel[] }) {
  const { t } = useTranslation();
  const byDate = useMemo(() => {
    const map = new Map<string, number>();
    for (const day of days) map.set(day.date, (map.get(day.date) ?? 0) + day.tokens);
    return map;
  }, [days]);
  const values = [...byDate.values()];
  const max = Math.max(1, ...values);
  const points = [...byDate.entries()]
    .map(([, tokens], index) => {
      const x = (index / Math.max(1, values.length - 1)) * 100;
      const y = 100 - (tokens / max) * 100;
      return `${x},${y}`;
    })
    .join(" ");
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="stats-trend" role="img" aria-label={t("stats.trendAria")}>
      <polyline points={points} className="stats-trend-line" fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Donut({ models }: { models: StatsSummary["modelUsage"] }) {
  const total = models.reduce((sum, model) => sum + model.tokens, 0) || 1;
  let offset = 0;
  return (
    <div className="stats-donut-wrap">
      <svg viewBox="0 0 42 42" className="stats-donut" role="img" aria-hidden="true">
        {models.slice(0, 6).map((model, index) => {
          const fraction = model.tokens / total;
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
      </svg>
      <ul className="stats-legend">
        {models.slice(0, 6).map((model) => (
          <li key={model.modelId}>
            <span>{model.modelId}</span>
            <span>{Math.round(model.share * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function StatsPage() {
  const { t } = useTranslation();
  const [range, setRange] = useState<Range>(30);
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const load = useCallback(async (days: Range) => {
    setState({ kind: "loading" });
    try {
      const [summary, top] = await Promise.all([
        api.statsSummary(days),
        api.statsTopSessions(days),
      ]);
      setState({ kind: "ready", summary, sessions: top.sessions ?? [] });
    } catch {
      setState({ kind: "error" });
    }
  }, []);

  useEffect(() => {
    void load(range);
  }, [load, range]);

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
              <Button onClick={() => void load(range)}>{t("index.retry")}</Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const { summary, sessions } = state;
  const { cards, diagnostics } = summary;
  return (
    <div className="settings-stack">
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
        <Button variant="ghost" aria-label={t("stats.refresh")} onClick={() => void load(range)}>
          <IconRefresh size={14} />
        </Button>
        <Button variant="ghost" onClick={() => download(summary, sessions, "csv")}>
          {t("stats.exportCsv")}
        </Button>
        <Button variant="ghost" onClick={() => download(summary, sessions, "json")}>
          {t("stats.exportJson")}
        </Button>
      </div>

      <div className="idx-grid">
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

      <section className="settings-card-block">
        <h3 className="settings-card-heading">{t("stats.activity")}</h3>
        <div className="settings-panel">
          <Heatmap days={summary.heatmap} />
          <Trend days={summary.dailyByModel as StatsDayModel[]} />
        </div>
      </section>

      <div className="idx-grid">
        <div className="idx-tile">
          <div className="idx-tile-head">
            <span className="idx-chip idx-chip-accent" aria-hidden="true">
              <IconPieChart size={14} />
            </span>
            <span className="idx-tile-label">{t("stats.modelUsage")}</span>
          </div>
          <Donut models={summary.modelUsage} />
        </div>
        <div className="idx-tile">
          <div className="idx-tile-head">
            <span className="idx-chip idx-chip-warning" aria-hidden="true">
              <IconSparkles size={14} />
            </span>
            <span className="idx-tile-label">{t("stats.insights")}</span>
          </div>
          <ul className="stats-insights">
            <li>
              <span>{t("stats.cacheLeverage")}</span>
              <span>{Math.round(diagnostics.cacheLeverage * 100)}%</span>
            </li>
            <li>
              <span>{t("stats.largeContext")}</span>
              <span>{Math.round(diagnostics.largeContextTurnShare * 100)}%</span>
            </li>
            <li>
              <span>{t("stats.top5Share")}</span>
              <span className={cx(diagnostics.top5SessionShare > 0.35 && "idx-status warn")}>
                {Math.round(diagnostics.top5SessionShare * 100)}%
              </span>
            </li>
          </ul>
        </div>
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

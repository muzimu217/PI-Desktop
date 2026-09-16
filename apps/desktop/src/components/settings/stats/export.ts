import type { StatsSummary, StatsTopSession } from "@pi-desktop/shared";
import type { StatsDataset } from "./dataset";

/**
 * CSV / JSON export of the current stats view.
 *
 * Rows come from the dataset (never from the rendered charts), so the exported
 * file matches the on-screen numbers exactly.
 */

/** Quote a CSV field only when it contains a delimiter, quote, or newline. */
function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function download(
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

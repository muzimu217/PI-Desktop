import { useTranslation } from "react-i18next";
import type { StatsProjectSlice } from "./dataset";
import { formatTokens } from "./format";

/**
 * Project breakdown card: one share bar per project over the scoped window.
 *
 * `dataset.projectUsage` is already descending with shares renormalised to 1,
 * so this only cuts the top N rows and folds the tail into a single "Other"
 * row (its share is the sum of the folded shares, so the bars stay a valid
 * part-to-whole picture). Sessions with no project arrive as
 * `projectId: null` and are labelled, not dropped.
 */

/** Rows shown individually in the project breakdown; the tail joins "Other". */
const PROJECT_USAGE_TOP = 8;

export function ProjectUsage({ projects }: { projects: StatsProjectSlice[] }) {
  const { t } = useTranslation();
  const rows = projects.slice(0, PROJECT_USAGE_TOP).map((project) => ({
    key: project.projectId === null ? "no-project" : `project-${project.projectId}`,
    name: project.projectName ?? t("stats.noProject"),
    tokens: project.tokens,
    share: project.share,
  }));
  const rest = projects.slice(PROJECT_USAGE_TOP);
  const otherTokens = rest.reduce((sum, project) => sum + project.tokens, 0);
  const otherShare = rest.reduce((sum, project) => sum + project.share, 0);
  // Zero-token tail carries no visual information; dropping it keeps an
  // all-zero range from rendering a mystery "Other 0%" row.
  if (rest.length > 0 && otherTokens > 0) {
    rows.push({ key: "other", name: t("stats.projectUsageOther"), tokens: otherTokens, share: otherShare });
  }
  if (rows.length === 0) {
    return <div className="stats-trend-tick">{t("stats.empty")}</div>;
  }
  return (
    <ul className="stats-usage-rows">
      {rows.map((row) => (
        <li className="stats-usage-row" key={row.key}>
          <span className="stats-usage-name" title={row.name}>
            {row.name}
          </span>
          <span className="stats-usage-track" aria-hidden="true">
            <span
              className="stats-usage-fill"
              style={{ width: `${Math.min(100, Math.max(0, row.share * 100))}%` }}
            />
          </span>
          <span className="stats-usage-share">{Math.round(row.share * 100)}%</span>
          <span className="stats-usage-tokens">{formatTokens(row.tokens)}</span>
        </li>
      ))}
    </ul>
  );
}

import { useTranslation } from "react-i18next";
import type { StatsModelSlice } from "./dataset";
import { formatTokens } from "./format";
import { OTHER_MODEL_ID } from "./types";

/**
 * Model-usage donut: the top six models as ring segments, with the window
 * total in the middle and a share-plus-tokens legend beside it.
 */

export function Donut({ models }: { models: StatsModelSlice[] }) {
  const { t } = useTranslation();
  const modelLabel = (modelId: string) =>
    modelId === OTHER_MODEL_ID ? t("stats.modelUsageOther") : modelId;
  const total = models.reduce((sum, model) => sum + model.tokens, 0);
  const denominator = total || 1;
  let offset = 0;
  // The SVG is a picture of the legend, so its accessible name summarizes the
  // same shares (top slices first) instead of reusing the trend summary, which
  // speaks about days and peaks rather than proportions.
  const ariaLabel =
    models.length > 0
      ? `${t("stats.modelUsage")}: ${models
          .slice(0, 6)
          .map((model) => `${modelLabel(model.modelId)} ${Math.round(model.share * 100)}%`)
          .join(", ")}`
      : t("stats.modelUsage");
  return (
    <div className="stats-donut-wrap stats-scope">
      <svg viewBox="0 0 42 42" className="stats-donut" role="img" aria-label={ariaLabel}>
        {models.slice(0, 6).map((model, index) => {
          const fraction = model.tokens / denominator;
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
        <text className="stats-donut-total" x="21" y="21" textAnchor="middle">
          {formatTokens(total)}
        </text>
        <text className="stats-donut-total-label" x="21" y="25.5" textAnchor="middle">
          {t("stats.totalTokens")}
        </text>
      </svg>
      <ul className="stats-legend">
        {models.slice(0, 6).map((model, index) => (
          <li key={model.modelId}>
            <span className={`stats-swatch stats-swatch-${index}`} aria-hidden="true" />
            <span>{modelLabel(model.modelId)}</span>
            <span className="stats-legend-value">
              {Math.round(model.share * 100)}% · {formatTokens(model.tokens)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

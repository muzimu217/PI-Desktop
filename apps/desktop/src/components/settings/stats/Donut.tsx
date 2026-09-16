import { useTranslation } from "react-i18next";
import type { StatsModelSlice } from "./dataset";
import { formatTokens } from "./format";

/**
 * Model-usage donut: the top six models as ring segments, with the window
 * total in the middle and a share-plus-tokens legend beside it.
 */

export function Donut({ models }: { models: StatsModelSlice[] }) {
  const { t } = useTranslation();
  const total = models.reduce((sum, model) => sum + model.tokens, 0);
  const denominator = total || 1;
  let offset = 0;
  return (
    <div className="stats-donut-wrap stats-scope">
      <svg viewBox="0 0 42 42" className="stats-donut" role="img" aria-hidden="true">
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
            <span>{model.modelId}</span>
            <span className="stats-legend-value">
              {Math.round(model.share * 100)}% · {formatTokens(model.tokens)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

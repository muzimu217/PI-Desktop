/**
 * The chosen models of a service or account, as a short list (D625).
 *
 * Most people keep the models a service starts with, so the form shows what
 * is chosen and leaves the two-pane picker one click away instead of opening
 * on it. Rows reuse the picker's row classes so removing a model reads and
 * behaves the same in both places.
 */
import { useTranslation } from "react-i18next";
import { formatTokenCount, type ModelBinding } from "@pi-desktop/shared";
import { TooltipButton } from "../ui";
import { IconClose } from "../icons";
import type { ProviderModelsState } from "./useProviderModels";

export type ChosenModelsSummaryProps = {
  models: ModelBinding[];
  discoveryStatus: ProviderModelsState["status"];
  busy?: boolean;
  /** The list is exactly what the recommendation picked. */
  autoPicked?: boolean;
  onRemove: (id: string) => void;
  onManage: () => void;
  /** Open the picker on its hand-typed id field. */
  onAddManually: () => void;
};

export function ChosenModelsSummary({
  models,
  discoveryStatus,
  busy = false,
  autoPicked = false,
  onRemove,
  onManage,
  onAddManually,
}: ChosenModelsSummaryProps) {
  const { t } = useTranslation();

  let empty: string;
  if (discoveryStatus === "error") empty = t("settings.modelsSummaryFailed");
  else if (discoveryStatus === "loading") empty = t("settings.modelsSummaryLoading");
  else if (discoveryStatus === "ready") empty = t("settings.noModelsChosen");
  else empty = t("settings.modelsEmptyHint");

  return (
    <div className="provider-models-summary">
      <div className="provider-models-summary-head">
        <h4 className="provider-chosen-title">{t("settings.modelsSummaryTitle")}</h4>
        <span className="provider-chosen-count">{models.length}</span>
        <button
          type="button"
          className="provider-models-summary-manage"
          disabled={busy}
          aria-expanded={false}
          onClick={onManage}
        >
          {t("settings.manageModels")}
        </button>
      </div>

      {models.length === 0 ? (
        <div className="provider-chosen-empty">
          <span>{empty}</span>
          {discoveryStatus === "error" || discoveryStatus === "ready" ? (
            <button
              type="button"
              className="provider-models-summary-action"
              disabled={busy}
              onClick={onAddManually}
            >
              {t("settings.addModelManually")}
            </button>
          ) : null}
        </div>
      ) : (
        <ul className="provider-chosen-list">
          {models.map((binding) => (
            <li className="provider-chosen-row" key={binding.id}>
              <div className="provider-chosen-row-head">
                <span className="provider-chosen-row-id font-mono selectable">{binding.id}</span>
                {binding.alias?.trim() ? (
                  <span className="provider-chosen-row-alias">{binding.alias.trim()}</span>
                ) : null}
                {binding.thinkingLevels.length > 0 ? (
                  <span className="provider-chosen-row-alias">{t("settings.modelReasoningTag")}</span>
                ) : null}
                <span className="provider-chosen-row-limits">
                  {formatTokenCount(binding.contextWindow)} · {formatTokenCount(binding.maxTokens)}
                </span>
                <TooltipButton
                  type="button"
                  className="provider-chosen-remove"
                  ariaLabel={t("settings.removeModel")}
                  tooltip={t("settings.removeModel")}
                  disabled={busy}
                  onClick={() => onRemove(binding.id)}
                >
                  <IconClose size={12} />
                </TooltipButton>
              </div>
            </li>
          ))}
        </ul>
      )}

      {autoPicked && models.length > 0 ? (
        <div className="provider-models-summary-hint">{t("settings.modelsAutoPicked")}</div>
      ) : null}
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WorkspaceIndexRoot } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { Button } from "../ui";
import { IconDatabase } from "../icons";

type LoadState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; root: WorkspaceIndexRoot | null };

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const exponent = Math.min(
    units.length - 1,
    Math.floor(Math.log(bytes) / Math.log(1024)),
  );
  const value = bytes / 1024 ** exponent;
  return `${value >= 100 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
}

function formatRelative(updatedAt: number): string {
  if (updatedAt <= 0) return "—";
  const deltaSeconds = Math.max(0, Math.round((Date.now() - updatedAt) / 1000));
  if (deltaSeconds < 60) return `${deltaSeconds}s`;
  if (deltaSeconds < 3600) return `${Math.floor(deltaSeconds / 60)}m`;
  if (deltaSeconds < 86400) return `${Math.floor(deltaSeconds / 3600)}h`;
  return `${Math.floor(deltaSeconds / 86400)}d`;
}

const STATUS_TONE: Record<WorkspaceIndexRoot["status"], string> = {
  fresh: "settings-index-status ok",
  building: "settings-index-status busy",
  stale: "settings-index-status warn",
  failed: "settings-index-status error",
  partial: "settings-index-status warn",
  disabled: "settings-index-status",
  skipped_over_limit: "settings-index-status warn",
};

export function IndexPage() {
  const { t } = useTranslation();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [busy, setBusy] = useState<"rebuild" | "clear" | null>(null);
  const [actionError, setActionError] = useState(false);

  const refresh = useCallback(async () => {
    setState((current) =>
      current.kind === "ready" ? { kind: "ready", root: current.root } : { kind: "loading" },
    );
    try {
      const result = await api.indexStatus();
      setState({ kind: "ready", root: result.roots[0] ?? null });
    } catch {
      setState({ kind: "error" });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const rebuild = async () => {
    if (busy) return;
    setBusy("rebuild");
    setActionError(false);
    try {
      const result = await api.indexRebuild();
      setState({ kind: "ready", root: result.root });
    } catch {
      setActionError(true);
      void refresh();
    } finally {
      setBusy(null);
    }
  };

  const clear = async () => {
    if (busy) return;
    setBusy("clear");
    setActionError(false);
    try {
      await api.indexClear();
      setState({ kind: "ready", root: null });
    } catch {
      setActionError(true);
      void refresh();
    } finally {
      setBusy(null);
    }
  };

  if (state.kind === "loading") {
    return (
      <div className="settings-stack" role="status">
        <span className="settings-index-state">{t("index.loading")}</span>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="settings-stack">
        <section className="settings-card-block">
          <div className="settings-panel">
            <div className="settings-row">
              <div className="settings-row-copy">
                <div className="settings-row-title">{t("index.loadErrorTitle")}</div>
                <div className="settings-row-desc">{t("index.loadErrorDesc")}</div>
              </div>
              <div className="settings-row-control">
                <Button onClick={() => void refresh()}>{t("index.retry")}</Button>
              </div>
            </div>
          </div>
        </section>
      </div>
    );
  }

  const { root } = state;
  return (
    <div className="settings-stack">
      <section className="settings-card-block">
        <h3 className="settings-card-heading">{t("index.card.health")}</h3>
        <div className="settings-panel">
          {root ? (
            <>
              <div className="settings-row">
                <div className="settings-row-copy">
                  <div className="settings-row-title">{t("index.card.status")}</div>
                  <div className="settings-row-desc">{t("index.statusDesc")}</div>
                </div>
                <div className="settings-row-control">
                  <span className={STATUS_TONE[root.status]}>
                    {t(`index.status.${root.status}`)}
                  </span>
                </div>
              </div>
              <div className="settings-row">
                <div className="settings-row-copy">
                  <div className="settings-row-title">{t("index.card.files")}</div>
                </div>
                <div className="settings-row-control">
                  <span className="settings-index-metric">{root.fileCount}</span>
                </div>
              </div>
              <div className="settings-row">
                <div className="settings-row-copy">
                  <div className="settings-row-title">{t("index.card.size")}</div>
                </div>
                <div className="settings-row-control">
                  <span className="settings-index-metric">{formatBytes(root.indexedBytes)}</span>
                </div>
              </div>
              {root.errorCount > 0 ? (
                <div className="settings-row">
                  <div className="settings-row-copy">
                    <div className="settings-row-title">{t("index.card.errors")}</div>
                    {root.lastError ? (
                      <div className="settings-row-desc">{root.lastError}</div>
                    ) : null}
                  </div>
                  <div className="settings-row-control">
                    <span className="settings-index-status warn">{root.errorCount}</span>
                  </div>
                </div>
              ) : null}
              <div className="settings-row">
                <div className="settings-row-copy">
                  <div className="settings-row-title">{t("index.card.updated")}</div>
                </div>
                <div className="settings-row-control">
                  <span className="settings-index-metric">
                    {formatRelative(root.updatedAt)}
                  </span>
                </div>
              </div>
            </>
          ) : (
            <div className="settings-row">
              <div className="settings-row-copy">
                <div className="settings-row-title">{t("index.emptyTitle")}</div>
                <div className="settings-row-desc">{t("index.emptyDesc")}</div>
              </div>
            </div>
          )}
          <div className="settings-row">
            <div className="settings-row-copy">
              <div className="settings-row-title">{t("index.actions")}</div>
              <div className="settings-row-desc">{t("index.localOnly")}</div>
            </div>
            <div className="settings-row-control settings-index-actions">
              <Button
                disabled={busy !== null}
                aria-busy={busy === "rebuild"}
                onClick={() => void rebuild()}
              >
                <IconDatabase size={14} />
                {busy === "rebuild" ? t("index.rebuilding") : root ? t("index.action.rebuild") : t("index.action.build")}
              </Button>
              <Button
                variant="secondary"
                disabled={busy !== null || !root}
                onClick={() => void clear()}
              >
                {busy === "clear" ? t("index.clearing") : t("index.action.clear")}
              </Button>
            </div>
          </div>
          {actionError ? (
            <div className="settings-row">
              <div className="settings-row-copy">
                <div className="settings-row-title settings-index-error">
                  {t("index.actionError")}
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

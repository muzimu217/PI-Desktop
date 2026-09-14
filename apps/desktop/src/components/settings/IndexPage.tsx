import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AppSettings, WorkspaceIndexRoot } from "@pi-desktop/shared";
import { api } from "../../lib/api";
import { Button, cx } from "../ui";
import {
  IconActivity,
  IconDatabase,
  IconFileText,
  IconRefresh,
} from "../icons";

type IndexPageProps = {
  settings: AppSettings;
  saveSettings: (patch: Partial<AppSettings>) => Promise<void>;
};

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
  fresh: "ok",
  building: "busy",
  stale: "warn",
  failed: "error",
  partial: "warn",
  disabled: "",
  skipped_over_limit: "warn",
};

function MetricTile({
  icon,
  tone,
  label,
  value,
  caption,
  badge,
}: {
  icon: React.ReactNode;
  tone: "accent" | "success" | "warning" | "danger";
  label: string;
  value: React.ReactNode;
  caption?: string;
  badge?: React.ReactNode;
}) {
  return (
    <div className="idx-tile">
      <div className="idx-tile-head">
        <span className={cx("idx-chip", `idx-chip-${tone}`)} aria-hidden="true">
          {icon}
        </span>
        <span className="idx-tile-label">{label}</span>
        {badge}
      </div>
      <div className="idx-tile-value">{value}</div>
      {caption ? <div className="idx-tile-caption">{caption}</div> : null}
    </div>
  );
}

export function IndexPage({ settings, saveSettings }: IndexPageProps) {
  const { t } = useTranslation();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [busy, setBusy] = useState<"rebuild" | "clear" | null>(null);
  const [actionError, setActionError] = useState(false);
  const grepBoost = settings.indexGrepBoost === true;

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
        <span className="idx-state">{t("index.loading")}</span>
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
          <div className="settings-row">
            <div className="settings-row-copy">
              <div className="settings-row-title">{t("index.grepBoost")}</div>
              <div className="settings-row-desc">{t("index.grepBoostDesc")}</div>
            </div>
            <div className="settings-row-control">
              <button
                type="button"
                className={cx("settings-toggle", grepBoost && "on")}
                role="switch"
                aria-checked={grepBoost}
                aria-label={t("index.grepBoost")}
                onClick={() => void saveSettings({ indexGrepBoost: !grepBoost })}
              >
                <span className="settings-toggle-thumb" />
              </button>
            </div>
          </div>
          {root ? (
            <div className="idx-grid">
              <MetricTile
                icon={<IconActivity size={14} />}
                tone={root.status === "fresh" ? "success" : root.status === "failed" ? "danger" : "warning"}
                label={t("index.card.status")}
                value={
                  <span className={cx("idx-status", STATUS_TONE[root.status])}>
                    {t(`index.status.${root.status}`)}
                  </span>
                }
                caption={t("index.statusDesc")}
              />
              <MetricTile
                icon={<IconFileText size={14} />}
                tone="accent"
                label={t("index.card.files")}
                value={root.fileCount.toLocaleString()}
                badge={
                  root.errorCount > 0 ? (
                    <span className="idx-badge idx-badge-warn">
                      {t("index.card.errors")}: {root.errorCount}
                    </span>
                  ) : undefined
                }
              />
              <MetricTile
                icon={<IconDatabase size={14} />}
                tone="accent"
                label={t("index.card.size")}
                value={formatBytes(root.indexedBytes)}
              />
              <MetricTile
                icon={<IconRefresh size={14} />}
                tone="accent"
                label={t("index.card.updated")}
                value={formatRelative(root.updatedAt)}
              />
            </div>
          ) : (
            <div className="settings-row">
              <div className="settings-row-copy">
                <div className="settings-row-title">{t("index.emptyTitle")}</div>
                <div className="settings-row-desc">{t("index.emptyDesc")}</div>
              </div>
            </div>
          )}
          {root && root.errorCount > 0 && root.lastError ? (
            <div className="idx-error-line" role="status">
              {root.lastError}
            </div>
          ) : null}
          <div className="settings-row">
            <div className="settings-row-copy">
              <div className="settings-row-title">{t("index.actions")}</div>
              <div className="settings-row-desc">{t("index.localOnly")}</div>
            </div>
            <div className="settings-row-control idx-actions">
              <Button
                variant="primary"
                disabled={busy !== null}
                aria-busy={busy === "rebuild"}
                onClick={() => void rebuild()}
              >
                <IconDatabase size={14} />
                {busy === "rebuild" ? t("index.rebuilding") : root ? t("index.action.rebuild") : t("index.action.build")}
              </Button>
              <Button
                disabled={busy !== null || !root}
                onClick={() => void clear()}
              >
                {busy === "clear" ? t("index.clearing") : t("index.action.clear")}
              </Button>
            </div>
          </div>
          {actionError ? (
            <div className="idx-error-line" role="status">
              {t("index.actionError")}
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

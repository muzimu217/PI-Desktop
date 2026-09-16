import { parseDateKey } from "./dataset";

/**
 * Number, date and duration formatting for the stats surfaces.
 *
 * Chart axes, tooltips, metric tiles and session rows all read their strings
 * from here, so a value renders the same way wherever it appears.
 */

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

// Axis labels read like the mockup ("200K", "50K", "0") — no trailing ".0".
export function formatAxis(value: number): string {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}K`;
  return String(value);
}

/** Localized long date ("2026年9月9日" / "September 9, 2026") for tooltips. */
export function formatFullDate(key: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale || undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
    }).format(parseDateKey(key));
  } catch {
    return key;
  }
}

export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

// The repo has no shared relative-time helper (each page keeps a small local
// one), so the session rows reuse the same Intl.RelativeTimeFormat pattern as
// NotificationCenter / ProjectsPage rather than inventing a new format.
export function formatLastActive(ms: number, locale: string): string {
  if (!ms) return "";
  const delta = ms - Date.now();
  const absolute = Math.abs(delta);
  try {
    const formatter = new Intl.RelativeTimeFormat(locale || undefined, { numeric: "auto" });
    if (absolute < 60 * 60_000) return formatter.format(Math.round(delta / 60_000), "minute");
    if (absolute < 24 * 60 * 60_000) return formatter.format(Math.round(delta / (60 * 60_000)), "hour");
    if (absolute < 7 * 24 * 60 * 60_000) {
      return formatter.format(Math.round(delta / (24 * 60 * 60_000)), "day");
    }
    return new Intl.DateTimeFormat(locale || undefined, {
      month: "short",
      day: "numeric",
      year: new Date(ms).getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toLocaleDateString();
  }
}

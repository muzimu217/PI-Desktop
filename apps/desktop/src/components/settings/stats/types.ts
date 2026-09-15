/**
 * Shared option types for the Data & Statistics page.
 *
 * The toolbar window and the activity card granularity, kept in one place so
 * the page and its chart modules agree on the unions.
 */

export type Range = 7 | 30;
/** Heatmap card granularity: daily grid, ISO-week bars, or running total. */
export type Granularity = "daily" | "weekly" | "cumulative";
export const GRANULARITIES: readonly Granularity[] = ["daily", "weekly", "cumulative"];

/**
 * The host buckets turns whose model id is NULL under this literal
 * (`stats.rs`), so it is the one "model name" that must be localized before it
 * reaches a legend, a tooltip, or a screen-reader table. Matching stays at the
 * render layer on purpose: the dataset (and with it the CSV/JSON export) keeps
 * the raw host id so exports stay locale-independent.
 */
export const OTHER_MODEL_ID = "other";

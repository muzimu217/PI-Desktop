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

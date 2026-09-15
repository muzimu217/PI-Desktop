/**
 * Usage statistics and workspace index wire types (Data & Statistics group).
 */
export type StatsDayTotal = { date: string; tokens: number };
export type StatsDayModel = { date: string; modelId: string; tokens: number };
/** One heatmap cell: a local calendar day with its tokens and completed turns. */
export type StatsHeatmapPoint = { date: string; tokens: number; turns: number };
export type StatsModelUsage = { modelId: string; tokens: number; share: number };
export type StatsProjectUsage = {
  projectId: number | null;
  projectName: string | null;
  tokens: number;
  share: number;
};
export type StatsSummary = {
  range: { startMs: number; endMs: number };
  scope: { projectId: number | null };
  cards: {
    totalTokens: number;
    peakDayTokens: number;
    peakDayDate: string | null;
    longestChatMs: number;
    currentStreakDays: number;
    longestStreakDays: number;
    sessionCount: number;
    turnCount: number;
  };
  diagnostics: {
    cacheLeverage: number;
    cacheReadTokens: number;
    largeContextTurnShare: number;
    top5SessionShare: number;
  };
  dailyTotals: StatsDayTotal[];
  dailyByModel: StatsDayModel[];
  modelUsage: StatsModelUsage[];
  projectUsage: StatsProjectUsage[];
  heatmap: StatsHeatmapPoint[];
  generatedAt: number;
};
export type StatsTopSession = {
  sessionId: string;
  title: string | null;
  tokens: number;
  turnCount: number;
  lastActiveMs: number;
};

export type WorkspaceIndexRootStatus =
  | "fresh"
  | "building"
  | "stale"
  | "failed"
  | "partial"
  | "disabled"
  | "skipped_over_limit";

export type WorkspaceIndexRoot = {
  rootId: string;
  rootPath: string;
  status: WorkspaceIndexRootStatus;
  fileCount: number;
  indexedBytes: number;
  errorCount: number;
  lastError: string | null;
  updatedAt: number;
  /** Present while status is "building"; absent otherwise. */
  progress?: { filesDone: number; filesTotal: number };
  /** In-memory fast-path counters; not persisted. */
  metrics?: WorkspaceIndexMetrics;
};

export type WorkspaceIndexMetrics = {
  fastPathServed: number;
  fallbackCount: number;
  fallbackNotLiteral: number;
  fallbackStateGate: number;
  fallbackTooWide: number;
  fallbackVerifyFailed: number;
  candidateRatioAvg: number;
  p50Ms: number;
  p95Ms: number;
};

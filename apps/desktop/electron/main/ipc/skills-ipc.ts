import { dialog, shell } from "electron";
import { ErrorCodes, IPC, type ActivationScope, type AgentCapabilityMove, type AgentCapabilityQuery, type UserSkillRecord, type UserSubagentRecord } from "@pi-desktop/shared";
import { loadSubagentDefinitions, type UserSubagentDocument } from "@pi-desktop/agent-runtime";
import type { HostProcess } from "../host-process";
import type { Logger } from "../logger";
import {
  fetchSkillMarketDocument,
  searchSkillMarket,
  type SkillMarketDocument,
  type SkillMarketSearchResult,
} from "../skill-market-catalog";
import { skillMarketFailureDetail, skillMarketHost } from "../skill-market-scan";
import type { IpcRegistrar } from "./types";

export type SkillsIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  optionalWorkspaceRoot: () => Promise<string | null>;
  activeUserSubagentDocuments: (projectPath: string | undefined) => Promise<UserSubagentDocument[]>;
  stripWinLongPrefix: (path: string) => string;
  sendToRenderer: (channel: string, payload?: unknown) => void;
  searchSkillMarket: (query: string, sources: { id: string; name: string; url: string }[]) => Promise<SkillMarketSearchResult>;
  fetchSkillMarketDocument: (entry: { id: string; name: string; url: string }) => Promise<SkillMarketDocument>;
  logger: Pick<Logger, "app">;
};

/** Register user-owned skill and subagent definition channels. */
export function registerSkillsIpc({
  registrar,
  getHost,
  optionalWorkspaceRoot,
  activeUserSubagentDocuments,
  stripWinLongPrefix,
  sendToRenderer,
  searchSkillMarket,
  fetchSkillMarketDocument,
  logger,
}: SkillsIpcDependencies): void {
  /*
    The market's two channels are the only place that knows why a source went
    quiet, and they previously reported nothing outside the panel. A refusal
    from the public-network guard (issue #419: a proxy that answers DNS itself
    resolves a public host to a non-public address, so the local pre-check
    refuses a URL the browser reaches) was therefore impossible to diagnose
    from a user's logs. `diagnostics` is the category spec 09 gives to blocked
    requests; the payload is host + source + kind only, never the full URL.
  */
  const logSourceFailure = (
    source: { name?: unknown; url?: unknown },
    kind: "policy" | "network",
  ) => {
    const host = skillMarketHost(source.url);
    logger.app("diagnostics", "warn", "skill market source produced no entries", {
      ...(kind === "policy" ? { code: ErrorCodes.NETWORK_POLICY_BLOCKED } : {}),
      event: "skillMarket.sourceFailed",
      data: {
        ...(typeof source.name === "string" && source.name ? { source: source.name } : {}),
        ...(host ? { host } : {}),
        kind,
      },
    });
  };
  const marketFailureKind = (
    result: SkillMarketSearchResult,
    name: string,
  ): "policy" | "network" => (result.failureKinds?.[name] === "policy" ? "policy" : "network");
  let host: HostProcess | null = null;
  const handle = (channel: string, fn: (...args: any[]) => Promise<any>) => {
    registrar.handle(channel, async (...args) => {
      host = getHost();
      return fn(...args);
    });
  };
// --- Skill market: catalog sources and document fetch -----------------------

  // The market's catalog aggregator never touches the host process, so it
  // registers outside the host-bound wrapper.
  registrar.handle(
    IPC.invoke.skillMarketSearch,
    async ({ query, sources }: { query?: string; sources?: { id: string; name: string; url: string }[] } = {}) => {
      const requested = Array.isArray(sources) ? sources : [];
      const result = await searchSkillMarket(query ?? "", requested);
      // One record per source that produced nothing. The panel shows the names,
      // so without this the reason and the host exist nowhere a user can reach.
      for (const name of result.failedSources ?? []) {
        logSourceFailure(
          requested.find((source) => source?.name === name) ?? { name },
          marketFailureKind(result, name),
        );
      }
      return result;
    },
  );
  registrar.handle(
    IPC.invoke.skillMarketFetch,
    async ({ entry }: { entry: { id: string; name: string; url: string } }) => {
      try {
        return await fetchSkillMarketDocument(entry);
      } catch (error) {
        // The install sheet shows this refusal; the log is what makes it
        // diagnosable after the fact, and it survives the sheet closing.
        const detail = skillMarketFailureDetail(entry, error);
        logger.app("diagnostics", "warn", "skill market document fetch failed", {
          ...(detail.kind === "policy" ? { code: ErrorCodes.NETWORK_POLICY_BLOCKED } : {}),
          event: "skillMarket.documentFailed",
          data: detail,
        });
        throw error;
      }
    },
  );

// --- Skills the user owns -------------------------------------------------

  handle(IPC.invoke.skillList, async (query: Partial<AgentCapabilityQuery> = {}) => {
    if (!host) throw new Error("host unavailable");
    return host.call("skills.list", query);
  });

  handle(IPC.invoke.skillCreate, async (skill: Record<string, unknown>) => {
    if (!host) throw new Error("host unavailable");
    const res = await host.call("skills.create", { skill });
    sendToRenderer(IPC.event.pluginChanged,{ reason: "skill" });
    return res;
  });

  /** Import exactly one markdown file into the selected capability directory. */
  handle(IPC.invoke.skillImport, async (query: Partial<AgentCapabilityQuery> = {}) => {
    if (!host) throw new Error("host unavailable");
    const picked = await dialog.showOpenDialog({
      title: "Import skill",
      properties: ["openFile"],
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
    });
    if (picked.canceled || !picked.filePaths[0]) return { canceled: true };
    const res = await host.call("skills.import", {
      path: picked.filePaths[0],
      ...query,
    });
    sendToRenderer(IPC.event.pluginChanged,{ reason: "skill" });
    return res;
  });

  handle(
    IPC.invoke.skillUpdate,
    async (payload: { id: string } & Record<string, unknown>) => {
      if (!host) throw new Error("host unavailable");
      const { id, ...skill } = payload;
      const res = await host.call("skills.update", { id, skill });
      sendToRenderer(IPC.event.pluginChanged,{ reason: "skill" });
      return res;
    },
  );

  handle(
    IPC.invoke.skillRead,
    async (payload: string | ({ id: string } & Partial<AgentCapabilityQuery>)) => {
      if (!host) throw new Error("host unavailable");
      const request = typeof payload === "string" ? { id: payload } : payload;
      return host.call("skills.read", request);
    },
  );

  handle(
    IPC.invoke.skillRemove,
    async (payload: string | ({ id: string } & Partial<AgentCapabilityQuery>)) => {
      if (!host) throw new Error("host unavailable");
      const request = typeof payload === "string" ? { id: payload } : payload;
      const res = await host.call("skills.remove", request);
      sendToRenderer(IPC.event.pluginChanged,{ reason: "skill" });
      return res;
    },
  );

  handle(
    IPC.invoke.skillSetEnabled,
    async (payload: { id: string; enabled: boolean } & Partial<AgentCapabilityQuery>) => {
      if (!host) throw new Error("host unavailable");
      const res = await host.call("skills.setEnabled", payload);
      sendToRenderer(IPC.event.pluginChanged,{ reason: "skill" });
      return res;
    },
  );

  handle(
    IPC.invoke.skillSetScope,
    async (payload: { id: string; scope: ActivationScope }) => {
      if (!host) throw new Error("host unavailable");
      const res = await host.call("skills.setScope", payload);
      sendToRenderer(IPC.event.pluginChanged,{ reason: "skill" });
      return res;
    },
  );

  /**
   * Move a skill between the global and a project's `.agents/skills`.
   *
   * Ownership changes, so both levels change; the response carries the id the
   * skill ended up under, because a move into an occupied destination renames it.
   */
  handle(IPC.invoke.skillTransfer, async (payload: AgentCapabilityMove) => {
    if (!host) throw new Error("host unavailable");
    const res = await host.call<{ skill: UserSkillRecord }>("skills.transfer", payload);
    sendToRenderer(IPC.event.pluginChanged,{ reason: "skill" });
    return res;
  });

  /**
   * Show a skill document in the OS file manager. The level and project travel
   * with the id because `skills.read` falls back to the global directory when
   * they are absent, which never resolves a project-only document.
   */
  handle(
    IPC.invoke.skillReveal,
    async (payload: string | ({ id: string } & Partial<AgentCapabilityQuery>)) => {
      if (!host) throw new Error("host unavailable");
      const request = typeof payload === "string" ? { id: payload } : payload;
      const res = await host.call<{ skill: UserSkillRecord | null }>("skills.read", request);
      const path = res.skill?.path;
      if (!path) throw new Error("skill not found");
      shell.showItemInFolder(stripWinLongPrefix(path));
      return { ok: true };
    },
  );

  // --- Subagents the user owns ----------------------------------------------

  handle(IPC.invoke.subagentList, async () => {
    if (!host) throw new Error("host unavailable");
    return host.call("agents.list");
  });

  /**
   * The effective catalog: what `Task` would actually offer right now, merged
   * across builtin, registry and project documents. The renderer needs this to
   * show read-only rows and to name the definition that wins each handle.
   */
  handle(IPC.invoke.subagentCatalog, async () => {
    const projectPath = (await optionalWorkspaceRoot()) ?? undefined;
    const { definitions, diagnostics } = await loadSubagentDefinitions(
      projectPath,
      { userDocuments: await activeUserSubagentDocuments(projectPath) },
    );
    return { subagents: definitions, diagnostics, projectPath: projectPath ?? null };
  });

  handle(IPC.invoke.subagentCreate, async (subagent: Record<string, unknown>) => {
    if (!host) throw new Error("host unavailable");
    const res = await host.call("agents.create", { subagent });
    sendToRenderer(IPC.event.pluginChanged,{ reason: "subagent" });
    return res;
  });

  handle(
    IPC.invoke.subagentUpdate,
    async (payload: { id: string } & Record<string, unknown>) => {
      if (!host) throw new Error("host unavailable");
      const { id, ...subagent } = payload;
      const res = await host.call("agents.update", { id, subagent });
      sendToRenderer(IPC.event.pluginChanged,{ reason: "subagent" });
      return res;
    },
  );

  handle(IPC.invoke.subagentRead, async (id: string) => {
    if (!host) throw new Error("host unavailable");
    return host.call("agents.read", { id });
  });

  handle(IPC.invoke.subagentRemove, async (id: string) => {
    if (!host) throw new Error("host unavailable");
    const res = await host.call("agents.remove", { id });
    sendToRenderer(IPC.event.pluginChanged,{ reason: "subagent" });
    return res;
  });

  handle(
    IPC.invoke.subagentSetEnabled,
    async (payload: { id: string; enabled: boolean }) => {
      if (!host) throw new Error("host unavailable");
      const res = await host.call("agents.setEnabled", payload);
      sendToRenderer(IPC.event.pluginChanged,{ reason: "subagent" });
      return res;
    },
  );

  handle(
    IPC.invoke.subagentSetScope,
    async (payload: { id: string; scope: ActivationScope }) => {
      if (!host) throw new Error("host unavailable");
      const res = await host.call("agents.setScope", payload);
      sendToRenderer(IPC.event.pluginChanged,{ reason: "subagent" });
      return res;
    },
  );

  /**
   * Show a definition document in the OS file manager. The path always comes
   * from the host registry: a renderer-supplied path is never handed to the
   * shell, so this channel cannot be used to reveal arbitrary locations.
   */
  handle(IPC.invoke.subagentReveal, async (payload: { id?: string; path?: string }) => {
    if (!host) throw new Error("host unavailable");
    if (!payload.id) throw new Error("subagent id required");
    const res = await host.call<{ subagent: UserSubagentRecord | null }>(
      "agents.read",
      { id: payload.id },
    );
    const path = res.subagent?.path;
    if (!path) throw new Error("subagent not found");
    shell.showItemInFolder(stripWinLongPrefix(path));
    return { ok: true };
  });

}

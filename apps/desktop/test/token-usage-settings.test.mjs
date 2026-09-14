import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const search = await readFile(
  new URL("../src/lib/settings-search.ts", import.meta.url),
  "utf8",
);
const settingsPage = await readFile(
  new URL("../src/pages/SettingsPage.tsx", import.meta.url),
  "utf8",
);
const api = await readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8");

// D335 amended (ADR 0181): the Usage destination returns to Settings inside
// the Data & Statistics group, backed by the host stats.summary RPC. The
// legacy getTokenUsageHistory channel stays available for compatibility.
test("settings hosts the usage destination inside the data group", () => {
  assert.match(search, /id: "usage"/);
  assert.match(search, /settings\.nav\.usage/);
  const entry = search.slice(
    search.indexOf('id: "usage"'),
    search.indexOf('id: "index"'),
  );
  assert.match(entry, /group: "data"/);
  assert.match(settingsPage, /tab === "usage" && settings && \(\n\s*<StatsPage \/>\n\s*\)/);
  assert.match(api, /getTokenUsageHistory/);
  assert.match(api, /statsSummary: \(rangeDays: 7 \| 30/);
});

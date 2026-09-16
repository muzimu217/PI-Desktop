import { readSettingsSource } from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import test from "node:test";

const search = await readFile(
  new URL("../src/lib/settings-search.ts", import.meta.url),
  "utf8",
);
const settingsPage = await readSettingsSource();
const api = await readFile(new URL("../src/lib/api.ts", import.meta.url), "utf8");
const enLocale = await readFile(
  new URL("../../../packages/i18n/src/locales/en/index.ts", import.meta.url),
  "utf8",
);
const zhLocale = await readFile(
  new URL("../../../packages/i18n/src/locales/zh-CN/index.ts", import.meta.url),
  "utf8",
);

// D335 / ADR 0173 stands: the cross-session usage dashboard belongs to a plugin,
// not to Settings. Core still owns the turns / usage / stats RPCs and the page
// stays on disk, but nothing routes to it.
//
// This guards the boundary in both directions. It fails if the usage
// destination quietly creeps back into the sidebar, and it fails if the
// retained component, its RPCs or its copy get swept away as "dead code" —
// which is the state the dashboard needs to be reusable from a plugin.
test("usage statistics is retained but is not a settings destination", async () => {
  assert.doesNotMatch(search, /id: "usage"/);
  assert.doesNotMatch(search, /settings\.nav\.usage/);
  assert.doesNotMatch(settingsPage, /StatsPage/);
  assert.doesNotMatch(settingsPage, /tab === "usage"/);
});

test("the retained dashboard keeps its component, its RPCs and its copy", async () => {
  await access(
    new URL("../src/components/settings/StatsPage.tsx", import.meta.url),
    constants.F_OK,
  );
  // The host surface the dashboard reads is what a plugin would call.
  assert.match(api, /getTokenUsageHistory/);
  assert.match(api, /statsSummary: \(rangeDays: 7 \| 30/);
  // Copy stays in the catalogs so the page can be reused without a re-translate
  // pass, including the group label it used to sit under.
  for (const catalog of [enLocale, zhLocale]) {
    assert.match(catalog, /"?groupData"?:/);
    assert.match(catalog, /"?usage"?:/);
  }
});

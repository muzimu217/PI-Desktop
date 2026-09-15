import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

const [search, settingsPage, api, protocol, main, page, enLocale, settingsTypes, statsTypes] = await Promise.all([
  read("src/lib/settings-search.ts"),
  read("src/features/settings/SettingsPage.tsx"),
  read("src/lib/api.ts"),
  read("../../packages/shared/src/protocol.ts"),
  read("electron/main/ipc/session-ipc.ts"),
  read("src/components/settings/IndexPage.tsx"),
  read("../../packages/i18n/src/locales/en/index.ts"),
  read("../../packages/shared/src/types/settings.ts"),
  read("../../packages/shared/src/types/stats.ts"),
]);

test("workspace index is a workspace-group settings destination", () => {
  assert.match(search, /id: "index"/);
  assert.match(search, /labelKey: "settings\.nav\.index"/);
  assert.match(search, /data: "settings\.groupData"/);
  assert.match(search, /titleKey: "settings\.index"/);
  const entry = search.slice(
    search.indexOf('id: "index"'),
    search.indexOf('id: "about"'),
  );
  assert.match(entry, /group: "data"/);
  assert.match(entry, /"index\.card\.health"/);
  assert.match(settingsPage, /tab === "index" && settings && \(\n\s*<IndexPage settings=\{settings\} saveSettings=\{saveSettings\} \/>\n\s*\)/);
  assert.match(settingsPage, /import \{ IndexPage \}/);
});

test("index page renders host lifecycle state without promising Grep changes", async () => {
  await access(
    new URL("../src/components/settings/IndexPage.tsx", import.meta.url),
    constants.F_OK,
  );
  assert.match(page, /api\.indexStatus\(/);
  assert.match(page, /api\.indexRebuild\(/);
  assert.match(page, /api\.indexClear\(/);
  assert.match(page, /index\.card\.health/);
  assert.match(page, /settings\.indexGrepBoost === true/);
  assert.match(page, /saveSettings\(\{ indexGrepBoost: !grepBoost \}\)/);
  assert.match(page, /saveSettings\(\{ indexNewFolders: !newFolders \}\)/);
  assert.match(page, /setInterval\(poll, 1000\)/);
  assert.match(enLocale, /grepBoost: "Grep index boost"/);
  assert.match(enLocale, /"?newFolders"?: "Index new folders"/);
  assert.match(settingsTypes, /indexNewFolders: boolean/);
  assert.match(page, /index\.status\.\$\{root\.status\}/);
  // The page must not claim the fast path is active: P2-A only builds the
  // cache, so the copy has to describe the index as a rebuildable cache.
  assert.match(enLocale, /Grep results never depend on it/);
});

test("index IPC stays on the three lifecycle channels", () => {
  assert.match(protocol, /indexStatus: "pi-desktop\/index\/status"/);
  assert.match(protocol, /indexRebuild: "pi-desktop\/index\/rebuild"/);
  assert.match(protocol, /indexClear: "pi-desktop\/index\/clear"/);
  assert.match(api, /indexStatus: \(rootPath\?: string\)/);
  assert.match(api, /indexRebuild: \(rootPath\?: string\)/);
  assert.match(api, /indexClear: \(rootPath\?: string\)/);
  assert.match(main, /host\.call\("index\.status", input \?\? \{\}\)/);
  assert.match(main, /host\.call\("index\.rebuild", input \?\? \{\}\)/);
  assert.match(main, /host\.call\("index\.clear", input \?\? \{\}\)/);
});

test("settings search and locales carry the index keys", () => {
  for (const key of [
    "settings.nav.index",
    "settings.index",
    "index.card.health",
    "index.action.rebuild",
    "index.action.clear",
  ]) {
    const leaf = key.split(".").pop();
    assert.match(enLocale, new RegExp(`${leaf}:`));
  }
});

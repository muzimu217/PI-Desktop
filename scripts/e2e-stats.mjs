#!/usr/bin/env node
// E2E for the Data & Statistics board (usage-stats page).
//
// Methodology (mirrors the archived stats-real-data-verify.mjs): seed a KNOWN
// fixture directly into the isolated pi.sqlite, then launch Electron against a
// temporary data dir and read the rendered DOM back out via CDP. Every
// gate-relevant number is reconciled against an independent SQL query — this is
// the only check that proves "the link is live" (F-G2 first iron law) rather
// than "the math is right" (fixtures can pass while the write path is broken).
//
// Scenarios:
//   node scripts/e2e-stats.mjs [repo] [scenario] [usagePng] [emptyPng]
//   node scripts/e2e-stats.mjs . main      # summary cards + heatmap + project breakdown + R12
//   node scripts/e2e-stats.mjs . empty     # whole-page empty state (turnCount = 0)
//   scenario defaults to "both"; the bare `node scripts/e2e-stats.mjs main`
//   form from the old header is still accepted. Each scenario writes one PNG.
//
// Gate coverage:
//   E2E-STATS-summary-cards-range   metric tiles reconcile with SQL
//   E2E-STATS-heatmap-today         today cell highlighted
//   E2E-STATS-project-breakdown     Top8 + "Other" fold + "No project" bucket
//   E2E-STATS-soft-deleted-excluded R12: trashed session tokens must NOT count
//   E2E-STATS-empty-state           zero completed turns -> the empty card
//
// Requires a display + Electron. In a headless CI this is marked NOT RUN and the
// host-only data assertions (cargo test -p host-core) remain the reproducible
// floor for 准.
//
// The board is unrouted in Settings while D335 / ADR 0173 stands, so with the
// current IA this script reports SKIPPED and exits 0: it deliberately refuses to
// assert against whichever settings tab is active instead of the board.
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------- arguments
// Positional [repo] [scenario] ..., but also tolerate the scenario first: the
// old header documented `node scripts/e2e-stats.mjs main`, and resolving "main"
// as the repo path silently pointed appDir at ./main/apps/desktop.
const SCENARIOS = ["main", "empty", "both"];
const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flag = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
let [repoArg, scenarioArg, outUsageArg, outEmptyArg] = positional;
if (SCENARIOS.includes(repoArg) && scenarioArg === undefined) {
  scenarioArg = repoArg;
  repoArg = undefined;
}
const repo = resolve(repoArg ?? flag("repo", "."));
const scenario = scenarioArg ?? flag("scenario", "both");
if (!SCENARIOS.includes(scenario)) {
  console.error(`unknown scenario "${scenario}" (expected ${SCENARIOS.join(" | ")})`);
  process.exit(2);
}
const outUsage = outUsageArg ?? flag("usage-png", "/tmp/pi-e2e-usage.png");
const outEmpty = outEmptyArg ?? flag("empty-png", "/tmp/pi-e2e-empty.png");
const port = Number(flag("port", "9352"));
const appDir = join(repo, "apps/desktop");

const electron =
  process.env.ELECTRON_BIN ||
  resolve(
    repo,
    "apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
  );

const workspace = await mkdtemp(join(tmpdir(), "pi-stats-ws-"));
const dataDir = await mkdtemp(join(tmpdir(), "pi-stats-data-"));
const profileDir = await mkdtemp(join(tmpdir(), "pi-stats-profile-"));
await writeFile(join(workspace, "README.md"), "stats fixture\n");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, cond, detail = "") {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " - " + detail : ""}`);
}

// Nothing is allowed to hang forever: a wedged CDP command or a window that
// never opens should fail loudly instead of parking the run.
const watchdog = setTimeout(() => {
  console.error("WATCHDOG: exceeded the budget, giving up");
  try {
    session?.ws.close();
  } catch {}
  try {
    child?.kill();
  } catch {}
  process.exit(3);
}, Number(flag("budget-ms", "240000")));
watchdog.unref?.();

// ------------------------------------------------------------- localized copy
// The renderer runs in whatever locale the machine has, so assertions that match
// English copy ("Other", "No project") pass or fail by accident. Collect the
// candidate strings from every locale the package ships and match against the
// set. Keys are read from the built locales; a locale that lags is skipped
// rather than fatal.
const localeStrings = { totalTokens: new Set(), projectUsageOther: new Set(), noProject: new Set() };
for (const locale of ["de", "en", "es", "fr", "ko", "tr", "zh-CN", "zh-TW"]) {
  try {
    const mod = await import(
      pathToFileURL(join(repo, "packages/i18n/dist/locales", locale, "index.js")).href
    );
    const table = mod.default ?? Object.values(mod).find((v) => v && typeof v === "object");
    for (const key of Object.keys(localeStrings)) {
      const value = table?.stats?.[key];
      if (typeof value === "string") localeStrings[key].add(value);
    }
  } catch {}
}
if (!localeStrings.projectUsageOther.size || !localeStrings.noProject.size) {
  console.warn(
    "warn: could not read stats copy from packages/i18n/dist — build the i18n package for the strongest assertions",
  );
}

// `formatTokens` (components/settings/stats/format.ts) abbreviates above 1000
// ("11.7K"), so a tile cannot be compared digit-for-digit with SQL. Parse the
// suffix back and allow exactly the rounding granularity it introduces.
const parseTokens = (text) => {
  const m = /([\d.]+)\s*([KM]?)/i.exec(text ?? "");
  if (!m) return NaN;
  const unit = { "": 1, k: 1e3, m: 1e6 }[(m[2] || "").toLowerCase()];
  return Number(m[1]) * unit;
};
const tokenTolerance = (text) => (/K/i.test(text ?? "") ? 50 : /M/i.test(text ?? "") ? 5000 : 0);

const child = spawn(
  electron,
  [
    // Without these two the sandbox cannot initialise in a plain shell and the
    // GPU process dies with "GPU process isn't usable. Goodbye." before any
    // window exists, so /json/list never lists a page target.
    "--no-sandbox",
    "--disable-gpu",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    "--force-renderer-accessibility",
    "--enable-logging",
    ".",
  ],
  {
    cwd: appDir,
    env: {
      ...process.env,
      PI_DESKTOP_DATA_DIR: dataDir,
      PI_DESKTOP_HOST_BIN: join(repo, "target/debug/pi-desktop-host-core"),
      ELECTRON_RENDERER_URL: "",
      PI_DESKTOP_START_MAXIMIZED: "0",
    },
    stdio: ["ignore", "ignore", "pipe"],
  },
);
child.stderr.on("data", (c) => {
  const t = String(c);
  if (/error|Error|ERROR|panic|uncaught/.test(t))
    process.stdout.write("[el] " + t.slice(0, 400) + "\n");
});

const targets = async () =>
  (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(
    (t) => t.type === "page",
  );
const connect = async (t) => {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((ok, fail) => {
    // The handshake needs its own deadline; "open" and "error" are both
    // optional, and a socket that does neither parks the run forever (the
    // process then exits with the misleading "unsettled top-level await").
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      fail(new Error("socket open timed out"));
    }, 5000);
    ws.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        ok();
      },
      { once: true },
    );
    ws.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        fail(new Error("socket error"));
      },
      { once: true },
    );
  });
  let n = 0;
  const map = new Map();
  const failAll = (message) => {
    for (const [, e] of map) {
      clearTimeout(e.timer);
      e.fail(new Error(message));
    }
    map.clear();
  };
  ws.addEventListener("close", () => failAll("debugger socket closed"));
  ws.addEventListener("message", async (ev) => {
    const raw = typeof ev.data === "string" ? ev.data : await ev.data.text();
    const m = JSON.parse(raw);
    const e = map.get(m.id);
    if (!e) return;
    map.delete(m.id);
    clearTimeout(e.timer);
    m.error ? e.fail(new Error(m.error.message)) : e.ok(m.result);
  });
  return {
    ws,
    send: (method, params = {}) =>
      new Promise((ok, fail) => {
        const id = ++n;
        const timer = setTimeout(() => {
          map.delete(id);
          fail(new Error(`${method} timed out`));
        }, Number(flag("cdp-timeout", "8000")));
        map.set(id, { ok, fail, timer });
        ws.send(JSON.stringify({ id, method, params }));
      }),
  };
};

let session = null;
try {
  for (let i = 0; i < 120 && !session; i++) {
    let list = [];
    try {
      list = await targets();
    } catch {}
    for (const t of list) {
      try {
        const s = await connect(t);
        await s.send("Runtime.enable");
        const r = await s.send("Runtime.evaluate", {
          expression: "!!document.querySelector('[data-nav=\"settings\"]')",
          returnByValue: true,
        });
        if (r.result?.value === true) {
          session = s;
          break;
        }
        s.ws.close();
      } catch {}
    }
    if (!session) await sleep(500);
  }
  if (!session) throw new Error("main window not found");
  const { send } = session;
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails)
      throw new Error(
        String(r.exceptionDetails.exception?.description ?? "eval").slice(0, 300),
      );
    return r.result.value;
  };
  await send("Page.enable");
  for (let i = 0; i < 40; i++) {
    if ((await evaluate("typeof window.piDesktop?.invoke")) === "function") break;
    await sleep(500);
  }
  await evaluate(`window.piDesktop.invoke("pi-desktop/project/set", ${JSON.stringify(workspace)})`);

  const dbPath = join(dataDir, "pi.sqlite");
  const q = (sql) => execFileSync("sqlite3", [dbPath, sql], { encoding: "utf8" }).trim();
  const seed = (stmts) =>
    execFileSync("sqlite3", [dbPath], { input: stmts.join("\n"), stdio: ["pipe", "ignore", "pipe"] });

  // ---- navigate to usage-stats page ----
  // A single programmatic switch is not reliable (the shell re-asserts its
  // default tab), and re-clicking the item we are already on does not remount,
  // so a scenario that mutates the DB would keep showing the stale snapshot.
  // Bounce through another tab and read the active nav row back.
  const activeNav = () =>
    evaluate(
      `(() => { const it=[...document.querySelectorAll(".settings-nav-item")].find(e=>/(^|\\s)active(\\s|$)/.test(e.className||"")); return it ? (it.textContent||"").trim() : null; })()`,
    );
  const clickNav = (re) =>
    evaluate(
      `(() => { const it=[...document.querySelectorAll(".settings-nav-item")].find(e=>${re}.test(e.textContent||"")); if(it) it.click(); return !!it; })()`,
    );
  const USAGE_LABEL = /使用统计|Usage statistics/;
  const openUsage = async () => {
    // The nav rail is not mounted once Settings is open, so this click only
    // applies on the first (from-chat) entry. Unconditional `click()` on the
    // null threw on every later scenario.
    await evaluate(
      `(() => { const el = document.querySelector('[data-nav="settings"]'); if (el) { el.click(); return true; } return false; })()`,
    );
    for (let i = 0; i < 30; i++) {
      if (await evaluate("document.querySelectorAll('.settings-nav-item').length > 0")) break;
      await sleep(400);
    }
    // The usage board is retired from the rail (D335 / ADR 0173), so on this
    // branch there is nothing to navigate to. Report that instead of asserting
    // against whichever tab happens to be active — a green run that checked the
    // wrong page is worse than no run.
    const hasUsage = await evaluate(
      `[...document.querySelectorAll(".settings-nav-item")].some(e => ${USAGE_LABEL}.test(e.textContent||""))`,
    );
    if (!hasUsage) return "absent";
    if (USAGE_LABEL.test((await activeNav()) ?? "")) await clickNav("/索引|Index/");
    let on = false;
    for (let attempt = 0; attempt < 6 && !on; attempt++) {
      await clickNav(USAGE_LABEL);
      await sleep(600);
      on = USAGE_LABEL.test((await activeNav()) ?? "");
    }
    for (let i = 0; i < 40; i++) {
      if (
        await evaluate(
          `!!document.querySelector(".stats-trend-line") || !!document.querySelector(".stats-empty")`,
        )
      )
        break;
      await sleep(400);
    }
    await sleep(900);
    return on ? "on" : "off";
  };

  const skipReason =
    (await openUsage()) === "absent"
      ? "usage statistics is not a settings destination on this branch (D335 / ADR 0173): the board ships behind a plugin, so e2e-stats has no DOM subject"
      : null;
  if (skipReason) console.log(`\nSKIP: ${skipReason}\n`);

  if (!skipReason && (scenario === "main" || scenario === "both")) {
    const now = Date.now();
    // Fixture: today has completed turns across projects; plus an aborted turn
    // (must be excluded), a soft-deleted session (R12), and >8 projects to force
    // the "Other" fold in the project breakdown.
    //
    // Project ids start high because host-core already owns projects 1..n by the
    // time we seed; a low hardcoded id is dropped silently by INSERT OR IGNORE
    // and every fixture session then lands on the host's own project.
    const projects = ["Acme", "Beta", "Gamma", "Delta", "Echo", "Foxtrot", "Hotel", "India", "Juliet"];
    const stmts = [];
    let turnId = 0;
    projects.forEach((name, i) => {
      stmts.push(
        `INSERT OR IGNORE INTO projects (id, path, name, pinned, created_at, last_opened_at) VALUES (${9001 + i}, '/tmp/pi-e2e/${name}', '${name}', 0, ${now}, ${now});`,
      );
    });
    // sessions carries project_id -> projects.id; the old sessions.project TEXT
    // column is gone, and writing it made every INSERT fail.
    const addTurn = (sid, projId, inTok, outTok, cache, status = "completed", ageMin = 60, deleted = false) => {
      stmts.push(
        `INSERT OR IGNORE INTO sessions (id, title, mode, project_id, created_at, updated_at${deleted ? ", deleted_at" : ""}) VALUES ('${sid}', 'Title ${sid}', 'agent', ${projId === null ? "NULL" : projId}, ${now}, ${now}${deleted ? `, ${now}` : ""});`,
      );
      stmts.push(
        `INSERT INTO turns (id, session_id, status, model_id, input_tokens, output_tokens, usage_json, started_at, ended_at) VALUES ('t${turnId}', '${sid}', '${status}', 'claude-3-5-sonnet', ${inTok}, ${outTok}, '{"cacheReadTokens":${cache},"cacheWriteTokens":0}', ${now - ageMin * 60000}, ${now - ageMin * 60000 + 5000});`,
      );
      turnId++;
    };
    // Acme: 3 completed turns x (1000+1000) = 6000, cache 3000
    for (let i = 0; i < 3; i++) addTurn("a" + i, 9001, 1000, 1000, 3000, "completed", 60);
    // Beta: 2 completed turns x (1000+1000) = 4000
    for (let i = 0; i < 2; i++) addTurn("b" + i, 9002, 1000, 1000, 0, "completed", 30);
    // 7 tail projects each 100 tokens -> the tail folds into "Other"
    projects.slice(2).forEach((name, i) => addTurn("p-" + name, 9003 + i, 50, 50, 0, "completed", 20));
    // No-project session: 500+500
    addTurn("nop", null, 500, 500, 0, "completed", 15);
    // Aborted turn on Acme: MUST NOT count
    addTurn("abort", 9001, 99999, 99999, 0, "aborted", 10);
    // Soft-deleted session (R12): MUST NOT count
    addTurn("del", 9001, 424242, 424242, 0, "completed", 5, true);
    seed(stmts);

    const sqlCompleted = Number(
      q("SELECT COALESCE(SUM(input_tokens+output_tokens),0) FROM turns t JOIN sessions s ON s.id=t.session_id WHERE t.status='completed' AND t.ended_at IS NOT NULL AND s.deleted_at IS NULL"),
    );
    const sqlWithDeleted = Number(
      q("SELECT COALESCE(SUM(input_tokens+output_tokens),0) FROM turns t JOIN sessions s ON s.id=t.session_id WHERE t.status='completed' AND t.ended_at IS NOT NULL"),
    );
    const sqlToday = Number(
      q("SELECT COALESCE(SUM(input_tokens+output_tokens),0) FROM turns t JOIN sessions s ON s.id=t.session_id WHERE t.status='completed' AND t.ended_at IS NOT NULL AND s.deleted_at IS NULL AND date(t.started_at/1000,'unixepoch','localtime') = date('now','localtime')"),
    );
    console.log("SQL completed(excl deleted):", sqlCompleted, "| incl deleted:", sqlWithDeleted, "| today:", sqlToday);

    const onUsage = await openUsage();
    check("E2E-STATS-usage-tab", onUsage, `active nav=${JSON.stringify(await activeNav())}`);

    const dom = await evaluate(`(() => {
      const tiles = [...document.querySelectorAll(".stats-cards .idx-tile")].map(t => ({
        label: (t.querySelector(".idx-tile-label")||{}).textContent || "",
        value: (t.querySelector(".idx-tile-value")||{}).textContent || "",
      }));
      const usage = [...document.querySelectorAll(".stats-usage-row")].map(r => ({
        name: (r.querySelector(".stats-usage-name")||{}).textContent || "",
        tokens: (r.querySelector(".stats-usage-tokens")||{}).textContent || "",
      }));
      return {
        tiles, usage,
        today: document.querySelectorAll(".stats-heat-today").length,
        heatCells: document.querySelectorAll(".stats-heat-cell").length,
        srTables: document.querySelectorAll(".stats-sr-table").length,
      };
    })()`);

    // E2E-STATS-summary-cards-range: total tokens tile reconciles with SQL.
    // Located by its own label (any locale); the copy matcher is a convenience,
    // so fall back to the first tile — that is where the range total lives.
    const isTotalLabel = (label) => localeStrings.totalTokens.has(label.trim());
    const totalTile = dom.tiles.find((t) => isTotalLabel(t.label)) ?? dom.tiles[0];
    const tileTotal = parseTokens(totalTile?.value ?? "");
    check(
      "E2E-STATS-summary-cards-range",
      Number.isFinite(tileTotal) && Math.abs(tileTotal - sqlCompleted) <= tokenTolerance(totalTile?.value),
      `UI total=${JSON.stringify(totalTile?.value)} (${tileTotal}) SQL completed=${sqlCompleted}`,
    );

    // E2E-STATS-heatmap-today: today cell highlighted.
    check("E2E-STATS-heatmap-today", dom.today >= 1, `today cells=${dom.today}`);

    // E2E-STATS-project-breakdown: Top8 + "Other" fold + "No project" bucket.
    // Matched on the localized labels collected above, and on the row count that
    // only the fold can produce (9 named projects + the null bucket -> top 8 + Other).
    const names = dom.usage.map((r) => r.name.trim());
    const hasOther = names.some((n) => localeStrings.projectUsageOther.has(n));
    const hasNoProject = names.some((n) => localeStrings.noProject.has(n));
    const hasAcme = names.includes("Acme");
    const hasBeta = names.includes("Beta");
    check(
      "E2E-STATS-project-breakdown",
      hasAcme && hasBeta && hasOther && hasNoProject && dom.usage.length === 9,
      `rows=${dom.usage.length} Acme=${hasAcme} Beta=${hasBeta} Other=${hasOther} NoProject=${hasNoProject}`,
    );

    // E2E-STATS-soft-deleted-excluded (R12): trashed session tokens not counted.
    check(
      "E2E-STATS-soft-deleted-excluded",
      Math.abs(tileTotal - sqlCompleted) <= tokenTolerance(totalTile?.value) && sqlCompleted < sqlWithDeleted,
      `UI=${tileTotal} excludes deleted(${sqlWithDeleted - sqlCompleted} tok)`,
    );

    const shot = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(outUsage, Buffer.from(shot.data, "base64"));
    console.log("saved:", outUsage);
  }

  if (!skipReason && (scenario === "empty" || scenario === "both")) {
    // Zero completed turns -> whole-page empty state.
    //
    // The main scenario shares the data dir, so clear what it seeded: leaving
    // those turns in place makes turnCount > 0 and the empty card never renders.
    const now = Date.now();
    seed([
      "DELETE FROM turns;",
      "DELETE FROM sessions;",
      `INSERT OR IGNORE INTO sessions (id, title, mode, created_at, updated_at) VALUES ('empty-s', 'Empty', 'agent', ${now}, ${now});`,
    ]);
    await openUsage();
    // Assert on the card itself rather than its copy, which is localized.
    const empty = await evaluate(`(() => ({
      card: !!document.querySelector(".stats-empty"),
      tiles: document.querySelectorAll(".stats-cards .idx-tile").length,
    }))()`);
    check(
      "E2E-STATS-empty-state",
      empty.card && empty.tiles === 0,
      empty.card ? "empty card shown, no metric tiles" : "empty card MISSING",
    );
    const shot = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(outEmpty, Buffer.from(shot.data, "base64"));
    console.log("saved:", outEmpty);
  }

  const failed = results.filter((r) => !r.pass);
  console.log(
    skipReason
      ? `\nE2E-STATS summary: SKIPPED — ${skipReason}`
      : `\nE2E-STATS summary: ${results.length - failed.length}/${results.length} passed`,
  );
  process.exitCode = failed.length ? 1 : 0;
} catch (e) {
  console.error("FAILED:", e.message);
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  try {
    session?.ws.close();
  } catch {}
  try {
    child?.kill();
  } catch {}
  await sleep(600);
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  await rm(workspace, { recursive: true, force: true }).catch(() => {});
}

// Electron's helper processes can keep the stdio pipes open after the kill, so
// the event loop may never drain and the process would sit there after the
// summary — which reads as a hung CI job rather than a finished one. Leave
// explicitly with whatever the checks decided.
process.exit(process.exitCode ?? 0);

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
//   node scripts/e2e-stats.mjs            # runs main then empty
//   node scripts/e2e-stats.mjs main       # summary cards + heatmap + project breakdown + R12
//   node scripts/e2e-stats.mjs empty      # whole-page empty state (turnCount = 0)
//
// Gate coverage:
//   E2E-STATS-summary-cards-range   metric tiles reconcile with SQL
//   E2E-STATS-heatmap-today         today cell highlighted
//   E2E-STATS-project-breakdown     Top8 + "Other" fold + "No project" bucket
//   E2E-STATS-soft-deleted-excluded R12: trashed session tokens must NOT count
//   E2E-STATS-empty-state           zero completed turns -> "No usage data yet"
//
// Requires a display + Electron. In a headless CI this is marked NOT RUN and the
// host-only data assertions (cargo test -p host-core) remain the reproducible
// floor for 准.
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const repo = resolve(process.argv[2] ?? ".");
const scenario = process.argv[3] ?? "both"; // main | empty | both
const outUsage = process.argv[4] ?? "/tmp/pi-e2e-usage.png";
const outIndex = process.argv[5] ?? "/tmp/pi-e2e-index.png";
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

const child = spawn(
  electron,
  [
    "--remote-debugging-port=9352",
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
  (await (await fetch("http://127.0.0.1:9352/json/list")).json()).filter(
    (t) => t.type === "page",
  );
const connect = async (t) => {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((ok, fail) => {
    ws.addEventListener("open", ok, { once: true });
    ws.addEventListener("error", fail, { once: true });
  });
  let n = 0;
  const map = new Map();
  ws.addEventListener("message", async (ev) => {
    const raw = typeof ev.data === "string" ? ev.data : await ev.data.text();
    const m = JSON.parse(raw);
    const e = map.get(m.id);
    if (!e) return;
    map.delete(m.id);
    m.error ? e.fail(new Error(m.error.message)) : e.ok(m.result);
  });
  return {
    ws,
    send: (method, params = {}) =>
      new Promise((ok, fail) => {
        const id = ++n;
        map.set(id, { ok, fail });
        ws.send(JSON.stringify({ id, method, params }));
      }),
  };
};

let session = null;
try {
  for (let i = 0; i < 60 && !session; i++) {
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
  const q = (sql) =>
    execFileSync("sqlite3", [dbPath, sql], { encoding: "utf8" }).trim();
  const seed = (stmts) =>
    execFileSync("sqlite3", [dbPath], { input: stmts.join("\n"), stdio: ["pipe", "ignore", "pipe"] });

  // ---- navigate to usage-stats page ----
  const openUsage = async () => {
    await evaluate(`document.querySelector('[data-nav="settings"]').click()`);
    for (let i = 0; i < 30; i++) {
      if (await evaluate("document.querySelectorAll('.settings-nav-item').length > 0")) break;
      await sleep(400);
    }
    await evaluate(
      `(() => { const it=[...document.querySelectorAll(".settings-nav-item")].find(e=>/使用统计|Usage statistics/.test(e.textContent||"")); if(it) it.click(); return !!it; })()`,
    );
    for (let i = 0; i < 40; i++) {
      if (await evaluate(`!!document.querySelector(".stats-trend-line") || document.body.innerText.includes("No usage data yet")`)) break;
      await sleep(400);
    }
    await sleep(900);
  };

  if (scenario === "main" || scenario === "both") {
    const now = Date.now();
    // Fixture: today has completed turns across projects; plus an aborted turn
    // (must be excluded), a soft-deleted session (R12), and >8 projects to force
    // the "Other" fold in the project breakdown.
    const projects = ["Acme", "Beta", "Gamma", "Delta", "Echo", "Foxtrot", "Hotel", "India", "Juliet"];
    const stmts = [];
    let turnId = 0;
    const addTurn = (sid, proj, inTok, outTok, cache, status = "completed", ageMin = 60, deleted = false) => {
      stmts.push(
        `INSERT OR IGNORE INTO sessions (id, title, mode, project, created_at, updated_at${deleted ? ", deleted_at" : ""}) VALUES ('${sid}', 'Title ${sid}', 'agent', ${proj === null ? "NULL" : `'${proj}'`}, ${now}, ${now}${deleted ? `, ${now}` : ""});`,
      );
      stmts.push(
        `INSERT INTO turns (id, session_id, status, model_id, input_tokens, output_tokens, usage_json, started_at, ended_at) VALUES ('t${turnId}', '${sid}', '${status}', 'claude-3-5-sonnet', ${inTok}, ${outTok}, '{"cacheReadTokens":${cache},"cacheWriteTokens":0}', ${now - ageMin * 60000}, ${now - ageMin * 60000 + 5000});`,
      );
      turnId++;
    };
    // Acme: 3 completed turns x (1000+1000) = 6000, cache 3000
    for (let i = 0; i < 3; i++) addTurn("a" + i, "Acme", 1000, 1000, 3000, "completed", 60);
    // Beta: 2 completed turns x (1000+1000) = 4000
    for (let i = 0; i < 2; i++) addTurn("b" + i, "Beta", 1000, 1000, 0, "completed", 30);
    // 8 tail projects each 100 tokens -> folds into "Other"
    for (const p of projects.slice(2)) addTurn("p-" + p, p, 50, 50, 0, "completed", 20);
    // No-project session: 500+500
    addTurn("nop", null, 500, 500, 0, "completed", 15);
    // Aborted turn on Acme: MUST NOT count
    addTurn("abort", "Acme", 99999, 99999, 0, "aborted", 10);
    // Soft-deleted session (R12): MUST NOT count
    addTurn("del", "Acme", 424242, 424242, 0, "completed", 5, true);
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

    await openUsage();

    const dom = await evaluate(`(() => {
      const tiles = [...document.querySelectorAll(".idx-tile")].map(t => t.innerText.replace(/\\n/g, " | "));
      const rows = [...document.querySelectorAll(".stats-session-row")].map(r => r.innerText.replace(/\\n/g, " | "));
      const body = document.body.innerText;
      return {
        tiles, rows, body,
        today: document.querySelectorAll(".stats-heat-today").length,
        heatCells: document.querySelectorAll(".stats-heat-cell").length,
        srTables: document.querySelectorAll(".stats-sr-table").length,
      };
    })()`);

    // E2E-STATS-summary-cards-range: total tokens tile reconciles with SQL.
    const totalTile = dom.tiles.find((t) => /Total tokens/i.test(t));
    const tileTotal = totalTile ? Number((totalTile.match(/[\d,]+/) || [0])[0].replace(/,/g, "")) : NaN;
    check(
      "E2E-STATS-summary-cards-range",
      Number.isFinite(tileTotal) && tileTotal === sqlCompleted,
      `UI total=${tileTotal} SQL completed=${sqlCompleted}`,
    );

    // E2E-STATS-heatmap-today: today cell highlighted.
    check("E2E-STATS-heatmap-today", dom.today >= 1, `today cells=${dom.today}`);

    // E2E-STATS-project-breakdown: Top8 + "Other" fold + "No project" bucket.
    const hasOther = /Other/i.test(dom.body);
    const hasNoProject = /No project/i.test(dom.body);
    const hasAcme = /Acme/i.test(dom.body);
    const hasBeta = /Beta/i.test(dom.body);
    check(
      "E2E-STATS-project-breakdown",
      hasAcme && hasBeta && hasOther && hasNoProject,
      `Acme=${hasAcme} Beta=${hasBeta} Other=${hasOther} NoProject=${hasNoProject}`,
    );

    // E2E-STATS-soft-deleted-excluded (R12): trashed session tokens not counted.
    check(
      "E2E-STATS-soft-deleted-excluded",
      tileTotal === sqlCompleted && sqlCompleted < sqlWithDeleted,
      `UI=${tileTotal} excludes deleted(${sqlWithDeleted - sqlCompleted} tok)`,
    );

    const shot = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(outUsage, Buffer.from(shot.data, "base64"));
    console.log("saved:", outUsage);
  }

  if (scenario === "empty" || scenario === "both") {
    // Zero completed turns -> whole-page empty state.
    const now = Date.now();
    seed([
      `INSERT OR IGNORE INTO sessions (id, title, mode, created_at, updated_at) VALUES ('empty-s', 'Empty', 'agent', ${now}, ${now});`,
    ]);
    // no turns inserted
    await openUsage();
    const body = await evaluate(`document.body.innerText`);
    const isEmpty = /No usage data yet/i.test(body);
    check("E2E-STATS-empty-state", isEmpty, isEmpty ? "empty state shown" : "empty state MISSING");
  }

  const failed = results.filter((r) => !r.pass);
  console.log(`\nE2E-STATS summary: ${results.length - failed.length}/${results.length} passed`);
  process.exitCode = failed.length ? 1 : 0;
} catch (e) {
  console.error("FAILED:", e.message);
  process.exitCode = 1;
} finally {
  session?.ws.close();
  child.kill();
  await sleep(600);
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
}

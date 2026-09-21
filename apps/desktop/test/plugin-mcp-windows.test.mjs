// Windows command resolution for stdio MCP spawn (issue #571): npm's npx is a
// .cmd batch script that CreateProcess cannot execute, so a bare spawn always
// fails with ENOENT on Windows regardless of PATH. The resolver wraps such
// launches through %COMSPEC% /d /s /c while keeping arguments literal.
import assert from "node:assert/strict";
import test from "node:test";

import { resolveWindowsCommandLaunch } from "../electron/main/plugin-mcp.ts";

const WIN = { platform: "win32", comspec: "C:\\Windows\\system32\\cmd.exe" };

test("non-Windows platforms never wrap", () => {
  assert.equal(resolveWindowsCommandLaunch("npx", { platform: "darwin" }), null);
  assert.equal(resolveWindowsCommandLaunch("npx", { platform: "linux" }), null);
});

test("a command already carrying .cmd/.bat is wrapped directly", () => {
  const launch = resolveWindowsCommandLaunch("C:\\tools\\npx.cmd", WIN);
  assert.deepEqual(launch, {
    command: "C:\\Windows\\system32\\cmd.exe",
    argsPrefix: ["/d", "/s", "/c", "C:\\tools\\npx.cmd"],
  });
  // Case-insensitive, relative path, .bat.
  assert.ok(resolveWindowsCommandLaunch("scripts\\run.BAT", WIN));
  assert.ok(resolveWindowsCommandLaunch("run.bat", WIN));
});

test("a bare name resolving to a .cmd via where is wrapped with the full path", () => {
  const lookups = [];
  const launch = resolveWindowsCommandLaunch("npx", {
    ...WIN,
    lookup: (name) => {
      lookups.push(name);
      return "C:\\Program Files\\nodejs\\npx.cmd";
    },
  });
  assert.deepEqual(lookups, ["npx"]);
  assert.deepEqual(launch, {
    command: "C:\\Windows\\system32\\cmd.exe",
    argsPrefix: ["/d", "/s", "/c", "C:\\Program Files\\nodejs\\npx.cmd"],
  });
});

test("a bare name resolving to a real executable stays unwrapped", () => {
  const launch = resolveWindowsCommandLaunch("uvx", {
    ...WIN,
    lookup: () => "C:\\Python312\\Scripts\\uvx.exe",
  });
  assert.equal(launch, null);
});

test("an unresolvable bare name keeps the existing ENOENT flow", () => {
  assert.equal(resolveWindowsCommandLaunch("nope", { ...WIN, lookup: () => null }), null);
  assert.equal(
    resolveWindowsCommandLaunch("nope", {
      ...WIN,
      lookup: () => {
        throw new Error("where.exe missing");
      },
    }),
    null,
  );
});

test("paths without script extensions are never wrapped or looked up", () => {
  let called = false;
  const opts = {
    ...WIN,
    lookup: () => {
      called = true;
      return null;
    },
  };
  assert.equal(resolveWindowsCommandLaunch("C:\\tools\\server.exe", opts), null);
  assert.equal(resolveWindowsCommandLaunch("C:\\tools\\serve", opts), null);
  assert.equal(called, false);
});

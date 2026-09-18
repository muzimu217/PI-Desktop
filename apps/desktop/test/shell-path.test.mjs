import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { EventEmitter } from "node:events";

import {
  augmentedPath,
  extractUserPathFromOutput,
  mergePathDirs,
  userPathCandidates,
  warmUserShellPath,
} from "../electron/main/shell-path.ts";
import { McpServerClient, mcpProcessEnv } from "../electron/main/plugin-mcp.ts";

const isWindows = process.platform === "win32";

test("mergePathDirs deduplicates while preserving first-seen order", () => {
  assert.deepEqual(
    mergePathDirs(["/usr/bin", "/bin", "/usr/bin"], ["/bin", "/opt/homebrew/bin"]),
    ["/usr/bin", "/bin", "/opt/homebrew/bin"],
  );
  assert.deepEqual(mergePathDirs([], ["/a", "/a", "/b"]), ["/a", "/b"]);
  assert.deepEqual(mergePathDirs(["/a", ""], []), ["/a"]);
});

test("extractUserPathFromOutput takes the last line containing a slash", () => {
  // A login shell prints setup noise before the PATH echo.
  assert.equal(
    extractUserPathFromOutput(
      "Last login: Mon Sep 18 09:00:00 on ttys000\nshell-init: determining user home\n/usr/bin:/bin:/opt/homebrew/bin\n",
    ),
    "/usr/bin:/bin:/opt/homebrew/bin",
  );
  assert.equal(
    extractUserPathFromOutput("noise without slashes\n/usr/local/bin:/bin\nmore noise\n/opt/homebrew/bin:/usr/bin"),
    "/opt/homebrew/bin:/usr/bin",
  );
  assert.equal(extractUserPathFromOutput("no path here\n"), undefined);
  assert.equal(extractUserPathFromOutput(""), undefined);
  // CRLF output from a shell that went through a pty.
  assert.equal(extractUserPathFromOutput("/bin:/usr/bin\r\n"), "/bin:/usr/bin");
});

const posixOnly = isWindows ? test.skip : test;

posixOnly("userPathCandidates appends the fallback tool directories that exist", () => {
  const original = process.env.PATH;
  try {
    process.env.PATH = "/usr/bin:/bin";
    const candidates = userPathCandidates();
    assert.deepEqual(candidates.slice(0, 2), ["/usr/bin", "/bin"]);
    for (const dir of [
      "/usr/local/bin",
      "/usr/local/sbin",
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/opt",
      join(process.env.HOME ?? "", ".local/bin"),
      join(process.env.HOME ?? "", ".cargo/bin"),
    ]) {
      if (existsSync(dir)) {
        assert.ok(candidates.includes(dir), `expected ${dir} among candidates`);
      } else {
        assert.ok(!candidates.includes(dir), `did not expect ${dir} among candidates`);
      }
    }
  } finally {
    process.env.PATH = original;
  }
});

posixOnly("augmentedPath carries the homebrew tool directories", () => {
  const original = process.env.PATH;
  try {
    process.env.PATH = "/usr/bin:/bin";
    const segments = augmentedPath().split(delimiter);
    assert.deepEqual(segments.slice(0, 2), ["/usr/bin", "/bin"]);
    for (const dir of ["/usr/local/bin", "/opt/homebrew/bin"]) {
      if (existsSync(dir)) {
        assert.ok(segments.includes(dir), `augmented PATH is missing ${dir}`);
      }
    }
  } finally {
    process.env.PATH = original;
  }
});

test("augmentedPath deduplicates PATH segments and follows env changes", () => {
  const original = process.env.PATH;
  try {
    process.env.PATH = "/usr/bin:/bin:/usr/bin";
    const segments = augmentedPath().split(delimiter);
    assert.equal(segments[0], "/usr/bin");
    assert.equal(segments[1], "/bin");
    assert.equal(segments.filter((dir) => dir === "/usr/bin").length, 1);
    // The cache must recompute when the base PATH changes under it.
    process.env.PATH = "/usr/bin";
    assert.equal(augmentedPath().split(delimiter)[0], "/usr/bin");
  } finally {
    process.env.PATH = original;
  }
});

test("mcpProcessEnv serves the augmented PATH, not the bare process PATH", () => {
  const original = process.env.PATH;
  try {
    process.env.PATH = "/usr/bin:/bin";
    const env = mcpProcessEnv(undefined, {});
    assert.equal(env.PATH, augmentedPath());
    assert.ok(env.PATH.startsWith(`/usr/bin${delimiter}/bin`));
  } finally {
    process.env.PATH = original;
  }
});

/** Minimal stdio child: the transport only needs streams, kill and event taps. */
function fakeStdioChild() {
  return {
    pid: 987_654,
    stdin: { writable: true, write() {}, end() {} },
    stdout: Object.assign(new EventEmitter(), { setEncoding() {} }),
    stderr: Object.assign(new EventEmitter(), { setEncoding() {} }),
    kill() {},
    on() {},
  };
}

test("a stdio mcp server spawn receives the augmented PATH", async (t) => {
  const original = process.env.PATH;
  const captured = [];
  const client = new McpServerClient({
    rootPath: mkdtempSync(join(tmpdir(), "pi-shell-path-")),
    server: { id: "stub", label: "Stub", transport: "stdio", command: "node", args: [] },
    values: {},
    connectTimeoutMs: 250,
    spawnImpl: (command, args, options) => {
      captured.push(options?.env);
      return fakeStdioChild();
    },
  });
  t.after(() => client.close());
  try {
    process.env.PATH = "/usr/bin:/bin";
    await assert.rejects(client.connect(), (error) => {
      assert.equal(error.code, "TIMEOUT");
      return true;
    });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].PATH, augmentedPath());
    assert.ok(captured[0].PATH.startsWith(`/usr/bin${delimiter}/bin`));
  } finally {
    process.env.PATH = original;
  }
});

test("warmUserShellPath resolves, never throws, and keeps the PATH usable", async () => {
  const original = process.env.PATH;
  try {
    process.env.PATH = "/usr/bin:/bin";
    await warmUserShellPath();
    // A second call resolves against the same one-shot probe.
    await warmUserShellPath();
    const segments = augmentedPath().split(delimiter);
    assert.deepEqual(segments.slice(0, 2), ["/usr/bin", "/bin"]);
    assert.ok(segments.length >= 2);
  } finally {
    process.env.PATH = original;
  }
});

if (!isWindows) {
  test("the warm probe leaves every existing fallback directory in place", async () => {
    await warmUserShellPath();
    const segments = augmentedPath().split(delimiter);
    const fallbacks = ["/usr/local/bin", "/opt/homebrew/bin"].filter((dir) => existsSync(dir));
    for (const dir of fallbacks) {
      assert.ok(segments.includes(dir), `augmented PATH is missing ${dir}`);
    }
  });
}

// The probe command stays a fixed execFile: shell path + "-ilc" + "echo $PATH".
test("the login-shell probe never interpolates input into the command", async () => {
  const source = await import("node:fs/promises").then((fs) =>
    fs.readFile(new URL("../electron/main/shell-path.ts", import.meta.url), "utf8"),
  );
  assert.match(source, /execFile\(\s*defaultLoginShell\(\),\s*\n\s*\["-ilc", "echo \$PATH"\]/);
  assert.ok(!/execFile\(`/.test(source), "the probe must not build a command string");
});

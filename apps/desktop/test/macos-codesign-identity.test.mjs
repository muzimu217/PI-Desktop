import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  ensureMacCodesignIdentifier,
  MAC_BUNDLE_ID,
  readMacCodesignIdentifier,
} from "../scripts/macos-codesign-identity.mjs";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

test("packaging binds the macOS codesign identifier after pack", () => {
  assert.equal(packageJson.build.appId, MAC_BUNDLE_ID);
  assert.equal(packageJson.build.afterPack, "./scripts/after-pack.mjs");
});

test(
  "adhoc re-sign replaces Electron identifier with the product bundle id",
  { skip: process.platform !== "darwin" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-desktop-codesign-"));
    const appPath = join(root, "PI-Desktop.app");
    const macos = join(appPath, "Contents", "MacOS");
    try {
      await mkdir(macos, { recursive: true });
      await writeFile(join(macos, "PI-Desktop"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      await writeFile(
        join(appPath, "Contents", "Info.plist"),
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>PI-Desktop</string>
<key>CFBundleIdentifier</key><string>${MAC_BUNDLE_ID}</string>
<key>CFBundleName</key><string>PI-Desktop</string>
</dict></plist>
`,
      );

      const signed = spawnSync(
        "codesign",
        ["--force", "--sign", "-", "--identifier", "Electron", appPath],
        { encoding: "utf8" },
      );
      assert.equal(signed.status, 0, signed.stderr || signed.stdout);
      assert.equal(readMacCodesignIdentifier(appPath).identifier, "Electron");

      const result = ensureMacCodesignIdentifier(appPath, MAC_BUNDLE_ID);
      assert.equal(result.status, "adhoc-signed");
      assert.equal(result.previous, "Electron");
      assert.equal(result.identifier, MAC_BUNDLE_ID);
      assert.equal(readMacCodesignIdentifier(appPath).identifier, MAC_BUNDLE_ID);

      const second = ensureMacCodesignIdentifier(appPath, MAC_BUNDLE_ID);
      assert.equal(second.status, "unchanged");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

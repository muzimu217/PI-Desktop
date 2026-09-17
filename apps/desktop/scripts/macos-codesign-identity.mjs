#!/usr/bin/env node
/**
 * Keep the macOS code-signing identifier equal to CFBundleIdentifier.
 *
 * Unsigned electron-builder packs leave Electron's adhoc signature
 * (`Identifier=Electron`) on PI-Desktop.app. usernotificationsd then refuses
 * requests for the product bundle ID (issue #524).
 *
 * Developer ID signatures are left untouched. A mismatch there is a packaging
 * bug and must fail the build rather than be overwritten with an adhoc sign.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

export const MAC_BUNDLE_ID = "net.aiuo.pi-desktop";

export function dumpMacCodesign(appPath) {
  const result = spawnSync("codesign", ["-dv", "--verbose=4", appPath], {
    encoding: "utf8",
  });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

export function readMacCodesignIdentifier(appPath) {
  const dump = dumpMacCodesign(appPath);
  return {
    dump,
    identifier: dump.match(/^Identifier=(.+)$/m)?.[1] ?? null,
    developerId: /Authority=Developer ID Application/.test(dump),
    unsigned: /code object is not signed at all/i.test(dump),
  };
}

export function ensureMacCodesignIdentifier(appPath, bundleId = MAC_BUNDLE_ID) {
  if (process.platform !== "darwin") {
    return { status: "skipped", reason: "not-darwin" };
  }
  if (!existsSync(appPath)) {
    throw new Error(`macOS app bundle not found: ${appPath}`);
  }

  const current = readMacCodesignIdentifier(appPath);
  if (current.developerId) {
    if (current.identifier !== bundleId) {
      throw new Error(
        `Developer ID identifier is ${current.identifier ?? "missing"}, expected ${bundleId}`,
      );
    }
    return { status: "unchanged", reason: "developer-id", identifier: current.identifier };
  }
  if (current.identifier === bundleId) {
    return { status: "unchanged", reason: "already-matching", identifier: current.identifier };
  }

  const signed = spawnSync(
    "codesign",
    ["--force", "--sign", "-", "--identifier", bundleId, appPath],
    { encoding: "utf8" },
  );
  if (signed.status !== 0) {
    throw new Error(
      `adhoc codesign failed for ${appPath}: ${signed.stderr || signed.stdout || signed.status}`,
    );
  }

  const next = readMacCodesignIdentifier(appPath);
  if (next.identifier !== bundleId) {
    throw new Error(
      `adhoc codesign left identifier ${next.identifier ?? "missing"}, expected ${bundleId}`,
    );
  }
  return { status: "adhoc-signed", identifier: next.identifier, previous: current.identifier };
}

#!/usr/bin/env node
import path from "node:path";
import { ensureMacCodesignIdentifier } from "./macos-codesign-identity.mjs";

export default async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  const appName = context.packager.appInfo.productFilename;
  const bundleId = context.packager.appInfo.id;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  const result = ensureMacCodesignIdentifier(appPath, bundleId);
  if (result.status === "adhoc-signed") {
    console.log(
      `macOS codesign identifier ${result.previous ?? "(unsigned)"} → ${result.identifier}`,
    );
  }
}

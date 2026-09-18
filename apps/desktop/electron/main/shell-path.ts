import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * A Finder/Dock launch hands Electron only the system PATH stub
 * (/usr/bin:/bin:/usr/sbin:/sbin), while `uvx`, `npx` and friends live in
 * Homebrew, nvm or user-local prefixes — the `spawn uvx ENOENT` of issue #571.
 *
 * Two layers cover it:
 *  1. `augmentedPath()` — synchronous, zero-probe: the current PATH plus every
 *     well-known tool prefix that exists on disk. Always available, so a child
 *     spawned before any probe completes still finds Homebrew tools.
 *  2. `warmUserShellPath()` — asks the user's login shell for its real PATH
 *     once, in the background, and merges the result in so nvm-style installs
 *     resolve too.
 *
 * The probed PATH only ever feeds child `env.PATH` values; the main process
 * environment is never rewritten.
 */

/** Common tool prefixes a GUI-launched process misses on macOS/Linux. */
const FALLBACK_SEARCH_DIRS = [
  "/usr/local/bin",
  "/usr/local/sbin",
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/opt",
  "~/.local/bin",
  "~/.cargo/bin",
] as const;

/** A wedged login shell must not hold anything up; the fallback already applies. */
const SHELL_PROBE_TIMEOUT_MS = 4_000;

/** Extra directories learned from the login shell (layer 2), merged in order. */
let shellDiscoveredDirs: string[] = [];
/** Bumped whenever layer 2 learns something, so the augmentedPath cache recomputes. */
let shellDiscoveredEpoch = 0;
let cachedPath: string | null = null;
let cachedBasePath: string | null = null;
let cachedEpoch = -1;
let shellProbePromise: Promise<void> | null = null;

/**
 * Merge PATH directory lists, deduplicated with the first occurrence winning
 * (a user's own PATH entry outranks a probed or fallback duplicate).
 */
export function mergePathDirs(base: string[], extra: string[]): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const dir of [...base, ...extra]) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    merged.push(dir);
  }
  return merged;
}

/**
 * The PATH line in login-shell output: the last line containing "/", because
 * startup scripts print `shell-init`/`Last login` noise above it.
 */
export function extractUserPathFromOutput(raw: string): string | undefined {
  const lines = raw.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (line.includes("/")) return line;
  }
  return undefined;
}

function existingFallbackDirs(): string[] {
  // Windows GUI processes inherit the user PATH from the registry; adding
  // POSIX prefixes there would be dead weight.
  if (process.platform === "win32") return [];
  const home = homedir();
  const found: string[] = [];
  for (const dir of FALLBACK_SEARCH_DIRS) {
    const expanded = dir.startsWith("~") ? join(home, dir.slice(1)) : dir;
    if (existsSync(expanded)) found.push(expanded);
  }
  return found;
}

/**
 * Directories for the augmented PATH: every segment of the current process
 * PATH (deduplicated, order preserved) plus the fallback prefixes that exist
 * on this machine. Windows returns only the current PATH segments.
 */
export function userPathCandidates(): string[] {
  const base = (process.env.PATH ?? "").split(delimiter);
  return mergePathDirs(base, existingFallbackDirs());
}

/**
 * PATH for spawned children — synchronous and cached, so any spawn site can
 * use it inline. Recomputed when `process.env.PATH` changes or the login-shell
 * probe lands (tests rely on both).
 */
export function augmentedPath(): string {
  const base = process.env.PATH ?? "";
  if (cachedPath === null || cachedBasePath !== base || cachedEpoch !== shellDiscoveredEpoch) {
    cachedPath = mergePathDirs(userPathCandidates(), shellDiscoveredDirs).join(delimiter);
    cachedBasePath = base;
    cachedEpoch = shellDiscoveredEpoch;
  }
  return cachedPath;
}

function defaultLoginShell(): string {
  return process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
}

/**
 * Ask the user's login shell for its real PATH once per process (nvm, mise and
 * friends live outside every fallback prefix). Fixed argv — shell path plus
 * `echo $PATH`, no user input — with a short timeout, and every failure is a
 * silent fallback to the layer-1 answer. Never rewrites the main process env.
 */
export function warmUserShellPath(): Promise<void> {
  if (process.platform === "win32") return Promise.resolve();
  if (shellProbePromise) return shellProbePromise;
  shellProbePromise = new Promise<void>((resolve) => {
    execFile(
      defaultLoginShell(),
      ["-ilc", "echo $PATH"],
      { encoding: "utf8", timeout: SHELL_PROBE_TIMEOUT_MS },
      (error, stdout) => {
        try {
          const raw = extractUserPathFromOutput(String(stdout ?? ""));
          if (raw) {
            const merged = mergePathDirs(shellDiscoveredDirs, raw.split(delimiter));
            if (merged.length > shellDiscoveredDirs.length) {
              shellDiscoveredDirs = merged;
              shellDiscoveredEpoch += 1;
            }
          }
        } catch {
          // The probe is best effort; layer 1 already covers the common case.
        }
        resolve();
      },
    );
  });
  return shellProbePromise;
}

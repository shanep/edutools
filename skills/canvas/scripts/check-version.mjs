#!/usr/bin/env node
// Report which edutools the canvas skill is driving, and whether it can be trusted
// to be current.
//
// The skill lives in the edutools checkout (~/.claude/skills/canvas is a symlink to
// skills/canvas), and `npm run install:cli` links the edutools on PATH to that same
// checkout's bundle. So the questions are about the checkout: is the installed
// bundle the one the checkout would build, is the checkout behind origin or behind
// the latest release, and does it hold work that is not pushed.
//
// Usage: node check-version.mjs [--json]
// Exit 0 when there is nothing to warn about, 1 when there is.
//
// Node rather than a shell script so it runs the same on Windows.

import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Everything worth a warning, in the order the user should act on it.
 * @param {import("./check-version.d.mts").VersionState} state
 * @param {(a: string, b: string) => number} compare semver precedence
 * @returns {string[]}
 */
export function assess(state, compare) {
  const warnings = [];
  const { installed, checkout } = state;
  if (!installed.version) {
    warnings.push(`edutools is not on PATH. From ${checkout.root}, run: npm ci && npm run install:cli`);
  } else {
    if (installed.path && !installed.fromCheckout) {
      warnings.push(`the edutools on PATH (${installed.path}) is not linked to this checkout (${checkout.root})`);
    }
    if (checkout.version && installed.version !== checkout.version) {
      warnings.push(
        `the installed edutools (${installed.version}) is not a build of the checkout as it is now (${checkout.version}). Rebuild it: npm run install:cli`,
      );
    }
    if (state.latestRelease && isSemver(installed.version) && compare(installed.version, state.latestRelease) < 0) {
      warnings.push(`edutools ${installed.version} is out of date: the latest release is ${state.latestRelease}`);
    }
  }
  if (checkout.upstream === null) {
    warnings.push(`the checkout is on ${checkout.branch}, which does not track a branch on origin`);
  } else {
    if (checkout.behind > 0) {
      warnings.push(
        `the checkout is ${plural(checkout.behind, "commit")} behind ${checkout.upstream}. Update it: git pull && npm run install:cli`,
      );
    }
    if (checkout.ahead > 0) {
      warnings.push(`${plural(checkout.ahead, "local commit")} not pushed to ${checkout.upstream}`);
    }
  }
  if (checkout.uncommitted > 0) {
    warnings.push(`${plural(checkout.uncommitted, "file")} with uncommitted changes in ${checkout.root}`);
  }
  if (!state.fetched) {
    warnings.push("could not reach origin, so the latest release and how far behind the checkout is may be stale");
  }
  return warnings;
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function isSemver(version) {
  return /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version);
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20000 }).trim();
}

function tryGit(root, args) {
  try {
    return git(root, args);
  } catch {
    return null;
  }
}

/** The first `edutools` on PATH, the way the shell would find it. */
function findOnPath() {
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".CMD;.EXE").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, `edutools${extension.toLowerCase()}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function installedEdutools(root) {
  const found = findOnPath();
  if (!found) return { version: null, path: null, fromCheckout: false };
  let version = null;
  try {
    // The Windows npm shim is a .cmd, which only runs through a shell.
    const out = execFileSync(found, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      shell: process.platform === "win32",
      timeout: 20000,
    });
    version = out.trim().replace(/^edutools\s+/, "") || null;
  } catch {
    version = null;
  }
  // On macOS and Linux the PATH entry is a symlink into the linked package; the
  // Windows shim is a file that points there, so it cannot be followed and the
  // version comparison has to stand in for it.
  let real = found;
  try {
    real = realpathSync(found);
  } catch {}
  const fromCheckout = process.platform === "win32" || isInside(real, root);
  return { version, path: found, fromCheckout };
}

function isInside(file, dir) {
  const relative = path.relative(dir, file);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function gather(root, versions) {
  const fetched = tryGit(root, ["fetch", "--quiet", "--tags", "origin"]) !== null;
  const branch = tryGit(root, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "HEAD";
  const upstream = tryGit(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const count = (range) => Number(tryGit(root, ["rev-list", "--count", range]) ?? "0");
  const status = tryGit(root, ["status", "--porcelain"]) ?? "";
  let checkoutVersion = null;
  try {
    checkoutVersion = versions.gitVersion(root);
  } catch {}
  return {
    fetched,
    latestRelease: versions.latestVersion((tryGit(root, ["tag", "--list", "v*"]) ?? "").split("\n")),
    installed: installedEdutools(root),
    checkout: {
      root,
      version: checkoutVersion,
      branch,
      upstream,
      ahead: upstream ? count(`${upstream}..HEAD`) : 0,
      behind: upstream ? count(`HEAD..${upstream}`) : 0,
      uncommitted: status ? status.split("\n").length : 0,
    },
  };
}

function main() {
  // Node resolves the skill symlink for the entry script, so this is the checkout.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const versions = createRequire(import.meta.url)(path.join(root, "scripts/version.cjs"));
  const state = gather(root, versions);
  const warnings = assess(state, versions.compareVersions);
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ ...state, warnings }, null, 2)}\n`);
  } else {
    const { installed, checkout } = state;
    const lines = [
      `edutools ${installed.version ?? "(not installed)"}${installed.path ? `  ${installed.path}` : ""}`,
      `checkout ${checkout.version ?? "unknown"}  ${checkout.root} (${checkout.branch})`,
      `latest release ${state.latestRelease ?? "none"}`,
    ];
    for (const warning of warnings) lines.push(`warning: ${warning}`);
    if (warnings.length === 0) lines.push("up to date, with nothing unpushed");
    process.stdout.write(`${lines.join("\n")}\n`);
  }
  process.exitCode = warnings.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) main();

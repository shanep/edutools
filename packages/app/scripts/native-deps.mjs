// Put each native module's binary for every target architecture next to its
// loader, before electron-builder packages the app.
//
// npm installs only the binary for the machine it runs on, so an Apple Silicon
// runner building the Intel .dmg would ship an app whose native modules cannot
// load. Both napi-rs loaders used here (the keychain, and the CSS inliner the
// markdown renderer uses) look for `<binary>.<target>.node` beside their own
// index.js before they look for a platform package, so copying each binary there
// makes one node_modules serve every architecture.
//
// Usage: node scripts/native-deps.mjs darwin-arm64 darwin-x64 win32-x64-msvc

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

// The package, and the name its binaries and platform packages are built from.
const MODULES = [
  { pkg: "@napi-rs/keyring", binary: "keyring" },
  { pkg: "@css-inline/css-inline", binary: "css-inline" },
];

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("usage: node scripts/native-deps.mjs <target>...  (for example darwin-x64)");
  process.exit(2);
}

for (const { pkg: base, binary } of MODULES) {
  const moduleDir = path.dirname(require.resolve(`${base}/package.json`));
  const { version } = JSON.parse(readFileSync(path.join(moduleDir, "package.json"), "utf8"));
  for (const target of targets) {
    const file = `${binary}.${target}.node`;
    const destination = path.join(moduleDir, file);
    if (existsSync(destination)) {
      console.log(`native-deps: ${file} already present`);
      continue;
    }
    const pkg = `${base}-${target}`;
    let source = null;
    try {
      source = path.join(path.dirname(require.resolve(`${pkg}/package.json`)), file);
    } catch {
      // Not installed for this machine's platform: fetch the published tarball.
      const temp = mkdtempSync(path.join(os.tmpdir(), "edutools-native-"));
      const tarball = execFileSync(npm, ["pack", `${pkg}@${version}`, "--pack-destination", temp, "--silent"], {
        encoding: "utf8",
        shell: process.platform === "win32",
      })
        .trim()
        .split(/\r?\n/)
        .pop();
      execFileSync("tar", ["-xzf", path.join(temp, tarball), "-C", temp]);
      source = path.join(temp, "package", file);
    }
    copyFileSync(source, destination);
    console.log(`native-deps: added ${file} (${pkg}@${version})`);
  }
}

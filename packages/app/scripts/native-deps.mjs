// Put the keychain module's native binary for every target architecture next to
// its loader, before electron-builder packages the app.
//
// npm installs only the binary for the machine it runs on, so an Apple Silicon
// runner building the Intel .dmg would ship an app whose keychain module cannot
// load. @napi-rs/keyring's loader looks for `keyring.<target>.node` beside its own
// index.js before it looks for a platform package, so copying each binary there
// makes one node_modules serve every architecture.
//
// Usage: node scripts/native-deps.mjs darwin-arm64 darwin-x64 win32-x64-msvc

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const keyringDir = path.dirname(require.resolve("@napi-rs/keyring/package.json"));
const { version } = JSON.parse(readFileSync(path.join(keyringDir, "package.json"), "utf8"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error("usage: node scripts/native-deps.mjs <target>...  (for example darwin-x64)");
  process.exit(2);
}

for (const target of targets) {
  const file = `keyring.${target}.node`;
  const destination = path.join(keyringDir, file);
  if (existsSync(destination)) {
    console.log(`native-deps: ${file} already present`);
    continue;
  }
  const pkg = `@napi-rs/keyring-${target}`;
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

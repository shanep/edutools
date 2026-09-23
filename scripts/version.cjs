// The one edutools version, derived from git at build time.
//
// A build on a v* tag is exactly that tag's version. A build past the newest tag
// is a prerelease of the next patch, named by how far past it is and the commit,
// so it sorts after the tag it came from and before the next release. The CLI
// bundle, the desktop app and its installers all take the version from here;
// package.json versions are placeholders and never read.
//
// CommonJS so the electron-builder config (CommonJS) can require it and the ESM
// build scripts can import it, on every Node this repo supports.

const { execFileSync } = require("node:child_process");

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/;

/**
 * Turn `git describe --tags --long --dirty --always --match "v[0-9]*"` output
 * into a semver version.
 * @param {string} described
 * @returns {string}
 */
function versionFromDescribe(described) {
  const text = described.trim();
  const dirty = text.endsWith("-dirty");
  const bare = dirty ? text.slice(0, -"-dirty".length) : text;
  const tagged = /^v(.+)-(\d+)-g([0-9a-f]+)$/.exec(bare);
  if (!tagged) {
    // --always prints only the abbreviated commit when there is no v* tag yet.
    if (!/^[0-9a-f]+$/.test(bare)) throw new Error(`unrecognised git describe output: ${text}`);
    return `0.0.0-dev.g${bare}${dirty ? ".dirty" : ""}`;
  }
  const [, tag = "", distance = "0", sha = ""] = tagged;
  const parts = SEMVER.exec(tag);
  if (!parts) throw new Error(`tag v${tag} is not a semver version`);
  if (distance === "0" && !dirty) return tag;
  const suffix = `dev.${distance}.g${sha}${dirty ? ".dirty" : ""}`;
  // A prerelease tag (v2.0.0-beta.1) already sorts below its release, so extend
  // it; a release tag bumps the patch, or the build would sort below the tag.
  if (parts[4]) return `${tag}.${suffix}`;
  return `${parts[1]}.${parts[2]}.${Number(parts[3]) + 1}-${suffix}`;
}

/**
 * The version of the checkout at `cwd`, or of this repository by default.
 * @param {string} [cwd]
 * @returns {string}
 */
function gitVersion(cwd = __dirname) {
  let described;
  try {
    described = execFileSync("git", ["describe", "--tags", "--long", "--dirty", "--always", "--match", "v[0-9]*"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // A source archive has no .git; build it rather than fail, but visibly unversioned.
    return "0.0.0-unknown";
  }
  return versionFromDescribe(described);
}

module.exports = { versionFromDescribe, gitVersion };

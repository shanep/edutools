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

/**
 * Split a version into its numbers and prerelease identifiers, or null when it
 * is not semver. Build metadata is not used by any edutools version.
 * @param {string} version
 */
function parse(version) {
  const parts = SEMVER.exec(version);
  if (!parts) return null;
  return {
    numbers: [Number(parts[1]), Number(parts[2]), Number(parts[3])],
    pre: parts[4] ? parts[4].slice(1).split(".") : [],
  };
}

/**
 * Compare two semver versions by semver precedence: negative when `a` is older,
 * positive when newer, zero when equal.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareVersions(a, b) {
  const left = parse(a);
  const right = parse(b);
  if (!left) throw new Error(`${a} is not a semver version`);
  if (!right) throw new Error(`${b} is not a semver version`);
  for (let i = 0; i < 3; i++) {
    const diff = (left.numbers[i] ?? 0) - (right.numbers[i] ?? 0);
    if (diff !== 0) return diff;
  }
  // A release sorts after any prerelease of the same numbers.
  if (left.pre.length === 0 || right.pre.length === 0) return right.pre.length - left.pre.length;
  for (let i = 0; i < Math.min(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i] ?? "";
    const y = right.pre[i] ?? "";
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return Number(x) - Number(y);
    // Numeric identifiers sort before alphanumeric ones.
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return left.pre.length - right.pre.length;
}

/**
 * The next release after `version` for a major, minor or patch bump. A
 * prerelease part is dropped, so bump from the last release.
 * @param {string} version
 * @param {"major" | "minor" | "patch"} part
 * @returns {string}
 */
function bumpVersion(version, part) {
  const parsed = parse(version);
  if (!parsed) throw new Error(`${version} is not a semver version`);
  const [major = 0, minor = 0, patch = 0] = parsed.numbers;
  if (part === "major") return `${major + 1}.0.0`;
  if (part === "minor") return `${major}.${minor + 1}.0`;
  if (part === "patch") return `${major}.${minor}.${patch + 1}`;
  throw new Error(`unknown bump ${part}: use major, minor or patch`);
}

/**
 * The newest semver version among tag names, ignoring anything that is not a
 * v-prefixed semver tag, or null when there is none.
 * @param {readonly string[]} tags
 * @returns {string | null}
 */
function latestVersion(tags) {
  let latest = null;
  for (const tag of tags) {
    const name = tag.trim();
    if (!name.startsWith("v") || !parse(name.slice(1))) continue;
    const version = name.slice(1);
    if (latest === null || compareVersions(version, latest) > 0) latest = version;
  }
  return latest;
}

module.exports = { versionFromDescribe, gitVersion, compareVersions, bumpVersion, latestVersion };

#!/usr/bin/env bash
# Release edutools: tag a version and push the tag.
#
# Pushing a v* tag is the whole release. CI builds and smoke-tests the installers
# for the tag and publishes them as the tag's GitHub release (.github/workflows/ci.yml),
# and every build takes its version from the tag (scripts/version.cjs). This script
# only makes sure the tag lands on the right commit: master, clean, pushed, checked.
#
# Usage: scripts/create-release.sh [-n] [-y] <major|minor|patch|X.Y.Z[-pre]>
#   major, minor, patch   bump the newest v* tag
#   X.Y.Z[-pre]           release exactly this version (v prefix optional)
#   -n                    dry run: check everything, then say what would happen
#   -y                    do not ask for confirmation

set -euo pipefail

usage() {
  sed -n 's/^# \{0,1\}//; 9,13p' "$0" >&2
  exit 2
}

die() {
  echo "create-release: $*" >&2
  exit 1
}

dry_run=0
assume_yes=0
while getopts "nyh" opt; do
  case "$opt" in
    n) dry_run=1 ;;
    y) assume_yes=1 ;;
    *) usage ;;
  esac
done
shift $((OPTIND - 1))
[ $# -eq 1 ] || usage
requested="$1"

root="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not inside a git checkout"
cd "$root"
[ -f scripts/version.cjs ] || die "not the edutools repository: $root"
command -v node >/dev/null || die "node is not on PATH"

# Everything version-shaped goes through scripts/version.cjs, so this script and
# the builds agree on what a version is and how versions order.
version_js() {
  node -e "const v = require('./scripts/version.cjs'); $1" -- "${@:2}"
}

branch="$(git rev-parse --abbrev-ref HEAD)"
[ "$branch" = "master" ] || die "releases are cut from master, and this is $branch"
[ -z "$(git status --porcelain)" ] || die "the working tree has uncommitted changes; commit or stash them first"

echo "Fetching origin..." >&2
git fetch --quiet --tags origin master
head="$(git rev-parse HEAD)"
upstream="$(git rev-parse origin/master)"
if [ "$head" != "$upstream" ]; then
  ahead="$(git rev-list --count origin/master..HEAD)"
  behind="$(git rev-list --count HEAD..origin/master)"
  die "master is $ahead ahead and $behind behind origin/master; push or pull so the release is a commit CI has seen"
fi

latest="$(git tag --list 'v*' | version_js 'const t = require("fs").readFileSync(0, "utf8").split("\n"); process.stdout.write(v.latestVersion(t) ?? "")')"

case "$requested" in
  major | minor | patch)
    [ -n "$latest" ] || die "there is no v* tag to bump; give the version, such as 1.0.0"
    version="$(version_js 'process.stdout.write(v.bumpVersion(process.argv[1], process.argv[2]))' "$latest" "$requested")"
    ;;
  *)
    version="${requested#v}"
    version_js 'v.compareVersions(process.argv[1], process.argv[1])' "$version" 2>/dev/null ||
      die "$requested is not a semver version such as 2.1.0 or 2.1.0-beta.1"
    ;;
esac
tag="v$version"

if git rev-parse --quiet --verify "refs/tags/$tag" >/dev/null; then
  die "$tag already exists"
fi
if [ -n "$(git ls-remote --tags origin "refs/tags/$tag")" ]; then
  die "$tag already exists on origin"
fi
if [ -n "$latest" ]; then
  order="$(version_js 'process.stdout.write(String(Math.sign(v.compareVersions(process.argv[1], process.argv[2]))))' "$version" "$latest")"
  [ "$order" = "1" ] || die "$version is not newer than the latest release, $latest"
fi

echo "Running the checks (npm run check)..." >&2
npm run check >/dev/null 2>&1 || die "npm run check failed; run it to see why"

cat >&2 <<EOF

  Release    $tag
  Commit     $(git log -1 --format='%h %s')
  Previous   ${latest:+v}${latest:-none}

Pushing $tag makes CI build the installers and publish the GitHub release.
EOF

if [ "$dry_run" -eq 1 ]; then
  echo "Dry run: nothing was tagged or pushed." >&2
  exit 0
fi

if [ "$assume_yes" -ne 1 ]; then
  printf 'Release %s? [y/N] ' "$tag" >&2
  read -r answer
  case "$answer" in
    y | Y | yes | YES) ;;
    *) die "not released" ;;
  esac
fi

git tag -a "$tag" -m "edutools $version"
git push --quiet origin "$tag"

# github.com/owner/repo from either an https or an ssh remote.
slug="$(git remote get-url origin | sed -E 's#^(https://|git@)github\.com[:/]##; s#\.git$##')"
echo "Tagged and pushed $tag." >&2
echo "Build:   https://github.com/$slug/actions" >&2
echo "Release: https://github.com/$slug/releases/tag/$tag (appears when the build passes)" >&2

import { describe, expect, it } from "vitest";
import { compareVersions } from "../../../scripts/version.cjs";
import { assess, type VersionState } from "../../../skills/canvas/scripts/check-version.mjs";

function state(overrides: {
  fetched?: boolean;
  latestRelease?: string | null;
  installed?: Partial<VersionState["installed"]>;
  checkout?: Partial<VersionState["checkout"]>;
}): VersionState {
  return {
    fetched: overrides.fetched ?? true,
    latestRelease: overrides.latestRelease === undefined ? "2.0.0" : overrides.latestRelease,
    installed: { version: "2.0.0", path: "/bin/edutools", fromCheckout: true, ...overrides.installed },
    checkout: {
      root: "/repo",
      version: "2.0.0",
      branch: "master",
      upstream: "origin/master",
      ahead: 0,
      behind: 0,
      uncommitted: 0,
      ...overrides.checkout,
    },
  };
}

describe("the skill's version check", () => {
  it("has nothing to say about a current build of a clean, pushed checkout", () => {
    expect(assess(state({}), compareVersions)).toEqual([]);
  });

  it("says how to install edutools when it is not on PATH", () => {
    const warnings = assess(state({ installed: { version: null, path: null, fromCheckout: false } }), compareVersions);

    expect(warnings).toEqual(["edutools is not on PATH. From /repo, run: npm ci && npm run install:cli"]);
  });

  it("flags a stale build and one older than the latest release", () => {
    const warnings = assess(
      state({ latestRelease: "2.1.0", installed: { version: "2.0.0" }, checkout: { version: "2.1.0" } }),
      compareVersions,
    );

    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("npm run install:cli");
    expect(warnings[1]).toBe("edutools 2.0.0 is out of date: the latest release is 2.1.0");
  });

  it("does not call a dev build past the latest release out of date", () => {
    const version = "2.0.1-dev.3.gabc1234";
    expect(assess(state({ installed: { version }, checkout: { version } }), compareVersions)).toEqual([]);
  });

  it("flags an edutools on PATH that is linked somewhere else", () => {
    const warnings = assess(state({ installed: { fromCheckout: false } }), compareVersions);

    expect(warnings).toEqual(["the edutools on PATH (/bin/edutools) is not linked to this checkout (/repo)"]);
  });

  it("flags a checkout behind origin, unpushed commits and uncommitted files", () => {
    const warnings = assess(state({ checkout: { behind: 3, ahead: 1, uncommitted: 2 } }), compareVersions);

    expect(warnings).toEqual([
      "the checkout is 3 commits behind origin/master. Update it: git pull && npm run install:cli",
      "1 local commit not pushed to origin/master",
      "2 files with uncommitted changes in /repo",
    ]);
  });

  it("flags a branch with no upstream and an unreachable origin", () => {
    const warnings = assess(state({ fetched: false, checkout: { branch: "spike", upstream: null } }), compareVersions);

    expect(warnings).toEqual([
      "the checkout is on spike, which does not track a branch on origin",
      "could not reach origin, so the latest release and how far behind the checkout is may be stale",
    ]);
  });
});

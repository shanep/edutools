import { describe, expect, it } from "vitest";
import { bumpVersion, compareVersions, latestVersion, versionFromDescribe } from "../../../scripts/version.cjs";

describe("versionFromDescribe", () => {
  it("a clean build on a tag is the tag's version", () => {
    expect(versionFromDescribe("v1.2.0-0-gabc1234\n")).toBe("1.2.0");
  });

  it("a build past a tag is a prerelease of the next patch", () => {
    expect(versionFromDescribe("v1.2.0-5-gabc1234")).toBe("1.2.1-dev.5.gabc1234");
  });

  it("uncommitted changes mark the build dirty, even on a tag", () => {
    expect(versionFromDescribe("v1.2.0-0-gabc1234-dirty")).toBe("1.2.1-dev.0.gabc1234.dirty");
    expect(versionFromDescribe("v1.2.0-3-gabc1234-dirty")).toBe("1.2.1-dev.3.gabc1234.dirty");
  });

  it("a build past a prerelease tag extends the prerelease", () => {
    expect(versionFromDescribe("v2.0.0-beta.1-0-gabc1234")).toBe("2.0.0-beta.1");
    expect(versionFromDescribe("v2.0.0-beta.1-4-gabc1234")).toBe("2.0.0-beta.1.dev.4.gabc1234");
  });

  it("a repository with no version tag gets 0.0.0 and the commit", () => {
    expect(versionFromDescribe("abc1234")).toBe("0.0.0-dev.gabc1234");
    expect(versionFromDescribe("abc1234-dirty")).toBe("0.0.0-dev.gabc1234.dirty");
  });

  it("refuses a tag that is not semver", () => {
    expect(() => versionFromDescribe("v1.2-0-gabc1234")).toThrow(/not a semver/);
  });
});

describe("compareVersions", () => {
  it("orders by major, minor and patch numerically", () => {
    expect(compareVersions("2.0.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.1", "1.0.1")).toBe(0);
  });

  it("puts a prerelease before its release and a dev build after the tag it follows", () => {
    expect(compareVersions("2.1.0-beta.1", "2.1.0")).toBeLessThan(0);
    expect(compareVersions("2.0.1-dev.3.gabc1234", "2.0.0")).toBeGreaterThan(0);
    expect(compareVersions("2.0.1-dev.3.gabc1234", "2.0.1")).toBeLessThan(0);
  });

  it("orders prerelease identifiers by semver precedence", () => {
    expect(compareVersions("2.0.1-dev.10.gabc", "2.0.1-dev.9.gdef")).toBeGreaterThan(0);
    expect(compareVersions("2.0.0-alpha", "2.0.0-beta")).toBeLessThan(0);
    expect(compareVersions("2.0.0-beta", "2.0.0-beta.1")).toBeLessThan(0);
  });
});

describe("bumpVersion", () => {
  it("bumps one part and resets the ones below it", () => {
    expect(bumpVersion("2.3.4", "patch")).toBe("2.3.5");
    expect(bumpVersion("2.3.4", "minor")).toBe("2.4.0");
    expect(bumpVersion("2.3.4", "major")).toBe("3.0.0");
  });
});

describe("latestVersion", () => {
  it("picks the newest v-prefixed semver tag and ignores the rest", () => {
    expect(latestVersion(["v1.0.1", "v2.0.0", "v2.0.0-beta.1", "nightly", "v1.10"])).toBe("2.0.0");
    expect(latestVersion(["nightly"])).toBeNull();
  });
});

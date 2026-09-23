import { describe, expect, it } from "vitest";
import { versionFromDescribe } from "../../../scripts/version.cjs";

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

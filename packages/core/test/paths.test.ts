import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { comparePaths, fnmatch, globRepo, isFile } from "@edutools/core/paths";
import { isDraft } from "@edutools/core/publish";
import { describe, expect, it } from "vitest";

describe("paths", () => {
  it("orders paths part by part, as Python sorts Path objects", () => {
    expect(["a-b/x", "a/b"].sort(comparePaths)).toEqual(["a/b", "a-b/x"]);
  });

  it("globs repo keys with forward slashes, in Python's order", () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "edutools-"));
    mkdirSync(path.join(repo, "a"));
    mkdirSync(path.join(repo, "a-b"));
    writeFileSync(path.join(repo, "a", "b.md"), "");
    writeFileSync(path.join(repo, "a-b", "x.md"), "");
    expect(globRepo(repo, "*/*.md")).toEqual(["a/b.md", "a-b/x.md"]);
    expect(isFile(repo, "a/b.md")).toBe(true);
    expect(isFile(repo, "a")).toBe(false);
  });

  it("matches like fnmatchcase, where a star crosses slashes", () => {
    expect(fnmatch("due by thursday", "due by *")).toBe(true);
    expect(fnmatch("a/b", "a*")).toBe(true);
    expect(fnmatch("x", "[!x]")).toBe(false);
    expect(fnmatch("lab-1.md", "lab-?.md")).toBe(true);
    expect(fnmatch("Lab", "lab")).toBe(false);
  });
});

describe("isDraft", () => {
  it("reads draft: true from the frontmatter only", () => {
    expect(isDraft("---\ndraft: true\n---\n# A\n")).toBe(true);
    expect(isDraft("# A\n\ndraft: true\n")).toBe(false);
    expect(isDraft("---\ndraft: false\n---\n")).toBe(false);
  });
});

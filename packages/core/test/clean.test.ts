/** The pure rules behind `push --clean`. No Canvas token required. */

import {
  cleanKeep,
  cleanTargets,
  type DeclaredModule,
  type Difference,
  kindIdent,
  studentWork,
} from "@edutools/core/audit";
import { ValueError } from "@edutools/core/publish";
import { describe, expect, it } from "vitest";

function untracked(kind: string, ident: string, title = "x"): Difference {
  return { side: "untracked", kind, ident, title, key: "", detail: "" };
}

describe("clean keep", () => {
  it("keeps native items and the keep list", () => {
    const declared: DeclaredModule[] = [{ title: "M", native: [{ kind: "quiz", ident: "7", title: "" }] }];
    const raw = { clean: { keep: [{ page: "home-page" }, { quiz: 9 }] } };
    expect(cleanKeep(raw, declared)).toEqual(
      new Set([kindIdent("quiz", "7"), kindIdent("page", "home-page"), kindIdent("quiz", "9")]),
    );
  });

  it("keeps only natives without a clean section", () => {
    expect(cleanKeep({}, [])).toEqual(new Set());
  });

  it("rejects a malformed keep entry", () => {
    expect(() => cleanKeep({ clean: { keep: [{ quiz: 1, page: "x" }] } }, [])).toThrow(ValueError);
  });

  it("rejects a clean section that is not a table", () => {
    expect(() => cleanKeep({ clean: ["x"] }, [])).toThrow("canvas.toml [clean] must be a table");
  });
});

describe("clean targets", () => {
  it("never targets files, stale entries or kept objects", () => {
    const differences: Difference[] = [
      untracked("file", "1"),
      untracked("page", "old"),
      untracked("quiz", "7"),
      { side: "stale", kind: "page", ident: "gone", title: "Gone", key: "a.md", detail: "" },
      { side: "pending", kind: "module", ident: "", title: "New", key: "", detail: "" },
    ];
    const targets = cleanTargets(differences, new Set([kindIdent("quiz", "7")]));
    expect(targets.map((t) => [t.kind, t.ident])).toEqual([["page", "old"]]);
  });

  it("deletes modules last", () => {
    const differences = [untracked("module", "5", "A"), untracked("page", "p", "Z")];
    expect(cleanTargets(differences, new Set()).map((t) => t.kind)).toEqual(["page", "module"]);
  });
});

describe("student work", () => {
  it("finds submissions on the backing assignment", () => {
    expect(studentWork("quiz", {}, { has_submitted_submissions: true })).toBe("has submissions");
  });

  it("finds posts in a discussion", () => {
    expect(studentWork("discussion", { discussion_subentry_count: 3 }, null)).toBe("has 3 post(s)");
  });

  it("calls an unused object safe", () => {
    expect(studentWork("assignment", { has_submitted_submissions: false }, null)).toBe("");
  });
});

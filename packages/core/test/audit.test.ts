/**
 * Tests for the two-way manifest audit.
 *
 * Each case builds a small manifest and a small live inventory and checks that
 * the difference fires in exactly one direction, so a stale entry is never
 * mistaken for an untracked object or the reverse.
 */

import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  auditModules,
  auditObjects,
  type DeclaredModule,
  type Difference,
  declaredModules,
  type LiveObject,
  liveAssignments,
  liveFiles,
  liveModules,
  summarise,
} from "@edutools/core/audit";
import { Entry, Manifest, type NativeItem, parseNativeItems, ValueError } from "@edutools/core/publish";
import { describe, expect, it } from "vitest";

function manifestOf(entries: Record<string, Entry> = {}): Manifest {
  const dir = mkdtempSync(path.join(os.tmpdir(), "edutools-"));
  const manifest = new Manifest(path.join(dir, "manifest.json"));
  for (const [key, entry] of Object.entries(entries)) manifest.entries.set(key, entry);
  return manifest;
}

function diff(side: Difference["side"], kind: string, ident: string, title: string, key = "", detail = ""): Difference {
  return { side, kind, ident, title, key, detail };
}

function live(kind: string, ident: string, title: string, published = false, detail = ""): LiveObject {
  return { kind, ident, title, published, detail };
}

function declared(title: string, native: NativeItem[] = []): DeclaredModule {
  return { title, native };
}

const page = (canvasId: string, pageUrl: string, title: string): Entry =>
  new Entry({ kind: "page", canvasId, pageUrl, title });

describe("objects", () => {
  it("is quiet when everything tracked is present", () => {
    const manifest = manifestOf({
      "notes/w1": page("week-1", "week-1", "Week 1"),
      "assignments/p0": new Entry({ kind: "assignment", canvasId: "10", title: "P0" }),
    });
    const liveObjects = [live("page", "week-1", "Week 1"), live("assignment", "10", "P0")];
    expect(auditObjects(manifest, liveObjects, new Set())).toEqual([]);
  });

  it("calls a manifest entry gone from Canvas stale", () => {
    const manifest = manifestOf({ "notes/w1": page("week-1", "week-1", "Week 1") });
    expect(auditObjects(manifest, [], new Set())).toEqual([diff("stale", "page", "week-1", "Week 1", "notes/w1")]);
  });

  it("says so when a stale entry is a draft", () => {
    const manifest = manifestOf({ "notes/w1": page("week-1", "week-1", "Week 1") });
    const result = auditObjects(manifest, [], new Set(["notes/w1"]));
    expect(result[0]?.side).toBe("stale");
    expect(result[0]?.detail).toContain("draft");
  });

  it("calls a Canvas object nobody pushed untracked", () => {
    const result = auditObjects(manifestOf(), [live("quiz", "77", "Midterm Exam", true)], new Set());
    expect(result).toEqual([diff("untracked", "quiz", "77", "Midterm Exam", "", "published")]);
  });

  it("matches pages on url, not id", () => {
    const manifest = manifestOf({ "notes/w1": page("123", "week-1", "Week 1") });
    expect(auditObjects(manifest, [live("page", "week-1", "Week 1")], new Set())).toEqual([]);
  });

  it("ignores syllabus and module entries", () => {
    const manifest = manifestOf({ index: new Entry({ kind: "syllabus", canvasId: "48194", title: "Syllabus" }) });
    expect(auditObjects(manifest, [], new Set())).toEqual([]);
  });

  it("puts stale before untracked and sorts stale by key", () => {
    const manifest = manifestOf({ b: page("b", "b", "B"), a: page("a", "a", "A") });
    const sides = auditObjects(manifest, [live("file", "1", "extra.pdf")], new Set()).map((d) => [
      d.side,
      d.key || d.title,
    ]);
    expect(sides).toEqual([
      ["stale", "a"],
      ["stale", "b"],
      ["untracked", "extra.pdf"],
    ]);
  });
});

describe("live inventory", () => {
  it("leaves quiz and discussion assignments out of plain assignments", () => {
    const assignments = [
      { id: 1, name: "P0", published: true },
      { id: 2, name: "Midterm", is_quiz_assignment: true, quiz_id: 9 },
      { id: 3, name: "Intro", discussion_topic: { id: 4 } },
    ];
    expect(liveAssignments(assignments).map((a) => a.ident)).toEqual(["1"]);
  });

  it("reports a file's size and visibility", () => {
    const files = [{ id: 5, display_name: "a1-worksheet.pdf", size: 100, locked: false, hidden: false }];
    const [obj] = liveFiles(files);
    expect(obj?.title).toBe("a1-worksheet.pdf");
    expect(obj?.published).toBe(true);
    expect(obj?.detail).toBe("100 bytes");
  });

  it("counts a module's items", () => {
    const [obj] = liveModules([{ id: 7, name: "Week 1", published: true }], { "7": [{ id: 1 }, { id: 2 }] });
    expect(obj?.detail).toBe("2 items");
  });
});

describe("modules", () => {
  it("calls a declared module missing in Canvas pending, not stale", () => {
    expect(auditModules([declared("Week 1")], [], {}, manifestOf())).toEqual([
      diff("pending", "module", "", "Week 1", "", "declared in canvas.toml; the next push creates it"),
    ]);
  });

  it("calls a module nobody declared untracked", () => {
    const modules = [live("module", "7", "Old Week", false, "3 items")];
    expect(auditModules([], modules, { "7": [] }, manifestOf())).toEqual([
      diff("untracked", "module", "7", "Old Week", "", "unpublished; 3 items"),
    ]);
  });

  it("reports a hand added item in a tracked module", () => {
    const manifest = manifestOf({ "notes/w1": page("week-1", "week-1", "Week 1") });
    const modules = [live("module", "7", "Week 1", false, "2 items")];
    const items = {
      "7": [
        { id: 1, type: "Page", page_url: "week-1", title: "Week 1" },
        { id: 2, type: "Assignment", content_id: 999, title: "Surprise" },
        { id: 3, type: "SubHeader", title: "Reading" },
      ],
    };
    const result = auditModules([declared("Week 1")], modules, items, manifest);
    expect(result.map((d) => d.title)).toEqual(["Surprise"]);
    expect(result[0]?.kind).toBe("module item");
    expect(result[0]?.detail).toContain("next push removes it");
    expect(result[0]?.detail).toContain("{ assignment = 999 }");
    expect(result[0]?.detail).toBe(
      "assignment in module 'Week 1'; the next push removes it unless canvas.toml lists it as { assignment = 999 }",
    );
  });

  it("does not report an item named under canvas", () => {
    const decl = [declared("Week 8", [{ kind: "quiz", ident: "393662", title: "" }])];
    const modules = [live("module", "7", "Week 8", false, "1 items")];
    const items = { "7": [{ id: 1, type: "Quiz", content_id: 393662, title: "Midterm Exam" }] };
    expect(auditModules(decl, modules, items, manifestOf())).toEqual([]);
  });

  it("reads declared module titles and native items", () => {
    const raw = {
      module: [
        { title: "Week 1", page: "notes/w1.md" },
        { title: "Week 8", canvas: [{ quiz: 393662, title: "Midterm" }] },
        { title: "Broken", canvas: [{ quiz: 1, page: "x" }] },
        "not a table",
      ],
    };
    const result = declaredModules(raw);
    expect(result.map((d) => d.title)).toEqual(["Week 1", "Week 8", "Broken"]);
    expect(result[1]?.native).toEqual([{ kind: "quiz", ident: "393662", title: "Midterm" }]);
    expect(result[2]?.native).toEqual([]);
  });
});

describe("native items", () => {
  it("parses each kind with an optional title", () => {
    const module = {
      canvas: [{ quiz: 1 }, { assignment: "2", title: "Extra" }, { page: "home-page" }, { discussion: 4 }, { file: 5 }],
    };
    expect(parseNativeItems(module)).toEqual([
      { kind: "quiz", ident: "1", title: "" },
      { kind: "assignment", ident: "2", title: "Extra" },
      { kind: "page", ident: "home-page", title: "" },
      { kind: "discussion", ident: "4", title: "" },
      { kind: "file", ident: "5", title: "" },
    ]);
  });

  it("has no items without a canvas list", () => {
    expect(parseNativeItems({ title: "Week 1" })).toEqual([]);
  });

  it("rejects two kinds in one entry", () => {
    expect(() => parseNativeItems({ canvas: [{ quiz: 1, page: "x" }] })).toThrow(ValueError);
    expect(() => parseNativeItems({ canvas: [{ quiz: 1, page: "x" }] })).toThrow(/exactly one of/);
  });

  it("rejects an unknown key", () => {
    expect(() => parseNativeItems({ canvas: [{ quiz: 1, position: 3 }] })).toThrow(/exactly one of/);
  });

  it("rejects a non-table entry", () => {
    expect(() => parseNativeItems({ canvas: [393662] })).toThrow(/expected a table/);
  });

  it("rejects an empty id", () => {
    expect(() => parseNativeItems({ canvas: [{ page: " " }] })).toThrow(/needs an id/);
  });

  it("summarises counts by side and kind", () => {
    const diffs = [diff("stale", "page", "a", "A"), diff("stale", "page", "b", "B"), diff("untracked", "quiz", "1", "Q")];
    expect(summarise(diffs)).toEqual({ "stale page": 2, "untracked quiz": 1 });
  });
});

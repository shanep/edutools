/**
 * The whole-course orchestration: push, verify, audit and the clean sync, driven
 * against a small repo on disk and a fake client. No Canvas token required.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  auditCourse,
  CleanRefusedError,
  CourseError,
  type CourseCanvas,
  courseDates,
  courseOutline,
  executeClean,
  NothingToVerifyError,
  planClean,
  push,
  UnmatchedPathError,
  verifyCourse,
  writePreview,
} from "@edutools/core/course";
import type { Payload } from "@edutools/core/types";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";

const COURSE = "42";

const TOML = `[term]
timezone = "America/Boise"
first_monday = 2026-08-24
weeks = 15
last_day_of_instruction = 2026-12-11
finals_start = 2026-12-14
finals_end = 2026-12-18
total_points = 0

[term.policy.project]
due = "tue 23:59"

[layout]
syllabus = "index.md"
pages = ["pages/*.md"]
files = []

[layout.gradable]
project = "assignments/p[0-9]*.md"

[[module]]
title = "Week 1"
items = ["pages/welcome.md", "assignments/p0.md"]
canvas = [{ quiz = 900, title = "Exam 1" }]
`;

function makeRepo(): string {
  const repo = mkdtempSync(path.join(os.tmpdir(), "edutools-"));
  mkdirSync(path.join(repo, "assignments"));
  mkdirSync(path.join(repo, "pages"));
  writeFileSync(path.join(repo, "canvas.toml"), TOML, "utf-8");
  writeFileSync(path.join(repo, "index.md"), "# Syllabus\n\nRead [the welcome](pages/welcome.md).\n", "utf-8");
  writeFileSync(path.join(repo, "pages", "welcome.md"), "# Welcome\n\nHello.\n", "utf-8");
  writeFileSync(path.join(repo, "assignments", "p0.md"), "# P0\n\n**Week 2 · 50 points · x**\n", "utf-8");
  writeFileSync(path.join(repo, "assignments", "p1.md"), "# P1\n\n**Week 4 · 100 points · x**\n", "utf-8");
  return repo;
}

function writeManifest(repo: string, entries: Record<string, Payload>): void {
  mkdirSync(path.join(repo, ".canvas"), { recursive: true });
  writeFileSync(path.join(repo, ".canvas", `manifest-${COURSE}.json`), JSON.stringify({ entries }), "utf-8");
}

function manifestOf(repo: string): Record<string, Payload> {
  return JSON.parse(readFileSync(path.join(repo, ".canvas", `manifest-${COURSE}.json`), "utf-8")).entries;
}

type Fake = { [K in keyof CourseCanvas]: Mock<CourseCanvas[K]> };

/**
 * Every method answers something plausible, and each one counts how many calls
 * are in flight at once, so a test can prove the writes never overlapped.
 */
function fakeCanvas(): Fake & { maxInFlight: () => number } {
  let inFlight = 0;
  let peak = 0;
  let id = 100;
  const created = () => {
    id += 1;
    return { id: String(id) };
  };
  // A record keyed by every method, so the compiler insists none is missing.
  const answers: Record<keyof CourseCanvas, () => unknown> = {
    getJson: () => ({}),
    exists: () => true,
    updateSyllabus: () => ({}),
    listAssignmentGroups: () => [],
    createAssignmentGroup: created,
    updateAssignmentGroup: () => ({}),
    setGroupWeighting: () => ({}),
    createPage: () => ({ url: "welcome" }),
    updatePage: () => ({}),
    createAssignment: created,
    updateAssignment: () => ({}),
    createDiscussion: created,
    updateDiscussion: () => ({}),
    createQuiz: created,
    updateQuiz: () => ({}),
    listQuizQuestions: () => [],
    createQuizQuestion: created,
    deleteQuizQuestion: () => undefined,
    uploadFile: created,
    downloadBytes: () => Buffer.alloc(0),
    listModules: () => [],
    createModule: () => ({ id: "9" }),
    updateModule: () => ({}),
    listModuleItems: () => [],
    createModuleItem: created,
    deleteModuleItem: () => undefined,
    createRubric: created,
    listPages: () => [],
    getPage: () => ({}),
    getAssignments: () => [],
    getAssignmentFull: () => ({}),
    listDiscussions: () => [],
    getDiscussion: () => ({}),
    listQuizzes: () => [],
    getQuiz: () => ({}),
    listFiles: () => [],
    getFile: () => ({}),
    listJson: () => [],
    getObject: () => ({}),
    deleteObject: () => ({}),
  };
  const fake = Object.fromEntries(
    Object.entries(answers).map(([name, answer]) => [
      name,
      vi.fn(async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 0));
        inFlight -= 1;
        return answer();
      }),
    ]),
  );
  // Each mock answers with a value shaped like its method's result, which the
  // untyped fromEntries cannot express method by method.
  return Object.assign(fake as unknown as Fake, { maxInFlight: () => peak });
}

let repo: string;
let canvas: ReturnType<typeof fakeCanvas>;

beforeEach(() => {
  repo = makeRepo();
  canvas = fakeCanvas();
});

describe("push", () => {
  it("a dry run renders everything, needs no client and writes nothing", async () => {
    const result = await push(null, { repo, courseId: COURSE, dryRun: true });

    expect(result.selected).toEqual(["pages/welcome.md", "assignments/p0.md", "assignments/p1.md", "index.md"]);
    // The four objects. Skipped modules are not counted, as in the Python.
    expect(result.skipped).toBe(4);
    expect(result.problems).toEqual([]);
    expect(result.rendered.get("pages/welcome.md")).toContain("Hello.");
    expect(result.unlisted).toEqual(["assignments/p1.md"]);
    expect(result.verify).toBeNull();
    expect(existsSync(path.join(repo, ".canvas"))).toBe(false);
  });

  it("a push that writes needs a client", async () => {
    await expect(push(null, { repo, courseId: COURSE })).rejects.toThrow(CourseError);
  });

  it("new objects are created unpublished and recorded in the manifest", async () => {
    const result = await push(canvas, { repo, courseId: COURSE, verify: false });

    expect(result.problems).toEqual([]);
    expect(result.created).toBe(4); // a page, two assignments, the module
    expect(canvas.createPage.mock.calls[0]?.[3]).toBe(false);
    const fields = canvas.createAssignment.mock.calls[0]?.[1];
    expect(fields).toContainEqual(["assignment[published]", "false"]);
    expect(Object.keys(manifestOf(repo)).sort()).toEqual([
      "assignments/p0.md",
      "assignments/p1.md",
      "index.md",
      "pages/welcome.md",
    ]);
  });

  it("every Canvas call is made one at a time", async () => {
    await push(canvas, { repo, courseId: COURSE, verify: false });

    expect(canvas.maxInFlight()).toBe(1);
  });

  it("a published object is skipped without updatePublished", async () => {
    writeManifest(repo, {
      "assignments/p0.md": { kind: "assignment", canvas_id: "7", page_url: "", title: "P0", extra: {} },
    });
    canvas.getJson.mockImplementation(async (url: string) =>
      url.endsWith("/assignments/7") ? { published: true } : {},
    );
    const result = await push(canvas, { repo, courseId: COURSE, verify: false });

    expect(result.protected).toEqual(["assignments/p0.md"]);
    const touched = canvas.updateAssignment.mock.calls.filter((call) => call[1] === "7");
    expect(touched).toEqual([]);
  });

  it("updatePublished rewrites a published object", async () => {
    writeManifest(repo, {
      "assignments/p0.md": { kind: "assignment", canvas_id: "7", page_url: "", title: "P0", extra: {} },
    });
    canvas.getJson.mockResolvedValue({ published: true });
    const result = await push(canvas, { repo, courseId: COURSE, verify: false, updatePublished: true });

    expect(result.protected).toEqual([]);
    expect(canvas.updateAssignment.mock.calls.some((call) => call[1] === "7")).toBe(true);
  });

  it("a path limits the push to one file and skips the module rebuild", async () => {
    const result = await push(canvas, { repo, courseId: COURSE, paths: ["assignments/p1.md"], verify: false });

    expect(result.selected).toEqual(["assignments/p1.md"]);
    expect(canvas.createPage).not.toHaveBeenCalled();
    expect(canvas.listModules).not.toHaveBeenCalled();
    expect(result.unlisted).toEqual(["assignments/p1.md"]);
  });

  it("a path that matches nothing is refused, with what is available", async () => {
    const error = await push(canvas, { repo, courseId: COURSE, paths: ["assignments/p9.md"] }).catch((e) => e);

    expect(error).toBeInstanceOf(UnmatchedPathError);
    expect(error.missed).toEqual(["assignments/p9.md"]);
    expect(error.available).toContain("assignments/p0.md");
    expect(canvas.createAssignment).not.toHaveBeenCalled();
  });

  it("only limits the push to a group", async () => {
    const result = await push(canvas, { repo, courseId: COURSE, only: ["pages"], verify: false });

    expect(result.selected).toEqual(["pages/welcome.md"]);
    expect(canvas.createAssignment).not.toHaveBeenCalled();
    expect(canvas.listModules).not.toHaveBeenCalled();
  });

  it("a clean plan cannot be combined with only or a path", async () => {
    const plan = await planClean(canvas, { repo, courseId: COURSE });
    await expect(push(canvas, { repo, courseId: COURSE, only: ["pages"], clean: plan })).rejects.toThrow(
      "--clean syncs the whole course",
    );
  });

  it("a clean push forces updatePublished", async () => {
    writeManifest(repo, {
      "assignments/p0.md": { kind: "assignment", canvas_id: "7", page_url: "", title: "P0", extra: {} },
    });
    canvas.getJson.mockResolvedValue({ published: true });
    const plan = await planClean(canvas, { repo, courseId: COURSE });
    const result = await push(canvas, { repo, courseId: COURSE, verify: false, clean: plan });

    expect(result.protected).toEqual([]);
  });

  it("verify follows a push that had no problems", async () => {
    const result = await push(canvas, { repo, courseId: COURSE });

    expect(result.verify).not.toBeNull();
    expect(result.verify?.checked).toBe(4);
  });

  it("a Canvas error on one object is a problem, not a crash, and skips verify", async () => {
    canvas.createAssignment.mockRejectedValueOnce(new Error("Canvas API error 500"));
    const result = await push(canvas, { repo, courseId: COURSE });

    expect(result.problems).toContain("assignments/p0.md: Canvas API error 500");
    expect(result.verify).toBeNull();
  });

  it("the preview writes one page per rendered body", async () => {
    const result = await push(null, { repo, courseId: COURSE, dryRun: true });
    const dir = path.join(repo, "preview");

    expect(writePreview(result.rendered, dir)).toBe(4);
    expect(readFileSync(path.join(dir, "pages__welcome.html"), "utf-8")).toContain("<h1>pages/welcome.md</h1>");
  });
});

describe("clean sync", () => {
  beforeEach(() => {
    canvas.listPages.mockResolvedValue([{ url: "old-page", title: "Old page", published: true }]);
    canvas.getAssignments.mockResolvedValue([{ id: 77, name: "Old lab", published: false }]);
    canvas.listQuizzes.mockResolvedValue([{ id: 900, title: "Exam 1", published: true }]);
  });

  it("plans to delete what the repo does not own, keeping native items", async () => {
    const plan = await planClean(canvas, { repo, courseId: COURSE });

    expect(plan.targets.map((t) => [t.kind, t.ident])).toEqual([
      ["assignment", "77"],
      ["page", "old-page"],
    ]);
    expect(plan.refused).toEqual([]);
    expect(canvas.deleteObject).not.toHaveBeenCalled();
  });

  it("keeps the course front page", async () => {
    canvas.getJson.mockImplementation(async (url: string) => (url.endsWith("/front_page") ? { url: "old-page" } : {}));
    const plan = await planClean(canvas, { repo, courseId: COURSE });

    expect(plan.targets.map((t) => t.ident)).toEqual(["77"]);
  });

  it("refuses when student work exists, and deletes nothing", async () => {
    canvas.getObject.mockResolvedValue({ id: 77, has_submitted_submissions: true });
    const plan = await planClean(canvas, { repo, courseId: COURSE });

    expect(plan.refused.map((r) => [r.target.ident, r.reason])).toEqual([["77", "has submissions"]]);
    await expect(executeClean(canvas, plan)).rejects.toThrow(CleanRefusedError);
    await expect(push(canvas, { repo, courseId: COURSE, clean: plan })).rejects.toThrow(CleanRefusedError);
    expect(canvas.deleteObject).not.toHaveBeenCalled();
    expect(canvas.createPage).not.toHaveBeenCalled();
  });

  it("checks for student work again right before deleting", async () => {
    const plan = await planClean(canvas, { repo, courseId: COURSE });
    canvas.getObject.mockResolvedValue({ id: 77, has_submitted_submissions: true });

    await expect(executeClean(canvas, plan)).rejects.toThrow(CleanRefusedError);
    expect(canvas.deleteObject).not.toHaveBeenCalled();
  });

  it("deletes the targets and forgets stale entries", async () => {
    writeManifest(repo, {
      "pages/gone.md": { kind: "page", canvas_id: "gone", page_url: "gone", title: "Gone", extra: {} },
    });
    const plan = await planClean(canvas, { repo, courseId: COURSE });
    const outcome = await executeClean(canvas, plan);

    expect(canvas.deleteObject.mock.calls).toEqual([
      ["assignment", COURSE, "77"],
      ["page", COURSE, "old-page"],
    ]);
    expect(outcome.forgotten.map((d) => d.key)).toEqual(["pages/gone.md"]);
    expect(manifestOf(repo)).toEqual({});
  });

  it("a push carries out the approved plan before it writes", async () => {
    const plan = await planClean(canvas, { repo, courseId: COURSE });
    const result = await push(canvas, { repo, courseId: COURSE, clean: plan, verify: false });

    expect(result.clean?.deleted).toHaveLength(2);
    const firstDelete = canvas.deleteObject.mock.invocationCallOrder[0] ?? 0;
    const firstCreate = canvas.createPage.mock.invocationCallOrder[0] ?? 0;
    expect(firstDelete).toBeLessThan(firstCreate);
  });

  it("a dry run with a plan deletes nothing", async () => {
    const plan = await planClean(canvas, { repo, courseId: COURSE });
    const result = await push(null, { repo, courseId: COURSE, clean: plan, dryRun: true });

    expect(result.clean).toBeNull();
    expect(canvas.deleteObject).not.toHaveBeenCalled();
  });
});

describe("audit", () => {
  it("reports untracked objects and stale entries", async () => {
    writeManifest(repo, {
      "pages/welcome.md": { kind: "page", canvas_id: "welcome", page_url: "welcome", title: "Welcome", extra: {} },
    });
    canvas.getAssignments.mockResolvedValue([{ id: 77, name: "Old lab", published: false }]);
    const result = await auditCourse(canvas, { repo, courseId: COURSE });

    expect(result.tracked).toBe(1);
    expect(result.stale.map((d) => d.key)).toEqual(["pages/welcome.md"]);
    expect(result.differences.map((d) => [d.side, d.kind])).toEqual([
      ["stale", "page"],
      ["untracked", "assignment"],
      ["pending", "module"],
    ]);
  });
});

describe("verify", () => {
  it("a course never pushed has nothing to verify", async () => {
    await expect(verifyCourse(canvas, { repo, courseId: COURSE })).rejects.toThrow(NothingToVerifyError);
  });

  it("an object Canvas no longer has is reported missing", async () => {
    writeManifest(repo, {
      "assignments/p0.md": { kind: "assignment", canvas_id: "7", page_url: "", title: "P0", extra: {} },
    });
    canvas.getAssignmentFull.mockRejectedValue(new Error("Canvas API error 404"));
    const result = await verifyCourse(canvas, { repo, courseId: COURSE });

    expect(result.checked).toBe(1);
    expect(result.failures).toContainEqual({
      key: "assignments/p0.md",
      check: "missing",
      detail: "assignment 7 does not resolve in Canvas",
    });
  });

  it("a stripped body is caught", async () => {
    writeManifest(repo, {
      "pages/welcome.md": { kind: "page", canvas_id: "welcome", page_url: "welcome", title: "Welcome", extra: {} },
    });
    canvas.getPage.mockResolvedValue({ title: "Welcome", body: "<p>Hello.</p>" });
    const intact = await verifyCourse(canvas, { repo, courseId: COURSE });
    canvas.getPage.mockResolvedValue({ title: "Welcome", body: "" });
    const stripped = await verifyCourse(canvas, { repo, courseId: COURSE });

    expect(intact.failures.filter((f) => f.key === "pages/welcome.md")).toEqual([]);
    expect(stripped.failures.map((f) => f.check)).toContain("content");
  });

  it("drafts are listed and not read back", async () => {
    writeManifest(repo, {
      "assignments/p0.md": { kind: "assignment", canvas_id: "7", page_url: "", title: "P0", extra: {} },
    });
    writeFileSync(path.join(repo, "assignments", "p0.md"), "---\ndraft: true\n---\n# P0\n", "utf-8");
    const result = await verifyCourse(canvas, { repo, courseId: COURSE });

    expect(result.drafts).toEqual(["assignments/p0.md"]);
    expect(result.checked).toBe(0);
    expect(canvas.getAssignmentFull).not.toHaveBeenCalled();
  });
});

describe("from the repo alone", () => {
  it("the outline lists each module's items with their dates", () => {
    const [week] = courseOutline(repo);

    expect(week?.title).toBe("Week 1");
    expect(week?.items.map((i) => [i.kind, i.title])).toEqual([
      ["page", "Welcome"],
      ["assignment", "P0"],
      ["quiz", "Exam 1"],
    ]);
    expect(week?.items[1]?.points).toBe(50);
  });

  it("dates computes every gradable item, and shifts the term", () => {
    const plain = courseDates(repo);
    const shifted = courseDates(repo, { shiftDays: 7 });

    expect(plain.items.map((i) => i.path)).toEqual(["assignments/p0.md", "assignments/p1.md"]);
    expect(shifted.items[0]?.dueAt.toISODate()).toBe(plain.items[0]?.dueAt.plus({ days: 7 }).toISODate());
  });
});

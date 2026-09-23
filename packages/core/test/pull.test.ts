/**
 * The course snapshot: where each object lands, and what a second pull removes.
 *
 * The client is a plain object of mocks, so these cover the path rules and the
 * prune logic, which is where a pull can lose data, without a token.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CanvasLMS } from "@edutools/core/canvas";
import {
  filePath,
  INDEX_NAME,
  isCurrent,
  type Pulled,
  PullError,
  Puller,
  safeComponent,
  stalePaths,
  stem,
} from "@edutools/core/pull";
import type { Payload } from "@edutools/core/types";
import { describe, expect, it, vi } from "vitest";

function tmp(): string {
  return mkdtempSync(path.join(os.tmpdir(), "edutools-"));
}

/** A course with one of everything, and a download that writes bytes. */
function fakeCanvas() {
  const list = (items: Payload[]) => vi.fn(async (..._args: string[]) => items);
  return {
    getCourseWithSyllabus: vi.fn<CanvasLMS["getCourseWithSyllabus"]>(async () => ({
      id: 42,
      name: "CS 121",
      syllabus_body: "<p>syllabus</p>",
    })),
    listPages: vi.fn<CanvasLMS["listPages"]>(async () => [{ url: "week-1", title: "Week 1" }]),
    getPage: vi.fn<CanvasLMS["getPage"]>(async () => ({
      url: "week-1",
      title: "Week 1",
      body: "<p>page</p>",
    })),
    listAssignments: vi.fn<CanvasLMS["listAssignments"]>(async () => [
      { id: 7, name: "Lab 1: Setup", description: "<p>lab</p>" },
    ]),
    listDiscussions: list([{ id: 8, title: "Intro", message: "" }]),
    listAnnouncements: list([]),
    listQuizzes: vi.fn<CanvasLMS["listQuizzes"]>(async () => [
      { id: 9, title: "Quiz 1", description: "<p>q</p>" },
    ]),
    listQuizQuestions: list([{ id: 1, question_text: "?" }]),
    listModules: vi.fn<CanvasLMS["listModules"]>(async () => [{ id: 5, name: "Week 1" }]),
    listModuleItems: list([{ id: 50, type: "Page" }]),
    listAssignmentGroups: vi.fn<CanvasLMS["listAssignmentGroups"]>(async () => [
      { id: 3, name: "Labs" },
    ]),
    listRubrics: list([]),
    listFolders: list([
      { id: 100, full_name: "course files" },
      { id: 101, full_name: "course files/docs" },
    ]),
    listFiles: vi.fn<CanvasLMS["listFiles"]>(async () => [
      {
        id: 200,
        folder_id: 101,
        display_name: "notes.pdf",
        size: 3,
        url: "https://x/200",
        modified_at: "2026-09-01T12:00:00Z",
      },
    ]),
    downloadAttachment: vi.fn<CanvasLMS["downloadAttachment"]>(async (_url, dest) => {
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, "pdf");
      return 3;
    }),
  };
}

type FakeCanvas = ReturnType<typeof fakeCanvas>;

function clearCalls(canvas: FakeCanvas): void {
  for (const fn of Object.values(canvas)) fn.mockClear();
}

function readIndex(out: string): { entries: Array<{ kind: string }> } {
  return JSON.parse(readFileSync(path.join(out, INDEX_NAME), "utf-8"));
}

describe("path rules", () => {
  it("stem keeps the id and a readable slug", () => {
    expect(stem("7", "Lab 1: Setup")).toBe("7-lab-1-setup");
    expect(stem("7", "!!!")).toBe("7");
  });

  it.each(["..", ".", "", "  "])("a component %j cannot climb out", (name) => {
    expect(safeComponent(name)).toBe("_");
  });

  it("a slash in a name does not make a directory", () => {
    expect(safeComponent("a/b\\c")).toBe("a_b_c");
  });

  it("characters Windows refuses become underscores", () => {
    expect(safeComponent('a:b*c?d"e<f>g|h')).toBe("a_b_c_d_e_f_g_h");
  });

  it("control characters become underscores", () => {
    expect(safeComponent("a\u0001b\u001fc\td")).toBe("a_b_c_d");
    expect(safeComponent("a\0b")).toBe("a_b");
  });

  it("trailing dots and spaces are stripped", () => {
    expect(safeComponent("notes.")).toBe("notes");
    expect(safeComponent("notes . .")).toBe("notes");
    expect(safeComponent("...")).toBe("_");
    expect(safeComponent(".hidden")).toBe(".hidden");
  });

  it.each([
    ["CON", "_CON"],
    ["prn", "_prn"],
    ["Aux.txt", "_Aux.txt"],
    ["nul.tar.gz", "_nul.tar.gz"],
    ["COM1", "_COM1"],
    ["com9.log", "_com9.log"],
    ["LPT1", "_LPT1"],
    ["lpt9.pdf", "_lpt9.pdf"],
  ])("the reserved device name %j is prefixed", (name, expected) => {
    expect(safeComponent(name)).toBe(expected);
  });

  it.each(["COM0", "LPT10", "console", "auxiliary.txt", "CONS.txt"])(
    "%j is not a reserved device name",
    (name) => {
      expect(safeComponent(name)).toBe(name);
    },
  );

  it("files mirror the folder without the course files root", () => {
    expect(filePath("course files/docs/week 1", "a.pdf")).toBe("files/docs/week 1/a.pdf");
    expect(filePath("course files", "a.pdf")).toBe("files/a.pdf");
    expect(filePath("course files/../..", "a.pdf")).toBe("files/_/_/a.pdf");
  });

  it("stale paths only counts kinds that were listed", () => {
    const previous: Pulled[] = [
      { kind: "pages", ident: "a", title: "A", paths: ["pages/a.json"] },
      { kind: "quizzes", ident: "1", title: "Q", paths: ["quizzes/1.json"] },
    ];
    expect(stalePaths(previous, [], new Set(["pages"]))).toEqual(["pages/a.json"]);
  });

  it("a file is current only at the same size and time", () => {
    const dest = path.join(tmp(), "f");
    writeFileSync(dest, "abc");
    utimesSync(dest, 1000, 1000);
    expect(isCurrent(dest, 3, 1000.0)).toBe(true);
    expect(isCurrent(dest, 4, 1000.0)).toBe(false);
    expect(isCurrent(dest, 3, 2000.0)).toBe(false);
    expect(isCurrent(dest, 3, null)).toBe(false);
  });
});

describe("pull", () => {
  it("writes every kind where the layout says", async () => {
    const out = tmp();
    await new Puller(fakeCanvas(), "42", out).run();

    for (const rel of [
      "course.json",
      "syllabus.html",
      "pages/week-1.json",
      "pages/week-1.html",
      "assignments/7-lab-1-setup.json",
      "assignments/7-lab-1-setup.html",
      "discussions/8-intro.json",
      "quizzes/9-quiz-1.json",
      "quizzes/9-quiz-1.html",
      "quizzes/9-quiz-1.questions.json",
      "modules.json",
      "assignment_groups.json",
      "rubrics.json",
      "folders.json",
      "files.json",
      "files/docs/notes.pdf",
    ]) {
      expect(statSync(path.join(out, rel)).isFile(), rel).toBe(true);
    }
    // An empty body is not worth a file.
    expect(existsSync(path.join(out, "discussions/8-intro.html"))).toBe(false);
    expect(readFileSync(path.join(out, "assignments/7-lab-1-setup.html"), "utf-8")).toBe(
      "<p>lab</p>",
    );
  });

  it("modules carry their items", async () => {
    const out = tmp();
    await new Puller(fakeCanvas(), "42", out).run();
    const modules = JSON.parse(readFileSync(path.join(out, "modules.json"), "utf-8"));
    expect(modules[0].items).toEqual([{ id: 50, type: "Page" }]);
  });

  it("a downloaded file takes the Canvas time and is not fetched again", async () => {
    const out = tmp();
    const canvas = fakeCanvas();
    const first = new Puller(canvas, "42", out);
    await first.run();
    expect(first.result.downloaded).toBe(1);
    expect(statSync(path.join(out, "files/docs/notes.pdf")).mtimeMs).toBe(
      Date.parse("2026-09-01T12:00:00Z"),
    );

    const second = new Puller(canvas, "42", out);
    await second.run();
    expect([second.result.downloaded, second.result.unchanged]).toEqual([0, 1]);
    expect(canvas.downloadAttachment).toHaveBeenCalledTimes(1);
  });

  it("a second pull removes what Canvas no longer has", async () => {
    const out = tmp();
    const canvas = fakeCanvas();
    await new Puller(canvas, "42", out).run();
    writeFileSync(path.join(out, "mine.txt"), "not the pull's");

    canvas.listAssignments.mockResolvedValue([
      { id: 7, name: "Lab 1: Renamed", description: "x" },
    ]);
    canvas.listPages.mockResolvedValue([]);
    const puller = new Puller(canvas, "42", out);
    await puller.run();

    expect(existsSync(path.join(out, "assignments/7-lab-1-setup.json"))).toBe(false);
    expect(existsSync(path.join(out, "assignments/7-lab-1-renamed.json"))).toBe(true);
    expect(existsSync(path.join(out, "pages/week-1.json"))).toBe(false);
    expect(existsSync(path.join(out, "mine.txt"))).toBe(true);
    expect(puller.result.removed).toContain("pages/week-1.html");
  });

  it("a failed listing keeps the last snapshot of that kind", async () => {
    const out = tmp();
    const canvas = fakeCanvas();
    await new Puller(canvas, "42", out).run();

    canvas.listQuizzes.mockRejectedValue(new Error("Canvas API error 404"));
    const puller = new Puller(canvas, "42", out);
    await puller.run();

    expect(existsSync(path.join(out, "quizzes/9-quiz-1.json"))).toBe(true);
    expect(puller.result.errors).toEqual(["quizzes: Canvas API error 404"]);
    const kinds = readIndex(out).entries.map((e) => e.kind);
    expect(kinds.filter((k) => k === "quizzes")).toHaveLength(1);
  });

  it("a failed object keeps its previous copy", async () => {
    const out = tmp();
    const canvas = fakeCanvas();
    await new Puller(canvas, "42", out).run();

    canvas.getPage.mockRejectedValue(new Error("403"));
    const puller = new Puller(canvas, "42", out);
    await puller.run();

    expect(existsSync(path.join(out, "pages/week-1.html"))).toBe(true);
    expect(puller.result.errors).toEqual(["pages Week 1: 403"]);
  });

  it("a dropped connection is reported, not raised", async () => {
    const canvas = fakeCanvas();
    canvas.downloadAttachment.mockRejectedValue(new TypeError("reset"));
    const puller = new Puller(canvas, "42", tmp());
    await puller.run();
    expect(puller.result.errors).toEqual(["files notes.pdf: reset"]);
  });

  it("only limits the pull and keeps the rest of the index", async () => {
    const out = tmp();
    const canvas = fakeCanvas();
    await new Puller(canvas, "42", out).run();
    clearCalls(canvas);

    await new Puller(canvas, "42", out, { kinds: ["pages"] }).run();

    expect(canvas.listAssignments).not.toHaveBeenCalled();
    expect(canvas.listFiles).not.toHaveBeenCalled();
    expect(existsSync(path.join(out, "files/docs/notes.pdf"))).toBe(true);
    const kinds = readIndex(out).entries.map((e) => e.kind);
    expect(kinds.filter((k) => k === "course")).toHaveLength(1);
    expect(kinds.filter((k) => k === "syllabus")).toHaveLength(1);
    expect(kinds).toContain("assignments");
  });

  it("refuses an unknown kind", () => {
    expect(() => new Puller(fakeCanvas(), "42", tmp(), { kinds: ["widgets"] })).toThrow(PullError);
    expect(() => new Puller(fakeCanvas(), "42", tmp(), { kinds: ["widgets"] })).toThrow(
      /unknown kind/,
    );
  });

  it("two files differing only in case do not collide", async () => {
    const out = tmp();
    const canvas = fakeCanvas();
    canvas.listFiles.mockResolvedValue([
      { id: 1, folder_id: 100, display_name: "A.pdf", size: 3, url: "u1" },
      { id: 2, folder_id: 100, display_name: "a.pdf", size: 3, url: "u2" },
    ]);
    await new Puller(canvas, "42", out, { kinds: ["files"] }).run();
    const dests = canvas.downloadAttachment.mock.calls.map((c) => c[1]);
    expect(dests).toEqual([path.join(out, "files", "A.pdf"), path.join(out, "files", "2-a.pdf")]);
  });

  it("a tampered index cannot delete outside the snapshot", async () => {
    const root = tmp();
    const out = path.join(root, "snap");
    const victim = path.join(root, "victim.txt");
    writeFileSync(victim, "keep");
    mkdirSync(out);
    writeFileSync(
      path.join(out, INDEX_NAME),
      JSON.stringify({
        entries: [{ kind: "pages", ident: "x", title: "x", paths: ["../victim.txt"] }],
      }),
    );
    await new Puller(fakeCanvas(), "42", out, { kinds: ["pages"] }).run();
    expect(existsSync(victim)).toBe(true);
  });
});

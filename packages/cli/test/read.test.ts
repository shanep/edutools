/**
 * The read commands, pull, and the --json contract the canvas skill relies on:
 * with --json, stdout is the raw payload and nothing else.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { type FakeClient, fakeClient, invoke, tmpDir } from "./harness";

let canvas: FakeClient;

beforeEach(() => {
  canvas = fakeClient();
});

describe("pull", () => {
  function emptyCourse(): void {
    canvas.getCourseWithSyllabus.mockResolvedValue({ id: 42, name: "CS 121" });
    for (const method of [
      "listPages",
      "listAssignments",
      "listDiscussions",
      "listAnnouncements",
      "listQuizzes",
      "listModules",
      "listAssignmentGroups",
      "listRubrics",
      "listFolders",
      "listFiles",
    ] as const) {
      canvas[method].mockResolvedValue([]);
    }
  }

  it("pull writes the snapshot and emits the index", async () => {
    emptyCourse();
    const out = path.join(tmpDir(), "snap");
    const result = await invoke(["pull", "42", "--out", out, "--json"], { client: canvas });

    expect(result.code, result.output).toBe(0);
    expect(JSON.parse(result.stdout).course_name).toBe("CS 121");
    expect(existsSync(path.join(out, "course.json"))).toBe(true);
  });

  it("pull refuses an unknown kind", async () => {
    const result = await invoke(["pull", "42", "--out", tmpDir(), "--only", "widgets"], { client: canvas });

    expect(result.code).toBe(2);
    expect(result.output).toContain("unknown kind");
  });

  it("only is repeatable", async () => {
    emptyCourse();
    const out = path.join(tmpDir(), "snap");
    const result = await invoke(["pull", "42", "-o", out, "--only", "pages", "--only", "groups", "--json"], {
      client: canvas,
    });

    expect(result.code, result.output).toBe(0);
    expect(JSON.parse(result.stdout).kinds).toEqual(["pages", "groups"]);
    expect(canvas.listAssignments).not.toHaveBeenCalled();
  });

  it("an unreadable course exits 1 and writes no index", async () => {
    canvas.getCourseWithSyllabus.mockRejectedValue(new Error("Canvas API error 404"));
    const out = path.join(tmpDir(), "snap");
    const result = await invoke(["pull", "42", "--out", out], { client: canvas });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("could not read course 42");
    expect(existsSync(path.join(out, "index.json"))).toBe(false);
  });

  it("the human summary counts what landed", async () => {
    emptyCourse();
    canvas.listAssignments.mockResolvedValue([{ id: 7, name: "Lab 1", description: "<p>x</p>" }]);
    const result = await invoke(["pull", "42", "--out", path.join(tmpDir(), "snap")], { client: canvas });

    expect(result.code, result.output).toBe(0);
    expect(result.stdout).toContain("CS 121 pulled to");
    expect(result.stdout).toContain("1 assignments");
  });
});

describe("json output is pure JSON", () => {
  it("courses", async () => {
    canvas.getCourses.mockResolvedValue([{ id: 1, name: "CS 121" }]);
    const result = await invoke(["courses", "--json"], { client: canvas });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([{ id: 1, name: "CS 121" }]);
  });

  it("courses --all asks Canvas for every course", async () => {
    canvas.getCourses.mockResolvedValue([]);
    await invoke(["courses", "-a", "--json"], { client: canvas });

    expect(canvas.getCourses).toHaveBeenCalledWith({ includeAll: true });
  });

  it("assignments, students, submissions and ungraded", async () => {
    canvas.getAssignments.mockResolvedValue([{ id: 7, name: "Lab 1" }]);
    canvas.getStudents.mockResolvedValue([{ id: 555, email: "a@b.edu" }]);
    canvas.getSubmissions.mockResolvedValue([{ user_id: 555, grade: null }]);
    canvas.getUngradedSubmissions.mockResolvedValue([{ assignment_id: 7, user_id: 555 }]);

    for (const [argv, expected] of [
      [["assignments", "1", "--json"], [{ id: 7, name: "Lab 1" }]],
      [["students", "1", "--json"], [{ id: 555, email: "a@b.edu" }]],
      [["submissions", "1", "7", "--json"], [{ user_id: 555, grade: null }]],
      [["ungraded", "1", "--json"], [{ assignment_id: 7, user_id: 555 }]],
    ] as const) {
      const result = await invoke(argv, { client: canvas });
      expect(result.code, result.output).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual(expected);
    }
  });

  it("modules nest their items under items", async () => {
    canvas.listModules.mockResolvedValue([{ id: 3, name: "Week 1" }]);
    canvas.listModuleItems.mockResolvedValue([{ id: 9, type: "Page", page_url: "week-1", title: "Week 1" }]);
    const result = await invoke(["modules", "1", "--json"], { client: canvas });

    expect(JSON.parse(result.stdout)).toEqual([
      { id: 3, name: "Week 1", items: [{ id: 9, type: "Page", page_url: "week-1", title: "Week 1" }] },
    ]);
    expect(canvas.listModuleItems).toHaveBeenCalledWith("1", "3");
  });

  it("groups emit the raw groups, with their assignments", async () => {
    canvas.listAssignmentGroups.mockResolvedValue([{ id: 5, name: "Projects", group_weight: 40 }]);
    canvas.getCourse.mockResolvedValue({ id: 1, apply_assignment_group_weights: true });
    const result = await invoke(["groups", "1", "--json"], { client: canvas });

    expect(JSON.parse(result.stdout)).toEqual([{ id: 5, name: "Projects", group_weight: 40 }]);
    expect(canvas.listAssignmentGroups).toHaveBeenCalledWith("1", { withAssignments: true });
  });

  it("a prompted course keeps its list and prompt off stdout", async () => {
    canvas.getCourses.mockResolvedValue([
      { id: 10, name: "CS 121" },
      { id: 20, name: "CS 221" },
    ]);
    canvas.getStudents.mockResolvedValue([{ id: 555 }]);
    const result = await invoke(["students", "--json"], { client: canvas, input: "2\n" });

    expect(result.code, result.output).toBe(0);
    expect(canvas.getStudents).toHaveBeenCalledWith("20");
    expect(JSON.parse(result.stdout)).toEqual([{ id: 555 }]);
    expect(result.stderr).toContain("CS 221");
    expect(result.stderr).toContain("Select a course");
  });
});

describe("interactive selection", () => {
  it("course then assignment are both read from one stream", async () => {
    canvas.getCourses.mockResolvedValue([{ id: 10, name: "CS 121" }]);
    canvas.getAssignments.mockResolvedValue([
      { id: 7, name: "Lab 1" },
      { id: 8, name: "Lab 2" },
    ]);
    canvas.getSubmissions.mockResolvedValue([]);
    const result = await invoke(["submissions"], { client: canvas, input: "1\n2\n" });

    expect(result.code, result.output).toBe(0);
    expect(canvas.getSubmissions).toHaveBeenCalledWith("10", "8");
  });

  it("a selection out of range exits 1", async () => {
    canvas.getCourses.mockResolvedValue([{ id: 10, name: "CS 121" }]);
    const result = await invoke(["students"], { client: canvas, input: "5\n" });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Invalid selection.");
  });

  it("a word is asked again", async () => {
    canvas.getCourses.mockResolvedValue([{ id: 10, name: "CS 121" }]);
    canvas.getStudents.mockResolvedValue([]);
    const result = await invoke(["students"], { client: canvas, input: "first\n1\n" });

    expect(result.code, result.output).toBe(0);
    expect(result.stderr).toContain("is not a valid integer");
    expect(canvas.getStudents).toHaveBeenCalledWith("10");
  });

  it("no courses at all exits cleanly", async () => {
    canvas.getCourses.mockResolvedValue([]);
    const result = await invoke(["students"], { client: canvas });

    expect(result.code).toBe(0);
    expect(result.output).toContain("No courses found.");
  });
});

describe("tables", () => {
  it("groups show weights and warn when the course ignores them", async () => {
    canvas.listAssignmentGroups.mockResolvedValue([
      { id: 6, name: "Exams", group_weight: 60, position: 2, assignments: [{}, {}] },
      { id: 5, name: "Projects", group_weight: 40, position: 1, assignments: [] },
    ]);
    canvas.getCourse.mockResolvedValue({ id: 1, apply_assignment_group_weights: false });
    const result = await invoke(["groups", "1"], { client: canvas });

    expect(result.code, result.output).toBe(0);
    expect(result.stdout.indexOf("Projects")).toBeLessThan(result.stdout.indexOf("Exams"));
    expect(result.stdout).toContain("does not weight the final grade by group");
  });

  it("a weighted course sums its weights", async () => {
    canvas.listAssignmentGroups.mockResolvedValue([
      { id: 5, name: "Projects", group_weight: 40, position: 1 },
      { id: 6, name: "Exams", group_weight: 60.5, position: 2 },
    ]);
    canvas.getCourse.mockResolvedValue({ id: 1, apply_assignment_group_weights: true });
    const result = await invoke(["groups", "1"], { client: canvas });

    expect(result.stdout).toContain("60.5%");
    expect(result.stdout).toContain("Weights sum to 100.5%");
  });

  it("ungraded names each assignment", async () => {
    canvas.getAssignments.mockResolvedValue([{ id: 7, name: "Lab 1" }]);
    canvas.getUngradedSubmissions.mockResolvedValue([{ assignment_id: 7, user_id: 555 }]);
    const result = await invoke(["ungraded", "1"], { client: canvas });

    expect(result.stdout).toContain("Lab 1");
    expect(result.stdout).toContain("Total ungraded: 1");
  });
});

describe("the program", () => {
  it("version prints the version", async () => {
    const result = await invoke(["--version"]);

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("edutools 1.0.1");
  });

  it("no arguments prints help and exits 0", async () => {
    const result = await invoke([]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage: edutools");
  });

  it("a missing required option is a usage error", async () => {
    const result = await invoke(["create", "page"]);

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--course");
  });

  it("a Canvas error exits 1 with its message", async () => {
    canvas.getCourses.mockRejectedValue(new Error("Canvas API error 401: invalid token"));
    const result = await invoke(["courses"], { client: canvas });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Canvas API error 401");
  });
});

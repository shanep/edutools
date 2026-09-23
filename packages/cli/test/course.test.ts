/**
 * The course repository commands: push, verify, audit, outline and dates,
 * including the push tests ported from tests/test_cli.py.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { courseOutline } from "@edutools/core/course";
import { toJsonText } from "@edutools/core/outline";
import type { Payload } from "@edutools/core/types";
import { beforeEach, describe, expect, it } from "vitest";
import { type FakeClient, fakeClient, invoke, tmpDir } from "./harness";

const TOML =
  "[term]\n" +
  'timezone = "America/Boise"\n' +
  "first_monday = 2026-08-24\nweeks = 15\n" +
  "last_day_of_instruction = 2026-12-11\n" +
  "finals_start = 2026-12-14\nfinals_end = 2026-12-18\ntotal_points = 0\n\n" +
  '[term.policy.project]\ndue = "tue 23:59"\n\n' +
  '[layout]\nsyllabus = "index.md"\npages = []\nfiles = []\n\n' +
  '[layout.gradable]\nproject = "assignments/p[0-9]*.md"\n\n' +
  '[[module]]\ntitle = "Week 1"\nitems = ["assignments/p0.md"]\n';

/** The repo the Python push tests built: two projects, one of them in no module. */
function makeRepo(): string {
  const repo = path.join(tmpDir(), "course");
  mkdirSync(path.join(repo, "assignments"), { recursive: true });
  writeFileSync(path.join(repo, "index.md"), "# S\n", "utf-8");
  writeFileSync(path.join(repo, "assignments", "p0.md"), "# P0\n\n**Week 2 · 50 points · x**\n", "utf-8");
  writeFileSync(path.join(repo, "assignments", "p1.md"), "# P1\n\n**Week 4 · 100 points · x**\n", "utf-8");
  writeFileSync(path.join(repo, "canvas.toml"), TOML, "utf-8");
  return repo;
}

function writeManifest(repo: string, entries: Record<string, Payload>): void {
  mkdirSync(path.join(repo, ".canvas"), { recursive: true });
  writeFileSync(path.join(repo, ".canvas", "manifest-42.json"), JSON.stringify({ entries }), "utf-8");
}

/** A fake that answers every call a push, verify, audit or clean sync makes. */
function courseClient(): FakeClient {
  const canvas = fakeClient();
  let id = 100;
  const created = async () => {
    id += 1;
    return { id: String(id) };
  };
  canvas.getJson.mockResolvedValue({});
  canvas.exists.mockResolvedValue(true);
  canvas.updateSyllabus.mockResolvedValue({});
  canvas.listAssignmentGroups.mockResolvedValue([]);
  canvas.createPage.mockResolvedValue({ url: "page" });
  canvas.updatePage.mockResolvedValue({});
  canvas.createAssignment.mockImplementation(created);
  canvas.updateAssignment.mockResolvedValue({});
  canvas.listModules.mockResolvedValue([]);
  canvas.createModule.mockResolvedValue({ id: "9" });
  canvas.updateModule.mockResolvedValue({});
  canvas.listModuleItems.mockResolvedValue([]);
  canvas.createModuleItem.mockImplementation(created);
  canvas.createRubric.mockImplementation(created);
  canvas.listPages.mockResolvedValue([]);
  canvas.getAssignments.mockResolvedValue([]);
  canvas.listDiscussions.mockResolvedValue([]);
  canvas.listQuizzes.mockResolvedValue([]);
  canvas.listFiles.mockResolvedValue([]);
  canvas.listJson.mockResolvedValue([]);
  canvas.getObject.mockResolvedValue({});
  canvas.deleteObject.mockResolvedValue({});
  canvas.getAssignmentFull.mockResolvedValue({});
  return canvas;
}

let repo: string;
let canvas: FakeClient;

beforeEach(() => {
  repo = makeRepo();
  canvas = courseClient();
});

describe("push warns about unlisted items", () => {
  // A gradable file no [[module]] lists is named by push, and does not fail it.

  it("a full push names the orphan and still succeeds", async () => {
    const result = await invoke(["push", repo, "--course", "42", "--dry-run"]);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("in no [[module]]");
    expect(result.output).toContain("assignments/p1.md");
  });

  it("a scoped push only looks at what it pushed", async () => {
    const result = await invoke(["push", repo, "--course", "42", "--dry-run", "--path", "assignments/p0.md"]);

    expect(result.code, result.output).toBe(0);
    expect(result.output).not.toContain("in no [[module]]");
  });

  it("a scoped push of the orphan says so", async () => {
    const result = await invoke(["push", repo, "--course", "42", "--dry-run", "--path", "assignments/p1.md"]);

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("1 gradable item(s) in no [[module]]");
  });
});

describe("push", () => {
  it("a dry run needs no token and writes nothing", async () => {
    const result = await invoke(["push", repo, "--course", "42", "--dry-run"], { env: {} });

    expect(result.code, result.output).toBe(0);
    expect(result.stdout).toContain("dry run: nothing was written to Canvas.");
    expect(existsSync(path.join(repo, ".canvas"))).toBe(false);
  });

  it("new objects go up unpublished, and --no-verify skips the read-back", async () => {
    const result = await invoke(["push", repo, "--course", "42", "--no-verify"], { client: canvas });

    expect(result.code, result.output).toBe(0);
    expect(result.stdout).toContain("new objects unpublished");
    expect(canvas.createAssignment.mock.calls[0]?.[1]).toContainEqual(["assignment[published]", "false"]);
    expect(canvas.listJson).not.toHaveBeenCalled();
  });

  it("the automatic verify fails the push when Canvas lost content", async () => {
    // Every body reads back empty: the sanitizer "stripped" all of it.
    const result = await invoke(["push", repo, "--course", "42"], { client: canvas });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("pushed to course 42");
    expect(result.stdout).toContain("Verification failures");
    expect(result.stderr).toContain("failure(s):");
  });

  it("a published object is skipped without --update-published", async () => {
    writeManifest(repo, {
      "assignments/p0.md": { kind: "assignment", canvas_id: "7", page_url: "", title: "P0", extra: {} },
    });
    canvas.getJson.mockImplementation(async (url: string) => (url.endsWith("/assignments/7") ? { published: true } : {}));
    const result = await invoke(["push", repo, "--course", "42", "--no-verify"], { client: canvas });

    expect(result.code, result.output).toBe(0);
    expect(result.stdout).toContain("left 1 published object(s) untouched");
    expect(result.stdout).toContain("assignments/p0.md");
    expect(canvas.updateAssignment.mock.calls.filter((call) => call[1] === "7")).toEqual([]);
  });

  it("--update-published rewrites it", async () => {
    writeManifest(repo, {
      "assignments/p0.md": { kind: "assignment", canvas_id: "7", page_url: "", title: "P0", extra: {} },
    });
    canvas.getJson.mockResolvedValue({ published: true });
    const result = await invoke(["push", repo, "--course", "42", "--no-verify", "--update-published"], {
      client: canvas,
    });

    expect(result.code, result.output).toBe(0);
    expect(canvas.updateAssignment.mock.calls.some((call) => call[1] === "7")).toBe(true);
  });

  it("--publish makes new objects visible", async () => {
    await invoke(["push", repo, "--course", "42", "--no-verify", "--publish"], { client: canvas });

    expect(canvas.createAssignment.mock.calls[0]?.[1]).toContainEqual(["assignment[published]", "true"]);
  });

  it("a path that matches nothing lists what is available", async () => {
    const result = await invoke(["push", repo, "--course", "42", "--dry-run", "--path", "assignments/p9.md"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no file in the repo matches: assignments/p9.md");
    expect(result.stdout).toContain("assignments/p0.md");
  });

  it("--only is repeatable", async () => {
    const result = await invoke(["push", repo, "--course", "42", "--dry-run", "--only", "syllabus", "--only", "rubrics"]);

    expect(result.code, result.output).toBe(0);
    expect(result.stdout).not.toContain("in no [[module]]");
  });

  it("a problem fails the push and skips verify", async () => {
    canvas.createAssignment.mockRejectedValue(new Error("Canvas API error 500"));
    const result = await invoke(["push", repo, "--course", "42"], { client: canvas });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("assignments/p0.md: Canvas API error 500");
    expect(canvas.listJson).not.toHaveBeenCalled();
  });

  it("--preview writes the rendered pages", async () => {
    const dir = path.join(tmpDir(), "preview");
    const result = await invoke(["push", repo, "--course", "42", "--dry-run", "--preview", dir]);

    expect(result.code, result.output).toBe(0);
    expect(result.stdout).toContain("wrote 3 preview pages");
    expect(readFileSync(path.join(dir, "assignments__p0.html"), "utf-8")).toContain("<h1>assignments/p0.md</h1>");
  });

  it("a broken canvas.toml exits 1 with the reason", async () => {
    writeFileSync(path.join(repo, "canvas.toml"), "[term]\nweeks = 15\n", "utf-8");
    const result = await invoke(["push", repo, "--course", "42", "--dry-run"]);

    expect(result.code).toBe(1);
    expect(result.stderr).not.toBe("");
  });
});

describe("push --clean", () => {
  beforeEach(() => {
    canvas.listPages.mockResolvedValue([{ url: "old-page", title: "Old page", published: false }]);
    canvas.getAssignments.mockResolvedValue([{ id: 77, name: "Old lab", published: false }]);
  });

  it("cannot be combined with --only or --path", async () => {
    const result = await invoke(["push", repo, "--course", "42", "--clean", "--only", "pages"], { client: canvas });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("cannot be combined with --only or --path");
  });

  it("refuses when student work exists, and deletes nothing", async () => {
    canvas.getObject.mockResolvedValue({ id: 77, has_submitted_submissions: true });
    const result = await invoke(["push", repo, "--course", "42", "--clean", "--yes"], { client: canvas });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("refusing: assignment 'Old lab' (77) has submissions");
    expect(result.stderr).toContain("A clean sync is for a course nobody has used yet.");
    expect(canvas.deleteObject).not.toHaveBeenCalled();
    expect(canvas.createAssignment).not.toHaveBeenCalled();
  });

  it("a dry run lists what would go and deletes nothing", async () => {
    const result = await invoke(["push", repo, "--course", "42", "--clean", "--dry-run"], { client: canvas });

    expect(result.code, result.output).toBe(0);
    expect(result.stdout).toContain("Clean sync of course 42");
    expect(result.stdout).toContain("Old lab");
    expect(result.stdout).toContain("dry run: would delete 2 and forget 0");
    expect(canvas.deleteObject).not.toHaveBeenCalled();
  });

  it("asks first, and no leaves the course alone", async () => {
    const result = await invoke(["push", repo, "--course", "42", "--clean"], { client: canvas, input: "n\n" });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Delete these 2 object(s) from course 42? This cannot be undone");
    expect(result.stderr).toContain("Aborted!");
    expect(canvas.deleteObject).not.toHaveBeenCalled();
    expect(canvas.createAssignment).not.toHaveBeenCalled();
  });

  it("yes deletes, then pushes everything", async () => {
    const result = await invoke(["push", repo, "--course", "42", "--clean", "--no-verify"], {
      client: canvas,
      input: "y\n",
    });

    expect(result.code, result.output).toBe(0);
    expect(canvas.deleteObject.mock.calls).toEqual([
      ["assignment", "42", "77"],
      ["page", "42", "old-page"],
    ]);
    expect(result.stdout).toContain("deleted 2, forgot 0 stale manifest entr(ies)");
    expect(canvas.createAssignment).toHaveBeenCalled();
  });

  it("nothing to clean carries straight on", async () => {
    canvas.listPages.mockResolvedValue([]);
    canvas.getAssignments.mockResolvedValue([]);
    const result = await invoke(["push", repo, "--course", "42", "--clean", "--no-verify"], { client: canvas });

    expect(result.code, result.output).toBe(0);
    expect(result.stdout).toContain("nothing to clean");
  });
});

describe("verify", () => {
  beforeEach(() => {
    // Both projects in a module, so the module membership check has nothing to say.
    writeFileSync(
      path.join(repo, "canvas.toml"),
      TOML.replace('items = ["assignments/p0.md"]', 'items = ["assignments/p0.md", "assignments/p1.md"]'),
      "utf-8",
    );
  });

  it("a course never pushed says so and exits 1", async () => {
    const result = await invoke(["verify", repo, "--course", "42"], { client: canvas });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Nothing in the manifest for this course, push first.");
  });

  it("an intact course verifies", async () => {
    writeManifest(repo, {
      "index.md": { kind: "syllabus", canvas_id: "42", page_url: "", title: "S", extra: {} },
    });
    const result = await invoke(["verify", repo, "--course", "42"], { client: canvas });

    expect(result.code, result.output).toBe(0);
    expect(result.stdout).toContain("all 1 objects verified against Canvas");
  });

  it("a missing object fails with a summary", async () => {
    writeManifest(repo, {
      "assignments/p0.md": { kind: "assignment", canvas_id: "7", page_url: "", title: "P0", extra: {} },
    });
    canvas.getAssignmentFull.mockRejectedValue(new Error("Canvas API error 404"));
    const result = await invoke(["verify", repo, "--course", "42"], { client: canvas });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("assignment 7 does not resolve in Canvas");
    expect(result.stderr).toContain("1 failure(s): {'missing': 1}");
  });
});

describe("audit", () => {
  it("json is the differences with the Python field names, and stale exits 1", async () => {
    writeManifest(repo, {
      "assignments/p0.md": { kind: "assignment", canvas_id: "7", page_url: "", title: "P0", extra: {} },
    });
    const result = await invoke(["audit", repo, "--course", "42", "--json"], { client: canvas });

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual([
      { side: "stale", kind: "assignment", ident: "7", title: "P0", key: "assignments/p0.md", detail: "" },
      {
        side: "pending",
        kind: "module",
        ident: "",
        title: "Week 1",
        key: "",
        detail: "declared in canvas.toml; the next push creates it",
      },
    ]);
  });

  it("a course that matches its manifest agrees", async () => {
    writeManifest(repo, {
      "assignments/p0.md": { kind: "assignment", canvas_id: "7", page_url: "", title: "P0", extra: {} },
    });
    canvas.getAssignments.mockResolvedValue([{ id: 7, name: "P0", published: false }]);
    canvas.listModules.mockResolvedValue([{ id: 9, name: "Week 1", published: false }]);
    const result = await invoke(["audit", repo, "--course", "42"], { client: canvas });

    expect(result.code, result.output).toBe(0);
    expect(result.stdout).toContain("the manifest and course 42 agree: 1 tracked objects, nothing untracked");
  });

  it("untracked objects are listed but do not fail", async () => {
    canvas.getAssignments.mockResolvedValue([{ id: 77, name: "Hand built", published: true }]);
    const result = await invoke(["audit", repo, "--course", "42"], { client: canvas });

    expect(result.code, result.output).toBe(0);
    expect(result.stdout).toContain("Hand built");
    expect(result.stdout).toContain("difference(s): {'untracked assignment': 1, 'pending module': 1}");
  });
});

describe("outline", () => {
  it("--out writes the same bytes the Python wrote", async () => {
    const out = path.join(tmpDir(), "site", "outline.json");
    const result = await invoke(["outline", repo, "--out", out], { env: {} });

    expect(result.code, result.output).toBe(0);
    expect(result.stdout).toContain("(1 modules)");
    const written = readFileSync(out, "utf-8");
    expect(written).toBe(`${toJsonText(courseOutline(repo))}\n`);
    expect(written).toContain('"points": 50.0');
  });

  it("without --out it prints a table per module", async () => {
    const result = await invoke(["outline", repo], { env: {} });

    expect(result.code, result.output).toBe(0);
    expect(result.stdout).toContain("Week 1");
    expect(result.stdout).toContain("P0");
    expect(result.stdout).toContain("2026-09-01");
  });
});

describe("dates", () => {
  it("--show prints the schedule without a token", async () => {
    const result = await invoke(["dates", repo, "--show"], { env: {} });

    expect(result.code, result.output).toBe(0);
    expect(result.stdout).toContain("15-week schedule, 2 gradable items");
    expect(result.stdout).toContain("Sep 01 23:59");
    expect(result.stdout).not.toContain("--show only prints");
  });

  it("--shift moves the whole term", async () => {
    const result = await invoke(["dates", repo, "--show", "--shift", "7d"], { env: {} });

    expect(result.stdout).toContain("Showing the term shifted by +7 days.");
    expect(result.stdout).toContain("Sep 08 23:59");
  });

  it("a bad --shift exits 1", async () => {
    const result = await invoke(["dates", repo, "--shift", "a week"], { env: {} });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Bad --shift value");
  });

  it("a malformed canvas.toml is a date configuration error", async () => {
    writeFileSync(path.join(repo, "canvas.toml"), "[term]\nweeks = 15\n", "utf-8");
    const result = await invoke(["dates", repo], { env: {} });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Date configuration error:");
  });
});

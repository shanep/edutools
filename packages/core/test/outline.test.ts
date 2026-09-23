/** Tests for the module outline a site renders from the repo. */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ItemDates, loadConfig } from "@edutools/core/dates";
import { type OutlineItem, outline, toJson, toJsonText } from "@edutools/core/outline";
import { DateTime } from "luxon";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";

function dates(file: string, title: string, points: number): ItemDates {
  const due = DateTime.fromObject({ year: 2026, month: 9, day: 9, hour: 23, minute: 59 }, { zone: "America/Boise" });
  return new ItemDates({ path: file, title, kind: "lab", week: 3, points, unlockAt: null, dueAt: due, lockAt: due });
}

function tmp(): string {
  return mkdtempSync(path.join(os.tmpdir(), "edutools-"));
}

function repo(): string {
  const root = tmp();
  mkdirSync(path.join(root, "notes"));
  mkdirSync(path.join(root, "activities"));
  writeFileSync(path.join(root, "notes", "ch01.md"), "# Chapter 1\n", "utf8");
  writeFileSync(path.join(root, "activities", "a1.md"), "# A1 - Dig\n\n**Week 3 · 20 points**\n", "utf8");
  writeFileSync(path.join(root, "activities", "a9.md"), "---\ndraft: true\n---\n\n# A9\n", "utf8");
  return root;
}

function item(fields: Partial<OutlineItem> & Pick<OutlineItem, "kind" | "title">): OutlineItem {
  return { path: "", dueAt: null, points: null, canvasId: "", ...fields };
}

describe("outline", () => {
  it("lists the page, then the items, then the native items, in order", () => {
    const modules = [
      {
        title: "Week 1",
        page: "notes/ch01.md",
        items: ["activities/a1.md"],
        canvas: [{ quiz: 393657, title: "Chapter 1 - Knowledge Check" }],
      },
    ];
    const itemDates = { "activities/a1.md": dates("activities/a1.md", "A1 - Dig", 20) };
    const result = outline(repo(), modules, { "notes/ch01.md": "page", "activities/a1.md": "assignment" }, itemDates);
    expect(result.length).toBe(1);
    expect(result[0]?.title).toBe("Week 1");
    expect(result[0]?.items).toEqual([
      item({ kind: "page", title: "Chapter 1", path: "notes/ch01" }),
      item({
        kind: "assignment",
        title: "A1 - Dig",
        path: "activities/a1",
        dueAt: "2026-09-09T23:59:00-06:00",
        points: 20,
      }),
      item({ kind: "quiz", title: "Chapter 1 - Knowledge Check", canvasId: "393657" }),
    ]);
  });

  it("leaves a draft out, as the push leaves it out", () => {
    const modules = [{ title: "Week 9", items: ["activities/a9.md", "activities/a1.md"] }];
    const result = outline(repo(), modules, { "activities/a1.md": "assignment" }, {});
    expect(result[0]?.items.map((i) => i.title)).toEqual(["A1 - Dig"]);
  });

  it("skips a missing file rather than failing", () => {
    const result = outline(repo(), [{ title: "W", page: "notes/nope.md" }], {}, {});
    expect(result[0]?.items).toEqual([]);
  });

  it("gives a native item without a title a placeholder", () => {
    const result = outline(repo(), [{ title: "W", canvas: [{ quiz: 7 }] }], {}, {});
    expect(result[0]?.items[0]?.title).toBe("quiz 7");
  });

  it("serialises to plain objects with the Python field names", () => {
    const result = outline(repo(), [{ title: "W", page: "notes/ch01.md" }], {}, {});
    expect(toJson(result)).toEqual([
      {
        title: "W",
        items: [{ kind: "page", title: "Chapter 1", path: "notes/ch01", due_at: null, points: null, canvas_id: "" }],
      },
    ]);
  });

  it("writes the JSON text byte for byte as Python's json.dumps(indent=2)", () => {
    const modules = [
      { title: "Week 1 · Intro", page: "notes/ch01.md", items: ["activities/a1.md"], canvas: [{ quiz: 7 }] },
      { title: "Empty" },
    ];
    const itemDates = { "activities/a1.md": dates("activities/a1.md", "A1 - Dig", 20) };
    const text = toJsonText(outline(repo(), modules, { "activities/a1.md": "assignment" }, itemDates));
    expect(text).toBe(
      [
        "[",
        "  {",
        '    "title": "Week 1 \\u00b7 Intro",',
        '    "items": [',
        "      {",
        '        "kind": "page",',
        '        "title": "Chapter 1",',
        '        "path": "notes/ch01",',
        '        "due_at": null,',
        '        "points": null,',
        '        "canvas_id": ""',
        "      },",
        "      {",
        '        "kind": "assignment",',
        '        "title": "A1 - Dig",',
        '        "path": "activities/a1",',
        '        "due_at": "2026-09-09T23:59:00-06:00",',
        '        "points": 20.0,',
        '        "canvas_id": ""',
        "      },",
        "      {",
        '        "kind": "quiz",',
        '        "title": "quiz 7",',
        '        "path": "",',
        '        "due_at": null,',
        '        "points": null,',
        '        "canvas_id": "7"',
        "      }",
        "    ]",
        "  },",
        "  {",
        '    "title": "Empty",',
        '    "items": []',
        "  }",
        "]",
      ].join("\n"),
    );
  });

  // From tests/test_publish.py TestOutlineHidesNeverPublish.
  it("leaves a never_publish module out", () => {
    const root = tmp();
    writeFileSync(path.join(root, "a.md"), "# A\n", "utf8");
    const modules = [
      { title: "Instructor Resources", never_publish: true, items: ["a.md"] },
      { title: "Module 1", items: ["a.md"] },
    ];
    expect(outline(root, modules, {}, {}).map((m) => m.title)).toEqual(["Module 1"]);
  });

  // From tests/test_publish.py TestModuleHeadersAndDates. The Python test takes
  // the term from a Publisher; loadConfig reads the same [term] without one.
  it("shows the header and the dated title", () => {
    const root = tmp();
    writeFileSync(path.join(root, "index.md"), "# S\n", "utf8");
    writeFileSync(path.join(root, "o.md"), "# Module 1 Overview\n", "utf8");
    writeFileSync(
      path.join(root, "canvas.toml"),
      "[term]\n" +
        'timezone = "America/Boise"\n' +
        "first_monday = 2026-08-24\nweeks = 15\n" +
        "last_day_of_instruction = 2026-12-11\n" +
        "finals_start = 2026-12-14\nfinals_end = 2026-12-18\ntotal_points = 0\n\n" +
        '[term.policy.project]\ndue = "tue 23:59"\n\n' +
        '[layout]\nsyllabus = "index.md"\npages = ["o.md"]\nfiles = []\n\n' +
        '[[module]]\ntitle = "Module 1: Intro"\nweek = 1\npage = "o.md"\n' +
        'items = [{ header = "Due by Sunday at 11:59 p.m." }]\n',
      "utf8",
    );
    const raw = parseToml(readFileSync(path.join(root, "canvas.toml"), "utf8"));
    const modules = Array.isArray(raw.module) ? raw.module : [];
    const result = outline(root, modules, { "o.md": "page" }, {}, loadConfig(root).term);
    expect(result[0]?.title).toBe("Module 1: Intro (August 24 - August 30)");
    expect(result[0]?.items.map((i) => i.kind)).toEqual(["page", "header"]);
  });
});

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { memoryStore } from "@edutools/core/credentials";
import { beforeEach, describe, expect, it } from "vitest";
import { type ApiDeps, createApi } from "../src/main/api";
import { writeSampleRepo } from "../src/main/sampleRepo";
import { SETTINGS_FILENAME } from "../src/main/settings";
import { FakeCanvas } from "./fakeCanvas";

const BSU = "https://boisestatecanvas.instructure.com";
const OTHER = "https://other.instructure.com";
const COURSE = { id: "20", name: "Software Engineering", code: "CS 471" };

let dir: string;
let repo: string;
let picked: string | null;
let dialogs: Array<{ kind: string; defaultPath: string; title: string | undefined }>;
let saveTo: string | null;

function makeApi(extra: Partial<ApiDeps> = {}) {
  return createApi({
    version: "1.2.3",
    credentials: { dir, secrets: memoryStore(), legacyPath: path.join(dir, "config.toml") },
    openExternal: async () => {},
    canvas: () => new FakeCanvas(),
    documentsDir: path.join(dir, "Documents"),
    chooseFolder: async (defaultPath, title) => {
      dialogs.push({ kind: "folder", defaultPath, title });
      return picked;
    },
    chooseSaveFile: async (defaultPath, title) => {
      dialogs.push({ kind: "save", defaultPath, title });
      return saveTo;
    },
    ...extra,
  });
}

async function withRepo() {
  const api = makeApi();
  await api.addSite({ name: "BSU", endpoint: BSU, token: "tok" });
  picked = repo;
  await api.chooseCourseRepo(COURSE.id);
  return api;
}

function edit(rel: string, change: (text: string) => string) {
  const file = path.join(repo, rel);
  writeFileSync(file, change(readFileSync(file, "utf8")), "utf8");
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "edutools-"));
  repo = writeSampleRepo(path.join(dir, "repo"));
  picked = null;
  dialogs = [];
  saveTo = null;
});

describe("the course repository", () => {
  it("is none until one is chosen", async () => {
    const api = makeApi();
    await api.addSite({ name: "BSU", endpoint: BSU, token: "tok" });
    expect(await api.getCourseRepo(COURSE.id)).toBeNull();
  });

  it("is chosen with a folder dialog and remembered per site and course", async () => {
    const api = await withRepo();
    expect(dialogs[0]?.title).toMatch(/course repository/);
    expect(await makeApi().getCourseRepo(COURSE.id)).toEqual({
      path: repo,
      problem: null,
      weeks: 15,
      timezone: "America/Boise",
    });
    expect(await api.getCourseRepo("21")).toBeNull();
    const saved = JSON.parse(readFileSync(path.join(dir, SETTINGS_FILENAME), "utf8"));
    expect(saved.repos).toEqual({ [`${BSU}#20`]: repo });
    await api.addSite({ name: "Other", endpoint: OTHER, token: "t2" });
    await api.setDefaultSite("Other");
    expect(await api.getCourseRepo(COURSE.id)).toBeNull();
  });

  it("does not remember a folder with no canvas.toml", async () => {
    const api = makeApi();
    await api.addSite({ name: "BSU", endpoint: BSU, token: "tok" });
    picked = dir;
    expect((await api.chooseCourseRepo(COURSE.id))?.problem).toMatch(/no canvas.toml/);
    expect(await api.getCourseRepo(COURSE.id)).toBeNull();
  });

  it("returns null when the dialog is cancelled", async () => {
    const api = makeApi();
    await api.addSite({ name: "BSU", endpoint: BSU, token: "tok" });
    expect(await api.chooseCourseRepo(COURSE.id)).toBeNull();
  });

  it("describes a canvas.toml that does not load in plain words", async () => {
    const api = await withRepo();
    edit("canvas.toml", (t) => t.replace("first_monday = 2026-08-24", "first_monday = 2026-08-25"));
    const info = await api.getCourseRepo(COURSE.id);
    expect(info?.problem).toBe(
      "canvas.toml has a problem: [term] first_monday 2026-08-25 is a Tuesday, not a Monday. Fix it in the file, then choose Refresh.",
    );
    edit("canvas.toml", (t) => `${t}\n[broken\n`);
    expect((await api.getCourseRepo(COURSE.id))?.problem).toMatch(/^canvas.toml is not valid TOML \(line \d+\)/);
    await expect(api.courseOutline(COURSE.id)).rejects.toThrow(/canvas.toml is not valid TOML/);
  });

  it("can be forgotten", async () => {
    const api = await withRepo();
    await api.forgetCourseRepo(COURSE.id);
    expect(await api.getCourseRepo(COURSE.id)).toBeNull();
    await expect(api.courseOutline(COURSE.id)).rejects.toThrow(/No course repository is chosen/);
  });
});

describe("the outline", () => {
  it("lists what a push will build, leaving out never_publish modules", async () => {
    const outline = await (await withRepo()).courseOutline(COURSE.id);
    expect(outline.repo).toBe(repo);
    expect(outline.modules).toEqual([
      {
        title: "Getting started (August 24 - August 30)",
        items: [
          { kind: "page", title: "Week 1 overview", path: "modules/week-01", dueAt: null, points: null, canvasId: "" },
          {
            kind: "assignment",
            title: "Lab 1: Hello",
            path: "assignments/lab-01",
            dueAt: "2026-08-30T23:59:00-06:00",
            points: 30,
            canvasId: "",
          },
        ],
      },
    ]);
  });

  it("exports the JSON the CLI writes, through a save dialog", async () => {
    const api = await withRepo();
    saveTo = path.join(dir, "out.json");
    expect(await api.exportOutline(COURSE.id)).toBe(saveTo);
    const text = readFileSync(saveTo, "utf8");
    expect(text.endsWith("]\n")).toBe(true);
    // Points are floats in the Python output, so the file carries 30.0.
    expect(text).toContain('"points": 30.0');
    expect(JSON.parse(text)[0].items[1].due_at).toBe("2026-08-30T23:59:00-06:00");
    expect(dialogs.at(-1)).toMatchObject({ kind: "save", defaultPath: path.join(repo, "outline.json") });
  });

  it("writes nothing when the save is cancelled", async () => {
    expect(await (await withRepo()).exportOutline(COURSE.id)).toBeNull();
  });
});

describe("the dates", () => {
  it("computes the schedule as dates --show prints it", async () => {
    const schedule = await (await withRepo()).courseSchedule(COURSE.id, 0);
    expect(schedule).toMatchObject({ weeks: 15, timezone: "America/Boise", shiftDays: 0, totalPoints: 30, problems: [] });
    expect(schedule.items).toEqual([
      {
        path: "assignments/lab-01.md",
        title: "Lab 1: Hello",
        kind: "lab",
        week: 1,
        points: 30,
        unlockAt: "2026-08-24T00:00:00-06:00",
        dueAt: "2026-08-30T23:59:00-06:00",
        lockAt: "2026-09-01T23:59:00-06:00",
        unlockText: "Aug 24 00:00",
        dueText: "Aug 30 23:59",
        lockText: "Sep 01 23:59",
      },
    ]);
  });

  it("previews a shifted term without writing anything", async () => {
    const api = await withRepo();
    const before = readFileSync(path.join(repo, "canvas.toml"), "utf8");
    const shifted = await api.courseSchedule(COURSE.id, 7);
    expect(shifted.shiftDays).toBe(7);
    expect(shifted.items[0]?.dueText).toBe("Sep 06 23:59");
    expect(readFileSync(path.join(repo, "canvas.toml"), "utf8")).toBe(before);
  });

  it("lists every problem it finds", async () => {
    const api = await withRepo();
    edit("assignments/lab-01.md", (t) => t.replace("30 points", "25 points"));
    const schedule = await api.courseSchedule(COURSE.id, 0);
    expect(schedule.problems).toEqual(["points across all gradable items sum to 25, not 30"]);
  });

  it("cross-checks the syllabus schedule when there is one", async () => {
    const api = await withRepo();
    writeFileSync(path.join(repo, "syllabus.md"), "| Week | Dates |\n|---|---|\n| 1 | Aug 25-31 |\n", "utf8");
    expect((await api.courseSchedule(COURSE.id, 0)).problems.length).toBe(1);
  });

  it("refuses a shift that is not a whole number of days", async () => {
    const api = await withRepo();
    await expect(api.courseSchedule(COURSE.id, 1.5)).rejects.toThrow(/whole number/);
    await expect(api.courseSchedule(COURSE.id, 4000)).rejects.toThrow(/whole number/);
  });

  it("says when the repository folder has gone", async () => {
    const api = await withRepo();
    const moved = path.join(dir, "moved");
    mkdirSync(moved);
    const { renameSync } = await import("node:fs");
    renameSync(repo, path.join(moved, "repo"));
    await expect(api.courseSchedule(COURSE.id, 0)).rejects.toThrow(/is not there any more/);
  });
});

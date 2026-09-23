import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { memoryStore } from "@edutools/core/credentials";
import { KINDS } from "@edutools/core/pull";
import { beforeEach, describe, expect, it } from "vitest";
import { type ApiDeps, createApi } from "../src/main/api";
import { SETTINGS_FILENAME } from "../src/main/settings";
import type { EdutoolsEvents, EventName } from "../src/shared/ipc";
import { formatDate, formatPoints } from "../src/shared/overview";
import { FakeCanvas } from "./fakeCanvas";

const BSU = "https://boisestatecanvas.instructure.com";
const OTHER = "https://other.instructure.com";
const COURSE = { id: "20", name: "Software Engineering", code: "CS 471" };

let dir: string;
let documents: string;
let secrets: ReturnType<typeof memoryStore>;
let fake: FakeCanvas;
let connections: Array<{ endpoint: string; token: string }>;
let events: Array<{ event: EventName; payload: EdutoolsEvents[EventName] }>;

function makeApi(extra: Partial<ApiDeps> = {}) {
  return createApi({
    version: "1.2.3",
    credentials: { dir, secrets, legacyPath: path.join(dir, "config.toml") },
    openExternal: async () => {},
    canvas: (endpoint, token) => {
      connections.push({ endpoint, token });
      return fake;
    },
    emit: (event, payload) => void events.push({ event, payload }),
    documentsDir: documents,
    ...extra,
  });
}

async function withSite(extra: Partial<ApiDeps> = {}) {
  const api = makeApi(extra);
  await api.addSite({ name: "BSU", endpoint: BSU, token: "tok" });
  return api;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "edutools-"));
  documents = path.join(dir, "Documents");
  secrets = memoryStore();
  fake = new FakeCanvas();
  connections = [];
  events = [];
});

describe("the current course", () => {
  it("is none until one is chosen", async () => {
    expect(await (await withSite()).getCurrentCourse()).toBeNull();
  });

  it("is remembered in the settings file, with the site it belongs to", async () => {
    const api = await withSite();
    expect(await api.setCurrentCourse(COURSE)).toEqual({ ...COURSE, endpoint: BSU });
    // A new api is a new launch of the app.
    expect(await makeApi().getCurrentCourse()).toEqual({ ...COURSE, endpoint: BSU });
    const saved = JSON.parse(readFileSync(path.join(dir, SETTINGS_FILENAME), "utf8"));
    expect(saved.currentCourse.id).toBe("20");
    expect(JSON.stringify(saved)).not.toContain("tok");
  });

  it("is forgotten while another site is the default", async () => {
    const api = await withSite();
    await api.setCurrentCourse(COURSE);
    await api.addSite({ name: "Other", endpoint: OTHER, token: "tok2" });
    await api.setDefaultSite("Other");
    expect(await api.getCurrentCourse()).toBeNull();
    await api.setDefaultSite("BSU");
    expect(await api.getCurrentCourse()).toMatchObject({ id: "20" });
  });

  it("can be cleared", async () => {
    const api = await withSite();
    await api.setCurrentCourse(COURSE);
    expect(await api.setCurrentCourse(null)).toBeNull();
    expect(await api.getCurrentCourse()).toBeNull();
  });

  it("needs a site and a numeric course id", async () => {
    await expect(makeApi().setCurrentCourse(COURSE)).rejects.toThrow(/No Canvas site/);
    const api = await withSite();
    await expect(api.setCurrentCourse({ ...COURSE, id: "20/../21" })).rejects.toThrow(/not a Canvas course id/);
  });

  it("survives a settings file it cannot read", async () => {
    writeFileSync(path.join(dir, SETTINGS_FILENAME), "{not json");
    expect(await (await withSite()).getCurrentCourse()).toBeNull();
  });
});

describe("the course overview", () => {
  beforeEach(() => {
    fake.groups = [
      { id: 1, name: "Homework", group_weight: 40, position: 1 },
      { id: 2, name: "Exams", group_weight: 60, position: 2 },
    ];
    fake.assignments = [
      {
        id: 7,
        name: "Project 1",
        points_possible: 10,
        due_at: "2026-09-30T05:59:00Z",
        published: true,
        assignment_group_id: 1,
        html_url: `${BSU}/courses/20/assignments/7`,
      },
      { id: 8, name: "Midterm", points_possible: null, due_at: null, published: false, assignment_group_id: 2 },
      { id: 9, name: "Final", points_possible: 100, published: false, assignment_group_id: 2 },
    ];
  });

  it("lists assignments with their group names, using the default site's token", async () => {
    const rows = await (await withSite()).listAssignments("20");
    expect(rows[0]).toEqual({
      id: "7",
      name: "Project 1",
      points: 10,
      dueAt: "2026-09-30T05:59:00Z",
      published: true,
      group: "Homework",
      htmlUrl: `${BSU}/courses/20/assignments/7`,
    });
    expect(rows[1]).toMatchObject({ points: null, dueAt: null, published: false, group: "Exams", htmlUrl: "" });
    expect(connections).toEqual([{ endpoint: BSU, token: "tok" }]);
    expect(fake.methods()).toEqual(["listAssignments", "listAssignmentGroups"]);
  });

  it("lists modules with their items in order, linking each module to its anchor", async () => {
    fake.modules = [
      { id: 5, name: "Week 1", published: true },
      { id: 6, name: "Week 2", published: false },
    ];
    fake.moduleItems = {
      "5": [
        { id: 51, title: "Overview", type: "SubHeader", indent: 0 },
        { id: 52, title: "Read me", type: "Page", indent: 1, published: true, html_url: `${BSU}/courses/20/modules/items/52` },
      ],
    };
    const modules = await (await withSite()).listModules("20");
    expect(modules.map((m) => [m.name, m.published, m.items.length])).toEqual([
      ["Week 1", true, 2],
      ["Week 2", false, 0],
    ]);
    expect(modules[0]?.htmlUrl).toBe(`${BSU}/courses/20/modules#context_module_5`);
    expect(modules[0]?.items).toEqual([
      { id: "51", title: "Overview", type: "SubHeader", indent: 0, published: null, htmlUrl: "" },
      { id: "52", title: "Read me", type: "Page", indent: 1, published: true, htmlUrl: `${BSU}/courses/20/modules/items/52` },
    ]);
    // One request at a time, in module order: Canvas throttles parallel reads.
    expect(fake.methods()).toEqual(["listModules", "listModuleItems", "listModuleItems"]);
  });

  it("lists pages by url slug", async () => {
    fake.pages = [
      { url: "syllabus-notes", title: "Syllabus notes", published: false, updated_at: "2026-09-01T12:00:00Z", html_url: `${BSU}/courses/20/pages/syllabus-notes` },
    ];
    expect(await (await withSite()).listPages("20")).toEqual([
      {
        url: "syllabus-notes",
        title: "Syllabus notes",
        published: false,
        updatedAt: "2026-09-01T12:00:00Z",
        htmlUrl: `${BSU}/courses/20/pages/syllabus-notes`,
      },
    ]);
  });

  it("counts each group's assignments and says whether the course weights by group", async () => {
    fake.course = { id: 20, apply_assignment_group_weights: true };
    const list = await (await withSite()).listAssignmentGroups("20");
    expect(list).toEqual({
      weighted: true,
      htmlUrl: `${BSU}/courses/20/assignments`,
      groups: [
        { id: "1", name: "Homework", weight: 40, assignmentCount: 1 },
        { id: "2", name: "Exams", weight: 60, assignmentCount: 2 },
      ],
    });
    // Without the include, Canvas leaves `assignments` out and every group counts zero.
    expect(fake.calls.find((c) => c.method === "listAssignmentGroups")?.args[1]).toEqual({ withAssignments: true });
  });

  it("reads a course without the weighting flag as unweighted", async () => {
    fake.course = { id: 20 };
    expect((await (await withSite()).listAssignmentGroups("20")).weighted).toBe(false);
  });

  it("refuses a course id that is not a number", async () => {
    const api = await withSite();
    await expect(api.listPages("20/pages/../../21")).rejects.toThrow(/not a Canvas course id/);
    await expect(api.listModules("")).rejects.toThrow("The course id is required.");
    expect(fake.calls).toEqual([]);
  });

  it("formats dates in the given time zone and points as Canvas shows them", () => {
    expect(formatDate("2026-09-30T05:59:00Z", "", "America/Boise")).toContain("11:59");
    expect(formatDate("2026-09-30T05:59:00Z", "", "UTC")).toContain("5:59");
    expect(formatDate(null, "No due date")).toBe("No due date");
    expect(formatDate("not a date")).toBe("not a date");
    expect(formatPoints(2.5)).toBe("2.5");
    expect(formatPoints(null)).toBe("");
  });
});

describe("the snapshot", () => {
  const out = () => path.join(dir, "snap");

  beforeEach(() => {
    fake.course = { id: 20, name: "Software Engineering", course_code: "CS 471", syllabus_body: "<p>Hi</p>" };
    fake.pages = [
      { url: "welcome", title: "Welcome", body: "<p>Welcome</p>" },
      { url: "old-news", title: "Old news", body: "<p>Old</p>" },
    ];
    fake.assignments = [{ id: 7, name: "Project 1", description: "<p>Do it</p>" }];
    fake.modules = [{ id: 5, name: "Week 1" }];
    fake.groups = [{ id: 1, name: "Homework" }];
    fake.files = [
      {
        id: 3,
        display_name: "notes.txt",
        folder_id: 1,
        url: "https://files.example.edu/3",
        size: 5,
        modified_at: "2026-09-01T12:00:00Z",
      },
    ];
  });

  it("defaults to a folder named for the course code under Documents, with every kind", async () => {
    const api = makeApi();
    expect(await api.snapshotDefaults(COURSE)).toEqual({
      folder: path.join(documents, "edutools", "CS 471"),
      kinds: [...KINDS],
    });
    expect((await api.snapshotDefaults({ ...COURSE, code: " " })).folder).toBe(path.join(documents, "edutools", "20"));
    // A code with characters Windows refuses still makes a legal folder name.
    expect((await api.snapshotDefaults({ ...COURSE, code: "CS 471: Fall?" })).folder).toBe(
      path.join(documents, "edutools", "CS 471_ Fall_"),
    );
  });

  it("pulls the course, streams progress as events, and sums up what landed", async () => {
    const api = await withSite();
    const summary = await api.startSnapshot({ courseId: "20", folder: out(), kinds: KINDS });
    expect(summary).toEqual({
      courseId: "20",
      courseName: "Software Engineering",
      folder: out(),
      counts: [
        { kind: "syllabus", count: 1 },
        { kind: "pages", count: 2 },
        { kind: "assignments", count: 1 },
        { kind: "discussions", count: 0 },
        { kind: "announcements", count: 0 },
        { kind: "quizzes", count: 0 },
        { kind: "modules", count: 1 },
        { kind: "groups", count: 1 },
        { kind: "rubrics", count: 0 },
        { kind: "files", count: 1 },
      ],
      downloaded: 1,
      unchanged: 0,
      removed: [],
      problems: [],
    });
    expect(existsSync(path.join(out(), "pages", "welcome.html"))).toBe(true);
    expect(events.every((e) => e.event === "snapshotProgress")).toBe(true);
    expect(events.map((e) => e.payload)).toContainEqual({ courseId: "20", message: "Reading pages" });
    expect(events.map((e) => e.payload)).toContainEqual({ courseId: "20", message: "Downloading files/notes.txt" });
  });

  it("pulls only the chosen kinds", async () => {
    const api = await withSite();
    const summary = await api.startSnapshot({ courseId: "20", folder: out(), kinds: ["files", "pages"] });
    expect(summary.counts.map((c) => c.kind)).toEqual(["pages", "files"]);
    expect(fake.methods()).not.toContain("listAssignments");
  });

  it("reports what could not be fetched as problems and keeps going", async () => {
    fake.failing.add("listRubrics");
    const summary = await (await withSite()).startSnapshot({ courseId: "20", folder: out(), kinds: KINDS });
    expect(summary.problems).toEqual(["rubrics: Canvas API error 403: listRubrics is not allowed"]);
    expect(summary.counts.find((c) => c.kind === "files")?.count).toBe(1);
  });

  it("skips files already current and removes what Canvas no longer has", async () => {
    const api = await withSite();
    await api.startSnapshot({ courseId: "20", folder: out(), kinds: KINDS });
    fake.pages = fake.pages.filter((p) => p.url !== "old-news");
    const second = await api.startSnapshot({ courseId: "20", folder: out(), kinds: KINDS });
    expect(second.downloaded).toBe(0);
    expect(second.unchanged).toBe(1);
    expect(second.removed).toEqual(["pages/old-news.html", "pages/old-news.json"]);
  });

  it("runs one pull at a time", async () => {
    const api = await withSite();
    let release = () => {};
    fake.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = api.startSnapshot({ courseId: "20", folder: out(), kinds: ["pages"] });
    await expect(api.startSnapshot({ courseId: "20", folder: path.join(dir, "b"), kinds: ["pages"] })).rejects.toThrow(
      /already running/,
    );
    release();
    await first;
    // Finished, so the next one may start, and a failed one also frees the slot.
    fake.failing.add("getCourseWithSyllabus");
    await expect(api.startSnapshot({ courseId: "20", folder: out(), kinds: ["pages"] })).rejects.toThrow(/403/);
    fake.failing.clear();
    await expect(api.startSnapshot({ courseId: "20", folder: out(), kinds: ["pages"] })).resolves.toMatchObject({
      courseId: "20",
    });
  });

  it("checks what the renderer sends", async () => {
    const api = await withSite();
    const request = { courseId: "20", folder: out(), kinds: ["pages"] };
    await expect(api.startSnapshot({ ...request, kinds: [] })).rejects.toThrow(/at least one kind/);
    await expect(api.startSnapshot({ ...request, kinds: ["pages", "grades"] })).rejects.toThrow(/Unknown kind grades/);
    await expect(api.startSnapshot({ ...request, folder: "snap" })).rejects.toThrow(/full folder path/);
    await expect(api.startSnapshot({ ...request, courseId: "x" })).rejects.toThrow(/not a Canvas course id/);
    expect(fake.calls).toEqual([]);
  });

  it("opens the folder dialog at the nearest folder that exists", async () => {
    const asked: string[] = [];
    const api = makeApi({
      chooseFolder: async (p) => {
        asked.push(p);
        return "/picked";
      },
    });
    expect(await api.chooseFolder(path.join(documents, "edutools", "CS 471"))).toBe("/picked");
    expect(asked).toEqual([dir]);
    await expect(makeApi().chooseFolder(dir)).rejects.toThrow(/not available/);
  });

  it("shows a snapshot folder from the inside, and only a folder", async () => {
    const shown: string[] = [];
    const api = await withSite({ showItemInFolder: (p) => void shown.push(p) });
    mkdirSync(out());
    await api.showFolder(out());
    await api.startSnapshot({ courseId: "20", folder: out(), kinds: ["pages"] });
    await api.showFolder(out());
    expect(shown).toEqual([out(), path.join(out(), "index.json")]);
    await expect(api.showFolder(path.join(out(), "index.json"))).rejects.toThrow(/is not a folder/);
    await expect(api.showFolder("relative")).rejects.toThrow(/full folder path/);
  });
});

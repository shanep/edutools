import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { memoryStore } from "@edutools/core/credentials";
import { beforeEach, describe, expect, it } from "vitest";
import { type ApiDeps, createApi } from "../src/main/api";
import { writeSampleRepo } from "../src/main/sampleRepo";
import { EVENT_GUARDS, type EdutoolsEvents, type EventName, type JobProgress, type PushRequest, stripMarkup } from "../src/shared/ipc";
import { FakeCanvas } from "./fakeCanvas";

const BSU = "https://boisestatecanvas.instructure.com";
const C = "20";

let dir: string;
let repo: string;
let fake: FakeCanvas;
let secrets: ReturnType<typeof memoryStore>;
let connections: number;
let events: Array<{ event: EventName; payload: EdutoolsEvents[EventName] }>;
let shown: string[];

async function makeApi(extra: Partial<ApiDeps> = {}) {
  const api = createApi({
    version: "",
    credentials: { dir, secrets, legacyPath: path.join(dir, "config.toml") },
    openExternal: async () => {},
    canvas: () => {
      connections += 1;
      return fake;
    },
    emit: (event, payload) => void events.push({ event, payload }),
    chooseFolder: async (_start, title) => (title?.includes("repository") ? repo : path.join(dir, "preview")),
    showItemInFolder: (p) => void shown.push(p),
    ...extra,
  });
  await api.addSite({ name: "BSU", endpoint: BSU, token: "tok" });
  await api.setCurrentCourse({ id: C, name: "Software Engineering", code: "CS 471" });
  await api.chooseCourseRepo(C);
  return api;
}

function request(change: Partial<PushRequest> = {}): PushRequest {
  return { courseId: C, publish: false, updatePublished: false, only: [], paths: [], verify: false, ...change };
}

/** A manifest that says the repo already put modules/week-01.md into Canvas as the page "welcome". */
function trackWelcome(): void {
  mkdirSync(path.join(repo, ".canvas"), { recursive: true });
  writeFileSync(
    path.join(repo, ".canvas", `manifest-${C}.json`),
    JSON.stringify({
      entries: { "modules/week-01.md": { kind: "page", canvas_id: "welcome", page_url: "welcome", title: "Week 1", extra: {} } },
    }),
  );
}

function jobEvents(): JobProgress[] {
  return events.filter((e) => e.event === "jobProgress").map((e) => e.payload as JobProgress);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "edutools-"));
  repo = writeSampleRepo(path.join(dir, "repo"));
  fake = new FakeCanvas();
  secrets = memoryStore();
  connections = 0;
  events = [];
  shown = [];
});

describe("preview (the dry run)", () => {
  it("needs no token and asks Canvas nothing", async () => {
    const api = await makeApi();
    await secrets.delete(BSU);
    const summary = await api.previewPush(request());
    expect(summary.dryRun).toBe(true);
    expect(summary.problems).toEqual([]);
    expect(summary.selected).toEqual(expect.arrayContaining(["modules/week-01.md", "assignments/lab-01.md"]));
    expect(summary.rendered).toBeGreaterThan(0);
    expect(connections).toBe(0);
    expect(fake.calls).toEqual([]);
  });

  it("streams progress as typed events", async () => {
    const api = await makeApi();
    await api.previewPush(request());
    const progress = jobEvents();
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every((p) => EVENT_GUARDS.jobProgress(p))).toBe(true);
    expect(progress).toContainEqual(
      expect.objectContaining({ job: "push", courseId: C, kind: "progress", message: "Rendering assignments/lab-01.md" }),
    );
  });

  it("says in plain words when a file filter matches nothing", async () => {
    const api = await makeApi();
    await expect(api.previewPush(request({ paths: ["labs/nope.md"] }))).rejects.toThrow(
      /No file in the repository matches labs\/nope.md\. Check the spelling; files it can match include/,
    );
  });

  it("refuses a group push cannot be limited to", async () => {
    const api = await makeApi();
    await expect(api.previewPush(request({ only: ["grades"] }))).rejects.toThrow(/Unknown group grades/);
  });

  it("writes the rendered HTML into a chosen folder and reveals it", async () => {
    const api = await makeApi();
    await expect(api.writePushPreview(C)).rejects.toThrow(/Preview first/);
    await api.previewPush(request());
    const folder = await api.writePushPreview(C);
    expect(folder).toBe(path.join(dir, "preview"));
    expect(readdirSync(path.join(dir, "preview"))).toContain("assignments__lab-01.html");
    expect(shown).toEqual([folder]);
  });
});

describe("publishing", () => {
  it("is refused until these exact options have been previewed", async () => {
    const api = await makeApi();
    await expect(api.runPush(request())).rejects.toThrow(/Preview these exact options first/);
    await api.previewPush(request());
    await expect(api.runPush(request({ publish: true }))).rejects.toThrow(/Preview these exact options first/);
    expect(fake.writes()).toEqual([]);
  });

  it("creates new objects unpublished", async () => {
    const api = await makeApi();
    await api.previewPush(request());
    const summary = await api.runPush(request());
    expect(summary.dryRun).toBe(false);
    expect(summary.created).toBeGreaterThan(0);
    const page = fake.calls.find((c) => c.method === "createPage");
    expect(page?.args[3]).toBe(false);
  });

  it("leaves published content alone unless told to update it", async () => {
    trackWelcome();
    fake.json.set(`/api/v1/courses/${C}/pages/welcome`, { url: "welcome", published: true });
    const api = await makeApi();

    await api.previewPush(request());
    const guarded = await api.runPush(request());
    expect(guarded.protected).toContain("modules/week-01.md");
    expect(fake.calls.filter((c) => c.method === "updatePage")).toEqual([]);

    await api.previewPush(request({ updatePublished: true }));
    const rewritten = await api.runPush(request({ updatePublished: true }));
    expect(rewritten.protected).toEqual([]);
    expect(fake.calls.filter((c) => c.method === "updatePage").map((c) => c.args[1])).toContain("welcome");
  });

  it("reports progress from the real push too", async () => {
    const api = await makeApi();
    await api.previewPush(request());
    events = [];
    await api.runPush(request());
    expect(jobEvents().map((p) => p.message)).toContain("Building modules");
  });
});

describe("the clean sync", () => {
  it("is refused outright when anything it would delete holds student work, and deletes nothing", async () => {
    fake.assignments = [{ id: 50, name: "Old lab", published: true, has_submitted_submissions: true }];
    const api = await makeApi();
    const plan = await api.planCleanSync(C);
    expect(plan.targets.map((t) => t.ident)).toEqual(["50"]);
    expect(plan.refused).toEqual([
      { target: expect.objectContaining({ kind: "assignment", ident: "50" }), reason: "has submissions" },
    ]);
    await expect(api.runCleanSync({ courseId: C, confirmText: "CS 471", publish: false })).rejects.toThrow(
      /will not run, because students have used this course: assignment "Old lab" has submissions\. Nothing was deleted/,
    );
    expect(fake.writes()).toEqual([]);
  });

  it("needs a plan and the course code typed exactly", async () => {
    fake.pages = [{ url: "old-page", title: "Old page", published: false }];
    const api = await makeApi();
    await expect(api.runCleanSync({ courseId: C, confirmText: "CS 471", publish: false })).rejects.toThrow(/Plan the clean sync first/);
    const plan = await api.planCleanSync(C);
    expect(plan.confirmText).toBe("CS 471");
    expect(plan.targets.map((t) => t.ident)).toEqual(["old-page"]);
    await expect(api.runCleanSync({ courseId: C, confirmText: "cs471", publish: false })).rejects.toThrow(/Type CS 471 exactly/);
    expect(fake.writes()).toEqual([]);
  });

  it("deletes what the plan listed, then pushes everything", async () => {
    fake.pages = [{ url: "old-page", title: "Old page", published: false }];
    const api = await makeApi();
    await api.planCleanSync(C);
    const summary = await api.runCleanSync({ courseId: C, confirmText: "CS 471", publish: false });
    expect(summary.clean?.deleted.map((d) => d.ident)).toEqual(["old-page"]);
    expect(fake.calls.filter((c) => c.method === "deleteObject").map((c) => c.args.slice(0, 1).concat(c.args.slice(2)))).toEqual([
      ["page", "old-page"],
    ]);
    // A plan is used once.
    await expect(api.runCleanSync({ courseId: C, confirmText: "CS 471", publish: false })).rejects.toThrow(/Plan the clean sync first/);
  });

  it("lists what was already deleted when a delete fails part-way", async () => {
    fake.pages = [
      { url: "old-a", title: "Old A", published: false },
      { url: "old-b", title: "Old B", published: false },
    ];
    const api = await makeApi();
    await api.planCleanSync(C);
    let deletes = 0;
    const real = fake.deleteObject.bind(fake);
    fake.deleteObject = async (kind, course, id) => {
      deletes += 1;
      if (deletes === 2) throw new Error("Canvas API error 500");
      return real(kind, course, id);
    };
    await expect(api.runCleanSync({ courseId: C, confirmText: "CS 471", publish: false })).rejects.toThrow(
      /could not delete page "Old B" .*Already deleted before it stopped: page "Old A"\. Nothing was pushed\./,
    );
  });
});

describe("one Canvas job at a time", () => {
  it("shares one lock across snapshot, push, clean sync, verify and audit", async () => {
    const api = await makeApi();
    await api.previewPush(request());
    let release = () => {};
    fake.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const snapshot = api.startSnapshot({ courseId: C, folder: path.join(dir, "snap"), kinds: ["pages"] });
    for (const attempt of [
      () => api.runPush(request()),
      () => api.planCleanSync(C),
      () => api.verifyCourse(C),
      () => api.auditCourse(C),
    ]) {
      await expect(attempt()).rejects.toThrow("A snapshot is already running. Wait for it to finish before starting another.");
    }
    // A preview asks Canvas nothing, so it is not held up.
    await expect(api.previewPush(request())).resolves.toMatchObject({ dryRun: true });
    release();
    await snapshot;

    fake.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pushing = api.runPush(request());
    await expect(api.startSnapshot({ courseId: C, folder: path.join(dir, "snap"), kinds: ["pages"] })).rejects.toThrow(
      "A push is already running.",
    );
    release();
    await pushing;
  });
});

describe("verify and audit", () => {
  it("explains a course nothing has been published to", async () => {
    const api = await makeApi();
    await expect(api.verifyCourse(C)).rejects.toThrow(
      "Nothing has been published from this repository to this course yet, so there is nothing to verify. Publish first.",
    );
  });

  it("lists failures by object, check and detail", async () => {
    trackWelcome();
    const api = await makeApi();
    const result = await api.verifyCourse(C);
    expect(result.checked).toBe(1);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.failures[0]).toEqual({ key: "modules/week-01.md", check: expect.any(String), detail: expect.any(String) });
  });

  it("groups the differences by side", async () => {
    trackWelcome();
    fake.assignments = [{ id: 50, name: "Hand-built exam", published: true }];
    const api = await makeApi();
    const audit = await api.auditCourse(C);
    expect(audit.tracked).toBe(1);
    const sides = new Set(audit.differences.map((d) => d.side));
    expect(sides).toEqual(new Set(["stale", "untracked", "pending"]));
    expect(audit.differences.find((d) => d.side === "stale")).toMatchObject({ kind: "page", key: "modules/week-01.md" });
    expect(audit.differences.find((d) => d.side === "untracked" && d.kind === "assignment")).toMatchObject({
      ident: "50",
      title: "Hand-built exam",
    });
  });
});

describe("Rich markup from the publisher", () => {
  it("is stripped for the log, remembering a dim line", () => {
    expect(stripMarkup("[dim]group Labs (40%) <- lab[/dim]")).toEqual({ text: "group Labs (40%) <- lab", dim: true });
    expect(stripMarkup("[bold]done[/] \\[x]")).toEqual({ text: "done [x]", dim: false });
    expect(stripMarkup("keeps [unknown] text")).toEqual({ text: "keeps [unknown] text", dim: false });
  });
});

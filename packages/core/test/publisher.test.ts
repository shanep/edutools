/**
 * The publisher, driven against a fake Canvas client. No token and no network:
 * every client method is a vi.fn, and the assertions are on which methods were
 * called, with which ids and form fields, and in what order.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CanvasLMS } from "@edutools/core/canvas";
import { DateConfigError, ItemDates } from "@edutools/core/dates";
import { Entry } from "@edutools/core/publish";
import { Plan, Publisher, type PublisherCanvas, type PublisherOptions } from "@edutools/core/publisher";
import type { Payload } from "@edutools/core/types";
import { DateTime } from "luxon";
import { describe, expect, it, type Mock, vi } from "vitest";

function tmp(): string {
  return mkdtempSync(path.join(os.tmpdir(), "edutools-"));
}

function write(repo: string, key: string, text: string): string {
  const file = path.join(repo, key);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text, "utf-8");
  return file;
}

const TERM =
  "[term]\n" +
  'timezone = "America/Boise"\n' +
  "first_monday = 2026-08-24\nweeks = 15\n" +
  "last_day_of_instruction = 2026-12-11\n" +
  "finals_start = 2026-12-14\nfinals_end = 2026-12-18\ntotal_points = 0\n\n" +
  '[term.policy.project]\ndue = "tue 23:59"\n\n';

type Fake = { [K in keyof PublisherCanvas]: Mock<PublisherCanvas[K]> };

/**
 * A client whose every method records its call. The defaults answer as an empty
 * course would: nothing exists, lists are empty, and a create returns an id.
 */
function fakeCanvas(): Fake {
  const created = async (): Promise<Payload> => ({ id: "1" });
  return {
    getJson: vi.fn<CanvasLMS["getJson"]>(async () => ({})),
    exists: vi.fn<CanvasLMS["exists"]>(async () => false),
    updateSyllabus: vi.fn<CanvasLMS["updateSyllabus"]>(async () => ({})),
    listAssignmentGroups: vi.fn<CanvasLMS["listAssignmentGroups"]>(async () => []),
    createAssignmentGroup: vi.fn<CanvasLMS["createAssignmentGroup"]>(created),
    updateAssignmentGroup: vi.fn<CanvasLMS["updateAssignmentGroup"]>(async () => ({})),
    setGroupWeighting: vi.fn<CanvasLMS["setGroupWeighting"]>(async () => ({})),
    createPage: vi.fn<CanvasLMS["createPage"]>(async () => ({ url: "page" })),
    updatePage: vi.fn<CanvasLMS["updatePage"]>(async () => ({})),
    createAssignment: vi.fn<CanvasLMS["createAssignment"]>(created),
    updateAssignment: vi.fn<CanvasLMS["updateAssignment"]>(async () => ({})),
    createDiscussion: vi.fn<CanvasLMS["createDiscussion"]>(created),
    updateDiscussion: vi.fn<CanvasLMS["updateDiscussion"]>(async () => ({})),
    createQuiz: vi.fn<CanvasLMS["createQuiz"]>(created),
    updateQuiz: vi.fn<CanvasLMS["updateQuiz"]>(async () => ({})),
    listQuizQuestions: vi.fn<CanvasLMS["listQuizQuestions"]>(async () => []),
    createQuizQuestion: vi.fn<CanvasLMS["createQuizQuestion"]>(created),
    deleteQuizQuestion: vi.fn<CanvasLMS["deleteQuizQuestion"]>(async () => undefined),
    uploadFile: vi.fn<CanvasLMS["uploadFile"]>(created),
    listModules: vi.fn<CanvasLMS["listModules"]>(async () => []),
    createModule: vi.fn<CanvasLMS["createModule"]>(async () => ({ id: "9" })),
    updateModule: vi.fn<CanvasLMS["updateModule"]>(async () => ({})),
    listModuleItems: vi.fn<CanvasLMS["listModuleItems"]>(async () => []),
    createModuleItem: vi.fn<CanvasLMS["createModuleItem"]>(created),
    deleteModuleItem: vi.fn<CanvasLMS["deleteModuleItem"]>(async () => undefined),
    createRubric: vi.fn<CanvasLMS["createRubric"]>(created),
  };
}

/** Every call made to the fake, across all methods, in the order it was made. */
function callOrder(canvas: Fake): Array<[string, unknown[]]> {
  const calls: Array<[number, string, unknown[]]> = [];
  for (const [method, fn] of Object.entries(canvas)) {
    fn.mock.calls.forEach((args: unknown[], i: number) => {
      calls.push([fn.mock.invocationCallOrder[i] ?? 0, method, args]);
    });
  }
  return calls.sort((a, b) => a[0] - b[0]).map(([, method, args]) => [method, args]);
}

/** The flat form body of a call, however the fields were sent. */
function asRecord(fields: unknown): Record<string, string> {
  // The fake only ever receives form bodies, a record or a list of pairs.
  const body = fields as Record<string, string> | Array<[string, string]>;
  return Array.isArray(body) ? Object.fromEntries(body) : body;
}

function planFor(publisher: Publisher, key: string): Plan {
  const plan = publisher.plan().find((p) => p.key === key);
  if (plan === undefined) throw new Error(`${key} was not planned`);
  return plan;
}

describe("the published content guard", () => {
  // A push must not rewrite what a class is part-way through reading.
  function publisher(canvas: Fake, options: PublisherOptions = {}): Publisher {
    const repo = tmp();
    mkdirSync(path.join(repo, "assignments"));
    write(repo, "index.md", "# S\n");
    write(
      repo,
      "canvas.toml",
      `${TERM}[layout]\nsyllabus = "index.md"\npages = []\nfiles = []\n\n` +
        '[layout.gradable]\nproject = "assignments/p[0-9]*.md"\n',
    );
    return new Publisher(repo, "42", canvas, options);
  }

  const entry = () => new Entry({ kind: "assignment", canvasId: "7", title: "P0" });

  it("reports a published object live", async () => {
    const canvas = fakeCanvas();
    canvas.getJson.mockResolvedValue({ published: true });
    expect(await publisher(canvas).isLive(entry())).toBe(true);
    expect(canvas.getJson).toHaveBeenCalledWith("/api/v1/courses/42/assignments/7");
  });

  it("does not report an unpublished object live", async () => {
    const canvas = fakeCanvas();
    canvas.getJson.mockResolvedValue({ published: false });
    expect(await publisher(canvas).isLive(entry())).toBe(false);
  });

  it("lets update published opt back in", async () => {
    const canvas = fakeCanvas();
    canvas.getJson.mockResolvedValue({ published: true });
    expect(await publisher(canvas, { updatePublished: true }).isLive(entry())).toBe(false);
    expect(canvas.getJson).not.toHaveBeenCalled();
  });

  it("does not report an object that does not exist yet live", async () => {
    expect(await publisher(fakeCanvas()).isLive(null)).toBe(false);
  });

  it("reports the syllabus live when the course is available", async () => {
    const canvas = fakeCanvas();
    canvas.getJson.mockResolvedValue({ workflow_state: "available" });
    const syllabus = new Entry({ kind: "syllabus", canvasId: "42", title: "S" });
    expect(await publisher(canvas).isLive(syllabus)).toBe(true);
    expect(canvas.getJson).toHaveBeenCalledWith("/api/v1/courses/42");
  });

  it("does not report the syllabus live in an unpublished course", async () => {
    const canvas = fakeCanvas();
    canvas.getJson.mockResolvedValue({ workflow_state: "unpublished" });
    const syllabus = new Entry({ kind: "syllabus", canvasId: "42", title: "S" });
    expect(await publisher(canvas).isLive(syllabus)).toBe(false);
  });

  it("skips a live object and leaves it out of the link rewrite", async () => {
    const canvas = fakeCanvas();
    const pub = publisher(canvas);
    write(pub.repo, "assignments/p0.md", "# P0\n\n**Week 2 · 50 points · x**\n\n[a](p1.md)\n");
    pub.manifest.put("assignments/p0.md", entry());
    canvas.getJson.mockResolvedValue({ published: true });
    const plan = planFor(pub, "assignments/p0.md");
    const result = await pub.createOrUpdate(plan);
    expect(result.skipped).toBe(1);
    expect(pub.protected.has("assignments/p0.md")).toBe(true);
    expect(await pub.rewrite(plan)).toEqual([]);
    expect(callOrder(canvas).map(([method]) => method)).toEqual(["getJson"]);
  });
});

describe("the unlock field", () => {
  // An omitted unlock has to be sent empty; leaving the key out makes Canvas
  // keep whatever date is already on the object.
  function dates(unlock: DateTime | null): ItemDates {
    const due = DateTime.fromObject({ year: 2026, month: 9, day: 1, hour: 23, minute: 59 }, { zone: "UTC" });
    return new ItemDates({
      path: "assignments/p0.md",
      title: "P0",
      kind: "project",
      week: 2,
      points: 50,
      unlockAt: unlock,
      dueAt: due,
      lockAt: due.plus({ days: 2 }),
    });
  }

  function fields(unlock: DateTime | null): Record<string, string> {
    const repo = tmp();
    write(
      repo,
      "canvas.toml",
      "[term]\n" +
        'timezone = "America/Boise"\n' +
        "first_monday = 2026-08-24\nweeks = 15\n" +
        "last_day_of_instruction = 2026-12-11\n" +
        "finals_start = 2026-12-14\nfinals_end = 2026-12-18\n\n" +
        '[term.policy.project]\ndue = "tue 23:59"\n',
    );
    return new Publisher(repo, "42", null).dateFields("assignment", dates(unlock));
  }

  it("sends an empty string when there is no unlock", () => {
    expect(fields(null)["assignment[unlock_at]"]).toBe("");
  });

  it("sends an unlock as an ISO timestamp, as Python's isoformat writes it", () => {
    const when = DateTime.fromObject({ year: 2026, month: 8, day: 31 }, { zone: "UTC" });
    const sent = fields(when);
    expect(sent["assignment[unlock_at]"]).toBe("2026-08-31T00:00:00+00:00");
    expect(sent["assignment[due_at]"]).toBe("2026-09-01T23:59:00+00:00");
    expect(sent["assignment[lock_at]"]).toBe("2026-09-03T23:59:00+00:00");
  });
});

describe("visibility on update", () => {
  // --publish means "make it visible". Its absence must not mean "hide it":
  // pushing a correction cannot pull a live assignment out from under a class.
  function publisher(publish: boolean): Publisher {
    const repo = tmp();
    write(
      repo,
      "canvas.toml",
      "[term]\n" +
        'timezone = "America/Boise"\n' +
        "first_monday = 2026-08-24\nweeks = 15\n" +
        "last_day_of_instruction = 2026-12-11\n" +
        "finals_start = 2026-12-14\nfinals_end = 2026-12-18\n\n" +
        '[term.policy.project]\ndue = "tue 23:59"\n',
    );
    return new Publisher(repo, "42", fakeCanvas(), { publish });
  }

  it("gives a new object the flag", () => {
    expect(publisher(false).visibility(false)).toBe(false);
    expect(publisher(true).visibility(false)).toBe(true);
  });

  it("says nothing on an update without publish", () => {
    expect(publisher(false).visibility(true)).toBeNull();
  });

  it("still publishes on an update with publish", () => {
    expect(publisher(true).visibility(true)).toBe(true);
  });
});

const GROUP_TOML =
  "[term]\n" +
  'timezone = "America/Boise"\n' +
  "first_monday = 2026-08-24\nweeks = 15\n" +
  "last_day_of_instruction = 2026-12-11\n" +
  "finals_start = 2026-12-14\nfinals_end = 2026-12-18\ntotal_points = 0\n\n" +
  '[term.policy.project]\ndue = "tue 23:59"\n\n' +
  '[term.policy.lab]\ndue = "wed 23:59"\n\n' +
  '[layout]\nsyllabus = "index.md"\npages = []\nfiles = []\n\n' +
  '[layout.gradable]\nproject = "assignments/p[0-9]*.md"\n' +
  'lab = "activities/a[0-9]*.md"\n';

const GROUPS =
  '\n[[group]]\nname = "Exams"\nweight = 50\n\n' +
  '[[group]]\nname = "In Class"\nweight = 40\nkinds = ["lab"]\n\n' +
  '[[group]]\nname = "Projects"\nweight = 10\nkinds = ["project"]\n';

function groupPublisher(canvas: Fake, groups = "", options: PublisherOptions = {}): Publisher {
  const repo = tmp();
  mkdirSync(path.join(repo, "assignments"));
  mkdirSync(path.join(repo, "activities"));
  write(repo, "index.md", "# S\n");
  write(repo, "canvas.toml", GROUP_TOML + groups);
  return new Publisher(repo, "42", canvas, options);
}

function groupCanvas(existing: Payload[] = []): Fake {
  const canvas = fakeCanvas();
  canvas.listAssignmentGroups.mockResolvedValue(existing);
  canvas.createAssignmentGroup.mockResolvedValue({ id: "7" });
  return canvas;
}

describe("assignment group sync", () => {
  // [[group]] has to reach Canvas before anything is filed into a group.

  it("touches nothing in a repo with no groups", async () => {
    const canvas = groupCanvas();
    const result = await groupPublisher(canvas).syncGroups();
    expect(canvas.listAssignmentGroups).not.toHaveBeenCalled();
    expect(canvas.setGroupWeighting).not.toHaveBeenCalled();
    expect([result.created, result.updated, result.skipped]).toEqual([0, 0, 0]);
  });

  it("creates missing groups in declaration order", async () => {
    const canvas = groupCanvas();
    const result = await groupPublisher(canvas, GROUPS).syncGroups();
    const sent = canvas.createAssignmentGroup.mock.calls.map((call) => call[1]);
    expect(canvas.createAssignmentGroup.mock.calls.every((call) => call[0] === "42")).toBe(true);
    expect(sent.map((f) => f.name)).toEqual(["Exams", "In Class", "Projects"]);
    expect(sent.map((f) => f.position)).toEqual(["1", "2", "3"]);
    expect(sent.map((f) => f.group_weight)).toEqual(["50", "40", "10"]);
    expect(result.created).toBe(3);
  });

  it("turns weighting on when weights are declared, after the groups exist", async () => {
    const canvas = groupCanvas();
    await groupPublisher(canvas, GROUPS).syncGroups();
    expect(canvas.setGroupWeighting).toHaveBeenCalledTimes(1);
    expect(canvas.setGroupWeighting).toHaveBeenCalledWith("42", true);
    expect(callOrder(canvas).map(([method]) => method)).toEqual([
      "listAssignmentGroups",
      "createAssignmentGroup",
      "createAssignmentGroup",
      "createAssignmentGroup",
      "setGroupWeighting",
    ]);
  });

  it("leaves the course setting alone for a group with no weight", async () => {
    const canvas = groupCanvas();
    await groupPublisher(canvas, '\n[[group]]\nname = "Projects"\nkinds = ["project"]\n').syncGroups();
    expect(canvas.createAssignmentGroup.mock.lastCall?.[1]).not.toHaveProperty("group_weight");
    expect(canvas.setGroupWeighting).not.toHaveBeenCalled();
  });

  it("leaves an existing group that matches alone", async () => {
    const canvas = groupCanvas([
      { id: 1, name: "Exams", group_weight: 50, position: 1 },
      { id: 2, name: "In Class", group_weight: 40, position: 2 },
      { id: 3, name: "Projects", group_weight: 10, position: 3 },
    ]);
    const result = await groupPublisher(canvas, GROUPS).syncGroups();
    expect(canvas.createAssignmentGroup).not.toHaveBeenCalled();
    expect(canvas.updateAssignmentGroup).not.toHaveBeenCalled();
    expect(result.skipped).toBe(3);
  });

  it("pushes a changed weight", async () => {
    const canvas = groupCanvas([
      { id: 1, name: "Exams", group_weight: 50, position: 1 },
      { id: 2, name: "In Class", group_weight: 25, position: 2 },
      { id: 3, name: "Projects", group_weight: 10, position: 3 },
    ]);
    const result = await groupPublisher(canvas, GROUPS).syncGroups();
    expect(result.updated).toBe(1);
    const call = canvas.updateAssignmentGroup.mock.lastCall;
    expect(call?.[1]).toBe("2");
    expect(call?.[2].group_weight).toBe("40");
  });

  it("never writes an undeclared weight", async () => {
    // A group whose weight is managed by hand keeps whatever Canvas holds,
    // even when the group has to be repositioned.
    const canvas = groupCanvas([{ id: 4, name: "Extra Credit", group_weight: 2.5, position: 9 }]);
    const result = await groupPublisher(canvas, '\n[[group]]\nname = "Extra Credit"\n').syncGroups();
    expect(result.updated).toBe(1);
    expect(canvas.updateAssignmentGroup.mock.lastCall?.[2]).not.toHaveProperty("group_weight");
  });

  it("writes once when synced twice", async () => {
    const canvas = groupCanvas();
    const publisher = groupPublisher(canvas, GROUPS);
    await publisher.syncGroups();
    await publisher.syncGroups();
    expect(canvas.createAssignmentGroup).toHaveBeenCalledTimes(3);
  });

  it("writes nothing on a dry run", async () => {
    const canvas = groupCanvas();
    const reported: string[] = [];
    const publisher = groupPublisher(canvas, GROUPS, {
      dryRun: true,
      report: (message) => reported.push(message),
    });
    const result = await publisher.syncGroups();
    expect(canvas.listAssignmentGroups).not.toHaveBeenCalled();
    expect(result.skipped).toBe(3);
    expect(reported[1]).toBe("[dim]group In Class (40%) <- lab[/dim]");
  });
});

describe("assignment group placement", () => {
  // Every gradable object has to name the group it belongs in.
  function plan(repo: string, name: string, kind: string, body: string): Plan {
    const source = write(repo, name, body);
    return new Plan({ key: name, kind, title: "", source, points: 20, itemKind: null });
  }

  it("files an assignment into its kind's group", async () => {
    const canvas = fakeCanvas();
    canvas.listAssignmentGroups.mockResolvedValue([{ id: 5, name: "Projects", group_weight: 10, position: 3 }]);
    canvas.createAssignmentGroup.mockResolvedValue({ id: 9 });
    canvas.createAssignment.mockResolvedValue({ id: "77" });
    const publisher = groupPublisher(canvas, GROUPS);

    const item = plan(publisher.repo, "assignments/p0.md", "assignment", "# P0\n\n**Week 2 · 50 points**\n");
    item.itemKind = "project";
    await publisher.createOrUpdate(item);

    const fields = asRecord(canvas.createAssignment.mock.lastCall?.[1]);
    expect(fields["assignment[assignment_group_id]"]).toBe("5");
    // The groups are synced before the assignment that is filed into one.
    const order = callOrder(canvas).map(([method]) => method);
    expect(order.indexOf("setGroupWeighting")).toBeLessThan(order.indexOf("createAssignment"));
  });

  it("sends no group field for a kind in no group", async () => {
    const canvas = fakeCanvas();
    canvas.createAssignmentGroup.mockResolvedValue({ id: 9 });
    canvas.createAssignment.mockResolvedValue({ id: "77" });
    const publisher = groupPublisher(canvas, GROUPS);

    const item = plan(publisher.repo, "assignments/p0.md", "assignment", "# P0\n\n**Week 2 · 50 points**\n");
    item.itemKind = "exam";
    await publisher.createOrUpdate(item);

    const fields = asRecord(canvas.createAssignment.mock.lastCall?.[1]);
    expect(fields).not.toHaveProperty("assignment[assignment_group_id]");
  });

  it("records the repo kind when planning", () => {
    const publisher = groupPublisher(fakeCanvas(), GROUPS);
    write(publisher.repo, "assignments/p0.md", "# P0\n\n**Week 2 · 50 points**\n");
    write(publisher.repo, "activities/a1.md", "# A1\n\n**Week 1 · 20 points**\n");
    const kinds = Object.fromEntries(publisher.plan().map((p) => [p.key, p.itemKind]));
    expect(kinds["assignments/p0.md"]).toBe("project");
    expect(kinds["activities/a1.md"]).toBe("lab");
  });
});

describe("drafts are not pushed", () => {
  // A draft is invisible to the whole push: plan, modules and manifest.
  function publisher(draftP1 = true): Publisher {
    const repo = tmp();
    write(repo, "index.md", "# S\n");
    write(repo, "notes.md", "---\ndraft: true\n---\n\n# Notes\n");
    write(repo, "assignments/p0.md", "# P0\n\n**Week 2 · 50 points · x**\n");
    const head = draftP1 ? "---\ndraft: true\n---\n\n" : "";
    write(repo, "assignments/p1.md", `${head}# P1\n\n**Week 4 · 100 points · x**\n`);
    write(
      repo,
      "canvas.toml",
      `${TERM}[layout]\nsyllabus = "index.md"\npages = ["notes.md"]\nfiles = []\n\n` +
        '[layout.gradable]\nproject = "assignments/p[0-9]*.md"\n',
    );
    return new Publisher(repo, "42", fakeCanvas());
  }

  it("does not plan a draft assignment", () => {
    const keys = new Set(publisher().plan().map((p) => p.key));
    expect(keys.has("assignments/p0.md")).toBe(true);
    expect(keys.has("assignments/p1.md")).toBe(false);
  });

  it("does not plan a draft page", () => {
    expect(
      publisher()
        .plan()
        .map((p) => p.key),
    ).not.toContain("notes.md");
  });

  it("records what the plan held back", () => {
    const pub = publisher();
    pub.plan();
    expect(pub.drafts).toEqual(new Set(["notes.md", "assignments/p1.md"]));
  });

  it("brings a file back when the flag is cleared", () => {
    expect(
      publisher(false)
        .plan()
        .map((p) => p.key),
    ).toContain("assignments/p1.md");
  });

  it("answers isDraftKey before plan runs", () => {
    // pushModules() asks about keys that plan() may never have reached.
    const pub = publisher();
    expect(pub.isDraftKey("assignments/p1.md")).toBe(true);
    expect(pub.isDraftKey("assignments/p0.md")).toBe(false);
  });

  it("answers isDraftKey on a path with no file", () => {
    expect(publisher().isDraftKey("assignments/gone.md")).toBe(false);
  });

  it("forgets a newly drafted object when pruning", () => {
    const pub = publisher();
    pub.manifest.put("assignments/p1.md", new Entry({ kind: "assignment", canvasId: "7", title: "P1" }));
    pub.manifest.put("assignments/p0.md", new Entry({ kind: "assignment", canvasId: "8", title: "P0" }));
    expect(pub.pruneDrafts()).toEqual(["assignments/p1.md"]);
    expect(pub.manifest.get("assignments/p1.md")).toBeNull();
    expect(pub.manifest.get("assignments/p0.md")).not.toBeNull();
  });

  it("prunes nothing when nothing is a draft", () => {
    const pub = publisher(false);
    pub.manifest.put("assignments/p1.md", new Entry({ kind: "assignment", canvasId: "7", title: "P1" }));
    expect(pub.pruneDrafts()).toEqual([]);
  });
});

describe("drafts leave their module", () => {
  // A module lists a draft's path; the module is built without it.
  function publisher(): [Publisher, Fake] {
    const repo = tmp();
    write(repo, "index.md", "# S\n");
    write(repo, "week1.md", "# Week 1\n");
    write(repo, "assignments/p0.md", "# P0\n\n**Week 2 · 50 points · x**\n");
    write(repo, "assignments/p1.md", "---\ndraft: true\n---\n\n# P1\n\n**Week 4 · 100 points · x**\n");
    write(
      repo,
      "canvas.toml",
      `${TERM}[layout]\nsyllabus = "index.md"\npages = ["week1.md"]\nfiles = []\n\n` +
        '[layout.gradable]\nproject = "assignments/p[0-9]*.md"\n\n' +
        "[[module]]\n" +
        'title = "Week 1"\n' +
        'page = "week1.md"\n' +
        'items = ["assignments/p0.md", "assignments/p1.md"]\n',
    );
    const canvas = fakeCanvas();
    const pub = new Publisher(repo, "42", canvas);
    pub.manifest.put("week1.md", new Entry({ kind: "page", canvasId: "week-1", pageUrl: "week-1", title: "Week 1" }));
    pub.manifest.put("assignments/p0.md", new Entry({ kind: "assignment", canvasId: "7", title: "P0" }));
    return [pub, canvas];
  }

  it("does not add the draft as a module item", async () => {
    const [pub, canvas] = publisher();
    await pub.pushModules();
    const sent = canvas.createModuleItem.mock.calls.map((call) => call[2]);
    expect(canvas.createModuleItem.mock.calls.every((call) => call[0] === "42" && call[1] === "9")).toBe(true);
    expect(sent.map((f) => f["module_item[title]"])).toEqual(["Week 1", "P0"]);
    expect(sent[0]?.["module_item[page_url]"]).toBe("week-1");
    expect(sent[1]?.["module_item[content_id]"]).toBe("7");
  });

  it("does not report a draft as unpublished", async () => {
    // Before drafts existed this was the failure: a file with no manifest
    // entry looked like something the push had missed.
    const [pub] = publisher();
    expect((await pub.pushModules()).errors).toEqual([]);
  });

  it("still reports a genuinely missing object", async () => {
    const [pub] = publisher();
    pub.manifest.drop("assignments/p0.md");
    const errors = (await pub.pushModules()).errors;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBe("module 'Week 1': assignments/p0.md has not been published");
  });

  it("clears the old items before adding the new ones", async () => {
    const [pub, canvas] = publisher();
    canvas.listModuleItems.mockResolvedValue([{ id: 31 }, { id: 32 }]);
    await pub.pushModules();
    expect(callOrder(canvas).map(([method, args]) => [method, ...args.slice(0, 3)].slice(0, 4))).toEqual([
      ["listModules", "42"],
      ["createModule", "42", "Week 1", 1],
      ["listModuleItems", "42", "9"],
      ["deleteModuleItem", "42", "9", "31"],
      ["deleteModuleItem", "42", "9", "32"],
      ["createModuleItem", "42", "9", expect.objectContaining({ "module_item[position]": "1" })],
      ["createModuleItem", "42", "9", expect.objectContaining({ "module_item[position]": "2" })],
    ]);
    // Without --publish the new module stays hidden and is never published after.
    expect(canvas.createModule.mock.lastCall?.[3]).toBe(false);
    expect(canvas.updateModule).not.toHaveBeenCalled();
  });
});

describe("native module items", () => {
  // A [[module]] names Canvas-native objects under `canvas`; the rebuild keeps them.
  function publisher(canvasLine: string): [Publisher, Fake] {
    const repo = tmp();
    write(repo, "index.md", "# S\n");
    write(repo, "review.md", "# Midterm Review\n");
    write(
      repo,
      "canvas.toml",
      `${TERM}[layout]\nsyllabus = "index.md"\npages = ["review.md"]\nfiles = []\n\n` +
        "[[module]]\n" +
        'title = "Week 8"\n' +
        'page = "review.md"\n' +
        `${canvasLine}\n`,
    );
    const canvas = fakeCanvas();
    const pub = new Publisher(repo, "42", canvas);
    pub.manifest.put(
      "review.md",
      new Entry({ kind: "page", canvasId: "midterm-review", pageUrl: "midterm-review", title: "Midterm Review" }),
    );
    return [pub, canvas];
  }

  it("puts native items after the repo items, in order", async () => {
    const [pub, canvas] = publisher('canvas = [{ quiz = 394147 }, { quiz = 393662, title = "Midterm" }, { file = 5 }]');
    expect((await pub.pushModules()).errors).toEqual([]);
    const sent = canvas.createModuleItem.mock.calls.map((call) => call[2]);
    expect(sent.map((f) => f["module_item[type]"])).toEqual(["Page", "Quiz", "Quiz", "File"]);
    expect(sent.map((f) => f["module_item[position]"])).toEqual(["1", "2", "3", "4"]);
    expect(sent[1]?.["module_item[content_id]"]).toBe("394147");
    // Canvas uses the quiz's own title when none is sent.
    expect(sent[1]).not.toHaveProperty("module_item[title]");
    expect(sent[2]?.["module_item[title]"]).toBe("Midterm");
    expect(sent[0]?.["module_item[page_url]"]).toBe("midterm-review");
  });

  it("reports a malformed canvas list as an error, not a hole", async () => {
    const [pub, canvas] = publisher("canvas = [{ quiz = 1, page = 'x' }]");
    const errors = (await pub.pushModules()).errors;
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Week 8");
    expect(errors[0]).toContain("exactly one of");
    // The repo items still went in.
    expect(canvas.createModuleItem.mock.calls.map((call) => call[2]["module_item[type]"])).toEqual(["Page"]);
  });
});

describe("unlisted gradables", () => {
  // A gradable file that no [[module]] lists is named, so it does not stay invisible.
  function publisher(modules: string): Publisher {
    const repo = tmp();
    mkdirSync(path.join(repo, "exams"));
    write(repo, "index.md", "# S\n");
    write(repo, "week1.md", "# Week 1\n");
    write(repo, "assignments/p0.md", "# P0\n\n**Week 2 · 50 points · x**\n");
    write(repo, "assignments/p1.md", "# P1\n\n**Week 4 · 100 points · x**\n");
    write(repo, "assignments/p2.md", "---\ndraft: true\n---\n\n# P2\n\n**Week 6 · 100 points · x**\n");
    write(repo, "exams/midterm.md", "# Midterm\n\n**Week 8 · 100 points · x**\n");
    write(
      repo,
      "canvas.toml",
      `${TERM}[term.policy.exam]\ndue = "tue 23:59"\n\n` +
        '[layout]\nsyllabus = "index.md"\npages = ["week1.md"]\nfiles = []\n\n' +
        '[layout.gradable]\nproject = "assignments/p[0-9]*.md"\nexam = "exams/*.md"\n\n' +
        modules,
    );
    return new Publisher(repo, "42", fakeCanvas());
  }

  it("names an item in no module", () => {
    const pub = publisher('[[module]]\ntitle = "Week 1"\npage = "week1.md"\nitems = ["assignments/p0.md"]\n');
    expect(pub.unlisted(pub.plan())).toEqual(["assignments/p1.md", "exams/midterm.md"]);
  });

  it("is quiet when everything is listed", () => {
    const pub = publisher(
      '[[module]]\ntitle = "Week 1"\npage = "week1.md"\nitems = ["assignments/p0.md"]\n\n' +
        '[[module]]\ntitle = "Week 2"\nitems = ["assignments/p1.md", "exams/midterm.md"]\n',
    );
    expect(pub.unlisted(pub.plan())).toEqual([]);
  });

  it("does not call a draft an orphan", () => {
    // p2.md is a draft and listed nowhere; it is not a Canvas object, so it
    // cannot be missing from a module.
    const pub = publisher(
      '[[module]]\ntitle = "Week 1"\nitems = ["assignments/p0.md", "assignments/p1.md", "exams/midterm.md"]\n',
    );
    expect(pub.unlisted(pub.plan())).toEqual([]);
  });

  it("does not report a plain page, which is not gradable", () => {
    // week1.md is a page with no week header; only gradable items are checked.
    const pub = publisher(
      '[[module]]\ntitle = "Week 1"\nitems = ["assignments/p0.md", "assignments/p1.md", "exams/midterm.md"]\n',
    );
    expect(pub.unlisted(pub.plan())).not.toContain("week1.md");
  });

  it("gives no warning to a repo with no modules", () => {
    const pub = publisher("");
    expect(pub.unlisted(pub.plan())).toEqual([]);
  });

  it("considers only the plans given", () => {
    // A --path push hands in just the files it pushed.
    const pub = publisher('[[module]]\ntitle = "Week 1"\nitems = ["assignments/p0.md"]\n');
    const chosen = pub.plan().filter((p) => p.key === "assignments/p0.md");
    expect(pub.unlisted(chosen)).toEqual([]);
  });
});

describe("assignment options", () => {
  it("repeats submission types and sends grading on the push", async () => {
    const repo = tmp();
    write(repo, "index.md", "# S\n");
    write(
      repo,
      "canvas.toml",
      "[term]\n" +
        'timezone = "America/Boise"\n' +
        "first_monday = 2026-08-24\nweeks = 15\n" +
        "last_day_of_instruction = 2026-12-11\n" +
        "finals_start = 2026-12-14\nfinals_end = 2026-12-18\ntotal_points = 0\n\n" +
        '[term.policy.extra]\ndue = "fri 23:59"\n\n' +
        '[layout]\nsyllabus = "index.md"\npages = []\nfiles = []\n\n' +
        '[layout.gradable]\nextra = "ec-*.md"\n',
    );
    const source = write(
      repo,
      "ec-typos.md",
      "---\nsubmission: online_upload, online_text_entry\ngrading: pass_fail\n---\n\n" +
        "# Typos\n\n**Week 16 · 10 points · extra credit**\n",
    );
    const canvas = fakeCanvas();
    canvas.createAssignment.mockResolvedValue({ id: "77" });
    const publisher = new Publisher(repo, "42", canvas);
    const item = new Plan({ key: "ec-typos.md", kind: "assignment", title: "", source, points: 10, itemKind: "extra" });
    await publisher.createOrUpdate(item);

    const sent = canvas.createAssignment.mock.lastCall?.[1];
    expect(Array.isArray(sent)).toBe(true);
    const pairs = sent as Array<[string, string]>; // checked to be the pair form just above
    expect(pairs.filter(([k]) => k === "assignment[submission_types][]").map(([, v]) => v)).toEqual([
      "online_upload",
      "online_text_entry",
    ]);
    expect(pairs).toContainEqual(["assignment[grading_type]", "pass_fail"]);
    expect(pairs).toContainEqual(["assignment[points_possible]", "10"]);
    // Created unpublished without --publish.
    expect(pairs).toContainEqual(["assignment[published]", "false"]);
    expect(publisher.manifest.get("ec-typos.md")?.canvasId).toBe("77");
  });
});

describe("icon files are planned", () => {
  function publisher(icons: string): Publisher {
    const repo = tmp();
    write(repo, "icons/list.svg", "<svg/>");
    write(repo, "index.md", "# S\n");
    write(repo, "canvas.toml", `${TERM}[layout]\nsyllabus = "index.md"\npages = []\nfiles = []\n\n${icons}`);
    return new Publisher(repo, "42", fakeCanvas());
  }

  it("uploads an icon without a layout entry", () => {
    const pub = publisher('[icons]\n"Learning Objectives" = "icons/list.svg"\n');
    expect(pub.plan().filter((p) => p.kind === "file").map((p) => p.key)).toEqual(["icons/list.svg"]);
    expect(pub.config.icons[0]?.pattern).toBe("learning objectives");
  });

  it("uploads an icon shared by two patterns once", () => {
    const pub = publisher('[icons]\n"a" = "icons/list.svg"\n"b" = "icons/list.svg"\n');
    expect(pub.plan().filter((p) => p.kind === "file").map((p) => p.key)).toEqual(["icons/list.svg"]);
  });

  it("treats a missing icon as a config error", () => {
    expect(() => publisher('[icons]\n"x" = "icons/gone.svg"\n')).toThrow(DateConfigError);
    expect(() => publisher('[icons]\n"x" = "icons/gone.svg"\n')).toThrow(/does not exist/);
  });

  it("inserts the icon when rendering", () => {
    const pub = publisher('[icons]\n"learning objectives" = "icons/list.svg"\n');
    const page = write(pub.repo, "page.md", "# Page\n\n## Learning Objectives\n\nText.\n");
    const [, html] = pub.render(page);
    expect(html).toContain('<img class="cs-icon" src="icons/list.svg"');
  });

  it("uploads the icon into a folder named for its directory", async () => {
    const pub = publisher('[icons]\n"a" = "icons/list.svg"\n');
    const canvas = pub.canvas as Fake; // built by fakeCanvas() above
    canvas.uploadFile.mockResolvedValue({ id: 12, size: 6 });
    const plan = planFor(pub, "icons/list.svg");
    expect((await pub.createOrUpdate(plan)).created).toBe(1);
    expect(canvas.uploadFile).toHaveBeenCalledWith("42", path.join(pub.repo, "icons/list.svg"), "course files/icons");
    expect(pub.manifest.get("icons/list.svg")?.extra).toEqual({ size: "6" });
  });
});

describe("module headers and dates", () => {
  // The outline test that lives here in the Python needs outline.ts and is
  // ported with it.
  function publisher(stored: Payload[]): [Publisher, Fake] {
    const repo = tmp();
    write(repo, "index.md", "# S\n");
    write(repo, "o.md", "# Module 1 Overview\n");
    write(
      repo,
      "canvas.toml",
      `${TERM}[layout]\nsyllabus = "index.md"\npages = ["o.md"]\nfiles = []\n\n` +
        '[[module]]\ntitle = "Module 1: Intro"\nweek = 1\npage = "o.md"\n' +
        'items = [{ header = "Due by Sunday at 11:59 p.m." }]\n',
    );
    const canvas = fakeCanvas();
    canvas.listModules.mockResolvedValue(stored);
    const pub = new Publisher(repo, "42", canvas);
    pub.manifest.put("o.md", new Entry({ kind: "page", canvasId: "o", pageUrl: "o", title: "Module 1 Overview" }));
    return [pub, canvas];
  }

  it("makes a header a SubHeader item", async () => {
    const [pub, canvas] = publisher([]);
    expect((await pub.pushModules()).errors).toEqual([]);
    const sent = canvas.createModuleItem.mock.calls.map((call) => call[2]);
    expect(sent.map((f) => f["module_item[type]"])).toEqual(["Page", "SubHeader"]);
    expect(sent[1]?.["module_item[title]"]).toBe("Due by Sunday at 11:59 p.m.");
    expect(sent[1]).not.toHaveProperty("module_item[content_id]");
  });

  it("names a new module with its dates", async () => {
    const [pub, canvas] = publisher([]);
    await pub.pushModules();
    expect(canvas.createModule.mock.lastCall?.[1]).toBe("Module 1: Intro (August 24 - August 30)");
  });

  it("renames last term's module rather than duplicating it", async () => {
    const [pub, canvas] = publisher([
      { id: "5", name: "Module 1: Intro (January 11 - January 17)", published: false },
    ]);
    await pub.pushModules();
    expect(canvas.createModule).not.toHaveBeenCalled();
    const fields = canvas.updateModule.mock.calls[0]?.[2];
    expect(fields?.["module[name]"]).toBe("Module 1: Intro (August 24 - August 30)");
    expect(fields?.["module[position]"]).toBe("1");
  });

  it("adopts the undated title too", async () => {
    const [pub, canvas] = publisher([{ id: "5", name: "Module 1: Intro", published: false }]);
    await pub.pushModules();
    expect(canvas.createModule).not.toHaveBeenCalled();
    expect(canvas.updateModule.mock.calls[0]?.[1]).toBe("5");
  });

  it("skips a published module without update published", async () => {
    const [pub, canvas] = publisher([{ id: "5", name: "Module 1: Intro", published: true }]);
    const result = await pub.pushModules();
    expect(result.skipped).toBe(1);
    expect(callOrder(canvas).map(([method]) => method)).toEqual(["listModules"]);
  });
});

describe("a retitled page keeps its new slug", () => {
  it("takes the slug Canvas returns into the manifest", async () => {
    // Canvas re-slugs a retitled page; a module item needs the new slug.
    const repo = tmp();
    write(repo, "index.md", "# S\n");
    write(repo, "guide.md", "# 9.02 Midterm Exam Guide\n\nText.\n");
    write(repo, "canvas.toml", `${TERM}[layout]\nsyllabus = "index.md"\npages = ["guide.md"]\nfiles = []\n`);
    const canvas = fakeCanvas();
    canvas.exists.mockResolvedValue(true);
    canvas.getJson.mockResolvedValue({ published: false });
    canvas.updatePage.mockResolvedValue({ url: "9-dot-02-midterm-exam-guide" });
    const publisher = new Publisher(repo, "42", canvas);
    publisher.manifest.put(
      "guide.md",
      new Entry({
        kind: "page",
        canvasId: "midterm-exam-guide",
        pageUrl: "midterm-exam-guide",
        title: "Midterm Exam Guide",
      }),
    );
    await publisher.createOrUpdate(planFor(publisher, "guide.md"));
    expect(publisher.manifest.get("guide.md")?.pageUrl).toBe("9-dot-02-midterm-exam-guide");
    const call = canvas.updatePage.mock.lastCall;
    expect(call?.[1]).toBe("midterm-exam-guide");
    expect(call?.[2]?.title).toBe("9.02 Midterm Exam Guide");
    // An update without --publish says nothing about visibility.
    expect(call?.[2]).not.toHaveProperty("published");
  });
});

describe("never publish", () => {
  // A [[module]] with never_publish = true stays unpublished, whatever the flags.
  function publisher(publish: boolean, storedModules: Payload[]): [Publisher, Fake] {
    const repo = tmp();
    write(repo, "index.md", "# S\n");
    write(repo, "guide.md", "# Instructor Guide\n\nText.\n");
    write(
      repo,
      "canvas.toml",
      `${TERM}[layout]\nsyllabus = "index.md"\npages = ["guide.md"]\nfiles = []\n\n` +
        '[[module]]\ntitle = "Instructor Resources"\nnever_publish = true\n' +
        'items = ["guide.md"]\n',
    );
    const canvas = fakeCanvas();
    canvas.listModules.mockResolvedValue(storedModules);
    canvas.createPage.mockResolvedValue({ url: "instructor-guide" });
    canvas.updatePage.mockResolvedValue({ url: "instructor-guide" });
    return [new Publisher(repo, "42", canvas, { publish }), canvas];
  }

  const guide = () => new Entry({ kind: "page", canvasId: "g", pageUrl: "g", title: "Instructor Guide" });

  it("creates a page unpublished even with publish", async () => {
    const [pub, canvas] = publisher(true, []);
    await pub.createOrUpdate(planFor(pub, "guide.md"));
    expect(canvas.createPage.mock.lastCall?.[3]).toBe(false);
  });

  it("pulls a published page back rather than protecting it", async () => {
    const [pub, canvas] = publisher(false, []);
    pub.manifest.put("guide.md", guide());
    canvas.exists.mockResolvedValue(true);
    canvas.getJson.mockResolvedValue({ published: true });
    await pub.createOrUpdate(planFor(pub, "guide.md"));
    expect(pub.protected.has("guide.md")).toBe(false);
    expect(canvas.updatePage.mock.lastCall?.[2]?.published).toBe(false);
  });

  it("unpublishes and locks the module", async () => {
    const [pub, canvas] = publisher(true, [{ id: "5", name: "Instructor Resources", published: true }]);
    pub.manifest.put("guide.md", guide());
    expect((await pub.pushModules()).skipped).toBe(0);
    const fields = canvas.updateModule.mock.calls[0]?.[2];
    expect(fields?.["module[published]"]).toBe("false");
    expect(fields?.["module[unlock_at]"]).toMatch(/^2099/);
    // --publish never republishes it afterwards.
    expect(canvas.updateModule.mock.calls.every((call) => call[2]["module[published]"] !== "true")).toBe(true);
  });

  it("creates a new module unpublished, then locks it", async () => {
    const [pub, canvas] = publisher(true, []);
    pub.manifest.put("guide.md", guide());
    await pub.pushModules();
    expect(canvas.createModule.mock.lastCall?.[3]).toBe(false);
    expect(canvas.updateModule.mock.calls.map((call) => call[2])).toEqual([
      { "module[published]": "false", "module[unlock_at]": "2099-12-31T23:59:00Z" },
    ]);
  });
});

describe("always publish", () => {
  function publisher(both = false): [Publisher, Fake] {
    const repo = tmp();
    write(repo, "index.md", "# S\n");
    write(repo, "tech.md", "# Technology Support\n\nText.\n");
    const hidden = both ? '\n[[module]]\ntitle = "Hidden"\nnever_publish = true\nitems = ["tech.md"]\n' : "";
    write(
      repo,
      "canvas.toml",
      `${TERM}[layout]\nsyllabus = "index.md"\npages = ["tech.md"]\nfiles = []\n\n` +
        '[[module]]\ntitle = "Course Resources"\npublish = true\nitems = ["tech.md"]\n' +
        hidden,
    );
    const canvas = fakeCanvas();
    canvas.createPage.mockResolvedValue({ url: "technology-support" });
    return [new Publisher(repo, "42", canvas, { publish: false }), canvas];
  }

  it("publishes a page without the flag", async () => {
    const [pub, canvas] = publisher();
    await pub.createOrUpdate(planFor(pub, "tech.md"));
    expect(canvas.createPage.mock.lastCall?.[3]).toBe(true);
  });

  it("publishes the module without the flag", async () => {
    const [pub, canvas] = publisher();
    pub.manifest.put("tech.md", new Entry({ kind: "page", canvasId: "t", pageUrl: "t", title: "Technology Support" }));
    await pub.pushModules();
    expect(canvas.createModule.mock.lastCall?.[3]).toBe(true);
  });

  it("lets never publish win", async () => {
    const [pub, canvas] = publisher(true);
    await pub.createOrUpdate(planFor(pub, "tech.md"));
    expect(canvas.createPage.mock.lastCall?.[3]).toBe(false);
  });
});

describe("ungraded discussions", () => {
  function publisher(): [Publisher, Fake] {
    const repo = tmp();
    write(repo, "index.md", "# S\n");
    write(repo, "shared/questions.md", "# Course Questions\n\nAsk here.\n");
    write(repo, "shared/tech.md", "# Technology Support\n");
    write(
      repo,
      "canvas.toml",
      `${TERM}[layout]\nsyllabus = "index.md"\npages = ["shared/*.md"]\nfiles = []\n` +
        'discussions = ["shared/questions.md"]\n',
    );
    const canvas = fakeCanvas();
    canvas.createDiscussion.mockResolvedValue({ id: "77", assignment_id: null });
    return [new Publisher(repo, "42", canvas), canvas];
  }

  it("is planned as a discussion, not a page", () => {
    const [pub] = publisher();
    const kinds = Object.fromEntries(pub.plan().map((p) => [p.key, p.kind]));
    expect(kinds["shared/questions.md"]).toBe("discussion");
    expect(kinds["shared/tech.md"]).toBe("page");
  });

  it("sends no assignment fields", async () => {
    const [pub, canvas] = publisher();
    await pub.createOrUpdate(planFor(pub, "shared/questions.md"));
    const fields = canvas.createDiscussion.mock.lastCall?.[1] ?? {};
    expect(fields.title).toBe("Course Questions");
    expect(fields.published).toBe("false");
    expect(Object.keys(fields).some((key) => key.startsWith("assignment["))).toBe(false);
    // A null assignment_id is recorded as no id, so no rubric is ever bound to it.
    expect(pub.manifest.get("shared/questions.md")?.extra).toEqual({ assignment_id: "" });
  });
});

describe("quiz questions are rebuilt unpublished", () => {
  // Not in the Python suite: the order of the quiz writes is the whole fix, so
  // it is pinned here.
  it("writes unpublished, replaces the questions, then republishes a live quiz", async () => {
    const repo = tmp();
    write(repo, "index.md", "# S\n");
    write(
      repo,
      "canvas.toml",
      `${TERM}[term.policy.quiz]\ndue = "sun 23:59"\n\n` +
        '[layout]\nsyllabus = "index.md"\npages = []\nfiles = []\n\n' +
        '[layout.gradable]\nquiz = "quizzes/quiz-*.md"\n',
    );
    write(
      repo,
      "quizzes/quiz-01.md",
      "# Quiz 1\n\n**Week 2 · 10 points · x**\n\n" +
        "**Q1.** A single-answer question.\n\n- A. wrong\n- B. right\n\n*Answer:* **B**, because.\n",
    );
    const canvas = fakeCanvas();
    canvas.exists.mockResolvedValue(true);
    // Live, but --update-published lets the push through.
    canvas.getJson.mockResolvedValue({ published: true });
    canvas.listQuizQuestions.mockResolvedValue([{ id: 501 }]);
    const pub = new Publisher(repo, "42", canvas, { updatePublished: true });
    pub.manifest.put("quizzes/quiz-01.md", new Entry({ kind: "quiz", canvasId: "300", title: "Quiz 1" }));

    await pub.createOrUpdate(planFor(pub, "quizzes/quiz-01.md"));

    const writes = callOrder(canvas).filter(([method]) => method !== "exists" && method !== "getJson");
    expect(writes.map(([method]) => method)).toEqual([
      "updateQuiz",
      "listQuizQuestions",
      "deleteQuizQuestion",
      "createQuizQuestion",
      "updateQuiz",
    ]);
    const first = asRecord(writes[0]?.[1][2]);
    expect(first["quiz[published]"]).toBe("false");
    expect(first["quiz[quiz_type]"]).toBe("assignment");
    expect(first["quiz[due_at]"]).toBe("2026-09-06T23:59:00-06:00");
    expect(writes[2]?.[1]).toEqual(["42", "300", "501"]);
    expect(writes[4]?.[1]).toEqual(["42", "300", { "quiz[published]": "true" }]);
  });
});

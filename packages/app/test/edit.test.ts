import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { memoryStore } from "@edutools/core/credentials";
import { SPECS } from "@edutools/core/objects";
import { beforeEach, describe, expect, it } from "vitest";
import { createApi } from "../src/main/api";
import { writeSampleRepo } from "../src/main/sampleRepo";
import { EDIT_KINDS, type EditKind } from "../src/shared/ipc";
import { isoToLocalInput, KIND_FIELDS, localInputToIso } from "../src/shared/objects";
import { FakeCanvas } from "./fakeCanvas";

const BSU = "https://boisestatecanvas.instructure.com";
const C = "20";

let dir: string;
let repo: string;
let fake: FakeCanvas;
let openFile: string | null;

async function makeApi(options: { withRepo?: boolean } = {}) {
  const api = createApi({
    version: "1.2.3",
    credentials: { dir, secrets: memoryStore(), legacyPath: path.join(dir, "config.toml") },
    openExternal: async () => {},
    canvas: () => fake,
    chooseFolder: async () => repo,
    chooseOpenFile: async () => openFile,
  });
  await api.addSite({ name: "BSU", endpoint: BSU, token: "tok" });
  if (options.withRepo) {
    await api.chooseCourseRepo(C);
  }
  return api;
}

/** The form body of the one write the test made. */
function written(method: "createObject" | "updateObject"): Record<string, string> {
  const call = fake.calls.filter((c) => c.method === method);
  expect(call).toHaveLength(1);
  // createObject(kind, course, fields) and updateObject(kind, course, id, fields): fields is last.
  return call[0]?.args.at(-1) as Record<string, string>;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "edutools-"));
  repo = writeSampleRepo(path.join(dir, "repo"));
  fake = new FakeCanvas();
  openFile = null;
  fake.pages = [
    { url: "welcome", title: "Welcome", body: "<p>Hi</p>", published: false, html_url: `${BSU}/courses/20/pages/welcome` },
    { url: "live", title: "Live page", body: "<p>Live</p>", published: true },
  ];
  fake.assignments = [
    {
      id: 7,
      name: "Lab 1",
      description: "<p>Do it</p>",
      points_possible: 30,
      due_at: "2026-08-31T05:59:00Z",
      unlock_at: null,
      lock_at: null,
      published: false,
    },
  ];
  fake.discussions = [
    { id: 8, title: "Graded talk", message: "<p>Talk</p>", published: false, assignment: { points_possible: 5, due_at: "2026-09-01T05:59:00Z" } },
  ];
  fake.modules = [{ id: 5, name: "Week 1", published: true }];
});

describe("the edit object field table", () => {
  it("matches core's per-kind SPECS", () => {
    for (const kind of EDIT_KINDS) {
      const spec = SPECS[kind];
      expect(KIND_FIELDS[kind]).toMatchObject({
        body: spec?.body !== null,
        points: spec?.points !== null,
        dates: spec?.dates !== null,
      });
    }
  });

  it("turns a local date and time into ISO 8601 with this computer's offset and back", () => {
    const iso = localInputToIso("2026-09-30T23:59");
    expect(iso).toMatch(/^2026-09-30T23:59:00[+-]\d{2}:\d{2}$/);
    expect(Date.parse(iso ?? "")).toBe(new Date(2026, 8, 30, 23, 59).getTime());
    expect(isoToLocalInput(iso)).toBe("2026-09-30T23:59");
    expect(localInputToIso("")).toBe("");
    expect(localInputToIso("tomorrow")).toBeNull();
    expect(isoToLocalInput(null)).toBe("");
  });
});

describe("reading objects", () => {
  it("lists each kind, a page by its url slug", async () => {
    const api = await makeApi();
    expect(await api.listObjects(C, "page")).toEqual([
      { id: "welcome", title: "Welcome", published: false },
      { id: "live", title: "Live page", published: true },
    ]);
    expect(await api.listObjects(C, "assignment")).toEqual([{ id: "7", title: "Lab 1", published: false }]);
    expect(await api.listObjects(C, "module")).toEqual([{ id: "5", title: "Week 1", published: true }]);
  });

  it("reads one object's fields, a graded discussion's from its assignment", async () => {
    const api = await makeApi();
    expect(await api.getObjectDetail({ courseId: C, kind: "assignment", id: "7" })).toEqual({
      kind: "assignment",
      id: "7",
      title: "Lab 1",
      body: "<p>Do it</p>",
      points: 30,
      dueAt: "2026-08-31T05:59:00Z",
      unlockAt: null,
      lockAt: null,
      published: false,
      htmlUrl: `${BSU}/courses/20/`,
      managedBy: null,
    });
    expect(await api.getObjectDetail({ courseId: C, kind: "discussion", id: "8" })).toMatchObject({
      points: 5,
      dueAt: "2026-09-01T05:59:00Z",
    });
    expect(await api.getObjectDetail({ courseId: C, kind: "module", id: "5" })).toMatchObject({
      body: null,
      htmlUrl: `${BSU}/courses/20/modules`,
    });
  });

  it("warns when the repository's manifest tracks the object", async () => {
    mkdirSync(path.join(repo, ".canvas"));
    writeFileSync(
      path.join(repo, ".canvas", "manifest-20.json"),
      JSON.stringify({
        entries: {
          "modules/week-01.md": { kind: "page", canvas_id: "1", page_url: "welcome", title: "Welcome", extra: {} },
          "assignments/lab-01.md": { kind: "assignment", canvas_id: "7", page_url: "", title: "Lab 1", extra: {} },
        },
      }),
    );
    const api = await makeApi({ withRepo: true });
    expect((await api.getObjectDetail({ courseId: C, kind: "page", id: "welcome" })).managedBy).toBe("modules/week-01.md");
    expect((await api.getObjectDetail({ courseId: C, kind: "assignment", id: "7" })).managedBy).toBe("assignments/lab-01.md");
    expect((await api.getObjectDetail({ courseId: C, kind: "page", id: "live" })).managedBy).toBeNull();
  });

  it("refuses ids that could leave the object's path", async () => {
    const api = await makeApi();
    await expect(api.getObjectDetail({ courseId: C, kind: "page", id: "../../x" })).rejects.toThrow(/not a page url slug/);
    await expect(api.getObjectDetail({ courseId: C, kind: "assignment", id: "welcome" })).rejects.toThrow(/not a assignment id/);
    // Cast: the renderer is typed, so only a page that bypasses it can send this.
    await expect(api.listObjects(C, "rubric" as EditKind)).rejects.toThrow(/Unknown kind/);
    expect(fake.calls).toEqual([]);
  });
});

describe("saving", () => {
  it("creates a new object unpublished, with each kind's own field names", async () => {
    const api = await makeApi();
    await api.saveObject({
      courseId: C,
      kind: "assignment",
      id: null,
      changes: { title: "Lab 2", body: { kind: "html", html: "<p>Two</p>" }, points: 10, dueAt: "2026-09-06T23:59:00-06:00" },
      changeVisible: false,
    });
    expect(written("createObject")).toEqual({
      "assignment[name]": "Lab 2",
      "assignment[description]": "<p>Two</p>",
      "assignment[points_possible]": "10",
      "assignment[due_at]": "2026-09-06T23:59:00-06:00",
      "assignment[published]": "false",
    });
  });

  it("sends a discussion's fields bare, and its points under assignment", async () => {
    const api = await makeApi();
    await api.saveObject({ courseId: C, kind: "discussion", id: null, changes: { title: "Q&A", points: 5 }, changeVisible: false });
    expect(written("createObject")).toEqual({
      title: "Q&A",
      "assignment[points_possible]": "5",
      published: "false",
    });
  });

  it("needs a title for a new object", async () => {
    const api = await makeApi();
    await expect(
      api.saveObject({ courseId: C, kind: "page", id: null, changes: {}, changeVisible: false }),
    ).rejects.toThrow(/needs a title/);
  });

  it("sends only what changed on an update, and never the published state", async () => {
    const api = await makeApi();
    await api.saveObject({ courseId: C, kind: "page", id: "welcome", changes: { title: "Hello" }, changeVisible: false });
    expect(written("updateObject")).toEqual({ "wiki_page[title]": "Hello" });
  });

  it("clears a date sent as an empty string", async () => {
    const api = await makeApi();
    await api.saveObject({ courseId: C, kind: "assignment", id: "7", changes: { dueAt: "" }, changeVisible: false });
    expect(written("updateObject")).toEqual({ "assignment[due_at]": "" });
  });

  it("refuses to change a published object unless told to", async () => {
    const api = await makeApi();
    const request = { courseId: C, kind: "page" as const, id: "live", changes: { title: "New title" } };
    await expect(api.saveObject({ ...request, changeVisible: false })).rejects.toThrow(/visible to students/);
    expect(fake.methods()).not.toContain("updateObject");
    await api.saveObject({ ...request, changeVisible: true });
    expect(written("updateObject")).toEqual({ "wiki_page[title]": "New title" });
  });

  it("checks Canvas, not the page, for whether the object is published", async () => {
    const api = await makeApi();
    // Published in the browser after the form was loaded.
    const welcome = fake.pages[0];
    if (welcome) welcome.published = true;
    await expect(
      api.saveObject({ courseId: C, kind: "page", id: "welcome", changes: { title: "x" }, changeVisible: false }),
    ).rejects.toThrow(/visible to students/);
  });

  it("says when there is nothing to save", async () => {
    const api = await makeApi();
    await expect(
      api.saveObject({ courseId: C, kind: "page", id: "welcome", changes: {}, changeVisible: false }),
    ).rejects.toThrow(/Nothing has changed/);
  });

  it("refuses fields a kind does not have, and bad dates", async () => {
    const api = await makeApi();
    await expect(
      api.saveObject({ courseId: C, kind: "page", id: "welcome", changes: { points: 3 }, changeVisible: false }),
    ).rejects.toThrow("a page takes no points");
    await expect(
      api.saveObject({ courseId: C, kind: "assignment", id: "7", changes: { dueAt: "next week" }, changeVisible: false }),
    ).rejects.toThrow(/not a date and time with a time zone/);
    await expect(
      api.saveObject({ courseId: C, kind: "assignment", id: "7", changes: { dueAt: "2026-09-06T23:59" }, changeVisible: false }),
    ).rejects.toThrow(/time zone/);
  });

  it("refuses HTML that Canvas would strip", async () => {
    const api = await makeApi();
    await expect(
      api.saveObject({
        courseId: C,
        kind: "page",
        id: "welcome",
        changes: { body: { kind: "html", html: "<style>p{}</style><p>x</p>" } },
        changeVisible: false,
      }),
    ).rejects.toThrow(/silently remove <style>/);
  });

  it("renders a markdown body the way a push does, with the repo's stylesheet", async () => {
    const api = await makeApi({ withRepo: true });
    const file = path.join(repo, "modules", "week-01.md");
    const rendered = await api.renderMarkdownBody(C, file);
    expect(rendered.title).toBe("Week 1 overview");
    expect(rendered.html).toContain('<p style="color: #333333">Welcome to the course.</p>');
    await api.saveObject({ courseId: C, kind: "page", id: "welcome", changes: { body: { kind: "markdown", file } }, changeVisible: false });
    expect(written("updateObject")["wiki_page[body]"]).toBe(rendered.html);
  });

  it("renders markdown outside the repository without its styling, and takes its title for a new object", async () => {
    const api = await makeApi();
    const file = path.join(dir, "note.md");
    writeFileSync(file, "# A note\n\nPlain text.\n");
    await api.saveObject({ courseId: C, kind: "page", id: null, changes: { body: { kind: "markdown", file } }, changeVisible: false });
    expect(written("createObject")).toEqual({
      "wiki_page[title]": "A note",
      "wiki_page[body]": "<p>Plain text.</p>\n",
      "wiki_page[published]": "false",
    });
    await expect(api.renderMarkdownBody(C, path.join(dir, "note.txt"))).rejects.toThrow(/markdown file/);
  });

  it("picks a markdown file starting in the repository", async () => {
    const asked: string[] = [];
    const api = createApi({
      version: "",
      credentials: { dir, secrets: memoryStore() },
      openExternal: async () => {},
      canvas: () => fake,
      chooseFolder: async () => repo,
      chooseOpenFile: async (defaultPath) => {
        asked.push(defaultPath);
        return path.join(repo, "modules", "week-01.md");
      },
    });
    await api.addSite({ name: "BSU", endpoint: BSU, token: "tok" });
    await api.chooseCourseRepo(C);
    expect(await api.chooseMarkdownFile(C)).toBe(path.join(repo, "modules", "week-01.md"));
    expect(asked).toEqual([repo]);
  });
});

describe("publishing and deleting", () => {
  it("publishes and unpublishes with explicit calls", async () => {
    const api = await makeApi();
    expect((await api.setObjectPublished({ courseId: C, kind: "module", id: "5" }, false)).published).toBe(false);
    expect(written("updateObject")).toEqual({ "module[published]": "false" });
  });

  it("reads an object before deleting it and names what went", async () => {
    const api = await makeApi();
    expect(await api.deleteObject({ courseId: C, kind: "assignment", id: "7" })).toBe("Lab 1");
    expect(fake.methods()).toEqual(["getObject", "deleteObject"]);
  });

  it("deletes nothing it could not read", async () => {
    const api = await makeApi();
    await expect(api.deleteObject({ courseId: C, kind: "assignment", id: "99" })).rejects.toThrow(/404/);
    expect(fake.methods()).not.toContain("deleteObject");
  });
});

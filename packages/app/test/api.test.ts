import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { memoryStore } from "@edutools/core/credentials";
import type { Payload } from "@edutools/core/types";
import { beforeEach, describe, expect, it } from "vitest";
import { type CanvasClient, createApi } from "../src/main/api";
import { filterCourses, sortCourses, toCourseRow } from "../src/shared/courses";
import { API_METHODS } from "../src/shared/ipc";

const BSU = "https://boisestatecanvas.instructure.com";

const COURSES: Payload[] = [
  { id: 20, name: "Software Engineering", course_code: "CS 471", workflow_state: "available", term: { name: "Fall 2026" } },
  { id: 3, name: "Data Structures", course_code: "CS 321", workflow_state: "available", term: { name: "Fall 2026" } },
];

let dir: string;
let secrets: ReturnType<typeof memoryStore>;
let calls: Array<{ endpoint: string; token: string; includeAll: boolean | undefined }>;

function makeApi(env: Record<string, string> = {}) {
  return createApi({
    version: "1.2.3",
    credentials: { dir, secrets, env, legacyPath: path.join(dir, "config.toml") },
    openExternal: async () => {},
    canvas: (endpoint, token): CanvasClient => ({
      async getCourses(options) {
        calls.push({ endpoint, token, includeAll: options?.includeAll });
        return COURSES;
      },
    }),
  });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "edutools-"));
  secrets = memoryStore();
  calls = [];
});

describe("the main-process api", () => {
  it("never hands a saved token to the renderer, only a hint", async () => {
    const api = makeApi();
    const sites = await api.addSite({ name: "", endpoint: `${BSU}/`, token: "1234~secrettokenabcd" });
    expect(sites).toEqual([
      { name: "boisestatecanvas.instructure.com", endpoint: BSU, isDefault: true, tokenHint: "****abcd" },
    ]);
    expect(JSON.stringify(await api.listSites())).not.toContain("secret");
  });

  it("tests a saved site with its keychain token", async () => {
    const api = makeApi();
    await api.addSite({ name: "BSU", endpoint: BSU, token: "tok" });
    expect(await api.testSite("BSU")).toEqual({ endpoint: BSU, courseCount: 2 });
    expect(calls).toEqual([{ endpoint: BSU, token: "tok", includeAll: undefined }]);
  });

  it("lists the default site's courses as table rows, concluded ones on request", async () => {
    const api = makeApi();
    await api.addSite({ name: "BSU", endpoint: BSU, token: "tok" });
    const list = await api.listCourses({ includeAll: true });
    expect(list.site).toBe("BSU");
    expect(list.courses[0]).toEqual({
      id: "20",
      name: "Software Engineering",
      code: "CS 471",
      term: "Fall 2026",
      state: "available",
    });
    expect(calls[0]?.includeAll).toBe(true);
  });

  it("ignores CANVAS_TOKEN unless the caller passes an environment", async () => {
    await expect(createApi({ version: "", credentials: { dir, secrets }, openExternal: async () => {} }).listCourses({ includeAll: false })).rejects.toThrow(
      /No Canvas site is set up/,
    );
    expect(await makeApi({ CANVAS_TOKEN: "env" }).listCourses({ includeAll: false })).toMatchObject({
      endpoint: BSU,
    });
  });

  it("rejects missing arguments from the renderer", async () => {
    const api = makeApi();
    await expect(api.addSite({ name: "x", endpoint: BSU, token: " " })).rejects.toThrow("The access token is required.");
    await expect(api.removeSite("")).rejects.toThrow("The site name is required.");
  });

  it("imports the old config.toml", async () => {
    const api = makeApi();
    expect((await api.importLegacyConfig()).imported).toBe(false);
    writeFileSync(path.join(dir, "config.toml"), '[canvas]\ntoken = "legacy"\n');
    expect(await api.importLegacyConfig()).toMatchObject({ imported: true, created: true });
    expect(secrets.entries.get(BSU)).toBe("legacy");
  });

  it("opens only https links", async () => {
    const opened: string[] = [];
    const api = createApi({ version: "", credentials: { dir, secrets }, openExternal: async (u) => void opened.push(u) });
    await api.openExternal("https://example.edu/x");
    await expect(api.openExternal("file:///etc/passwd")).rejects.toThrow(/Refusing/);
    expect(opened).toEqual(["https://example.edu/x"]);
  });

  it("exposes a channel for every api method", () => {
    expect(new Set(API_METHODS)).toEqual(new Set(Object.keys(makeApi())));
  });
});

describe("course rows", () => {
  const rows = COURSES.map(toCourseRow);

  it("sorts ids numerically and names as text", () => {
    expect(sortCourses(rows, "id").map((r) => r.id)).toEqual(["3", "20"]);
    expect(sortCourses(rows, "name", true).map((r) => r.name)).toEqual(["Software Engineering", "Data Structures"]);
  });

  it("filters on any column, ignoring case", () => {
    expect(filterCourses(rows, "cs 3").map((r) => r.id)).toEqual(["3"]);
    expect(filterCourses(rows, "  ")).toHaveLength(2);
  });

  it("leaves the term blank for a course with none", () => {
    expect(toCourseRow({ id: 1, name: "Sandbox" }).term).toBe("");
  });
});

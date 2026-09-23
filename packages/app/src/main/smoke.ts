/**
 * EDUTOOLS_SMOKE_TEST=1 opens the window, checks that the bridge reached the page,
 * that every working screen mounts and draws from the api, that a snapshot streams
 * progress events and finishes, and that both native modules (the keychain and the
 * CSS inliner) load. It prints the outcome and quits. CI and a packaged-build
 * check run it; a user never sees it.
 *
 * It runs against a throwaway config directory, an in-memory token store, a fake
 * Canvas client and a sample course repository, so it never reads the real site
 * list or keychain token and never reaches a Canvas server.
 */

import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { keychainStore, memoryStore } from "@edutools/core/credentials";
import type { Payload } from "@edutools/core/types";
import { app, type BrowserWindow } from "electron";
import type { EdutoolsApi } from "../shared/ipc";
import type { ApiDeps, CanvasClient } from "./api";
import { renderBody } from "./repo";
import { writeSampleRepo } from "./sampleRepo";

const COURSE = { id: "101", name: "Smoke Test Course", code: "SMOKE 101" };
const ENDPOINT = "https://smoke-test.invalid";

/** A course with one of everything, and a rubrics listing that fails like a 403 would. */
function fakeCanvas(): CanvasClient {
  const url = (rest: string) => `${ENDPOINT}/courses/${COURSE.id}/${rest}`;
  const course: Payload = { id: 101, name: COURSE.name, course_code: COURSE.code, apply_assignment_group_weights: true };
  const assignment: Payload = {
    id: 7,
    name: "Smoke Assignment",
    points_possible: 10,
    due_at: "2026-09-30T05:59:00Z",
    published: true,
    assignment_group_id: 3,
    html_url: url("assignments/7"),
    description: "<p>Do the thing.</p>",
  };
  const page: Payload = {
    url: "smoke-page",
    title: "Smoke Page",
    // Published, so Edit object has to show its "visible to students" guard.
    published: true,
    updated_at: "2026-09-01T12:00:00Z",
    html_url: url("pages/smoke-page"),
    body: "<p>Hello.</p>",
  };
  const list = async (items: Payload[]) => items.map((i) => ({ ...i }));
  const objects: Record<string, Payload[]> = { page: [page], assignment: [assignment] };
  const find = async (kind: string, id: string): Promise<Payload> => {
    const found = (objects[kind] ?? []).find((o) => String(kind === "page" ? o.url : o.id) === id);
    if (!found) {
      throw new Error(`Canvas API error 404: no ${kind} ${id}`);
    }
    return { ...found };
  };
  const base: Partial<CanvasClient> = {
    getCourses: async () => [course],
    getCourse: async () => course,
    getCourseWithSyllabus: async () => ({ ...course, syllabus_body: "<p>Syllabus</p>" }),
    listPages: () => list([page]),
    getPage: async () => page,
    listAssignments: () => list([assignment]),
    listDiscussions: () => list([]),
    listAnnouncements: () => list([]),
    listQuizzes: () => list([]),
    listQuizQuestions: () => list([]),
    listModules: () => list([{ id: 5, name: "Smoke Module", published: true }]),
    listModuleItems: () =>
      list([{ id: 9, title: "Smoke Page", type: "Page", indent: 0, published: false, html_url: url("modules/items/9") }]),
    listAssignmentGroups: async (_id, options) =>
      list([{ id: 3, name: "Smoke Group", group_weight: 100, ...(options?.withAssignments ? { assignments: [assignment] } : {}) }]),
    listRubrics: async () => {
      throw new Error("Canvas API error 403: smoke test");
    },
    listFolders: () => list([{ id: 1, full_name: "course files" }]),
    listFiles: () =>
      list([{ id: 2, display_name: "smoke.txt", folder_id: 1, url: `${ENDPOINT}/files/2/download`, size: 6 }]),
    downloadAttachment: async (_url, dest) => {
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, "smoke\n");
      return 6;
    },
    getObject: (kind, _course, id) => find(kind, id),
    // The smoke test never saves or deletes; these only complete the client.
    createObject: async () => ({ id: 1, title: "New", published: false }),
    updateObject: (kind, _course, id) => find(kind, id),
    deleteObject: (kind, _course, id) => find(kind, id),
  };
  // Everything a real push or clean sync would call is left out: the smoke test
  // only previews, which asks Canvas nothing, so any other call is a bug here.
  const missing = (name: string) => async () => {
    throw new Error(`${name} is not part of the smoke test`);
  };
  // The Proxy answers every CanvasClient method, either from `base` or with the
  // rejecting stub above, which is what makes it a complete client.
  return new Proxy(base, {
    get: (target, name) => (name in target ? Reflect.get(target, name) : missing(String(name))),
  }) as CanvasClient;
}

let sampleRepo = "";

/** Api dependencies that keep the smoke test away from the user's real setup. */
export function smokeDeps(version: string): ApiDeps {
  const dir = mkdtempSync(path.join(os.tmpdir(), "edutools-smoke-"));
  sampleRepo = writeSampleRepo(path.join(dir, "repo"));
  return {
    version,
    credentials: { dir, secrets: memoryStore(), legacyPath: path.join(dir, "config.toml") },
    canvas: () => fakeCanvas(),
    openExternal: async () => {},
    documentsDir: dir,
    // The repository dialog "picks" the sample repository; any other dialog is cancelled.
    chooseFolder: async (_default, title) => (title?.includes("repository") ? sampleRepo : null),
    chooseOpenFile: async () => null,
    chooseSaveFile: async () => null,
    showItemInFolder: () => {},
  };
}

/** Put a site, a current course and its repository in the throwaway config, as a user would. */
export async function seedSmoke(api: EdutoolsApi): Promise<void> {
  await api.addSite({ name: "Smoke", endpoint: ENDPOINT, token: "smoke-token" });
  await api.setCurrentCourse(COURSE);
  const info = await api.chooseCourseRepo(COURSE.id);
  if (!info || info.problem) {
    throw new Error(`the sample repository did not load: ${info?.problem ?? "not chosen"}`);
  }
}

async function waitFor(window: BrowserWindow, expression: string, what: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if ((await window.webContents.executeJavaScript(`!!(${expression})`)) === true) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function click(window: BrowserWindow, selector: string): Promise<void> {
  await waitFor(window, `document.querySelector(${JSON.stringify(selector)})`, selector);
  await window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).click()`);
}

function has(selector: string, text: string): string {
  return `[...document.querySelectorAll(${JSON.stringify(selector)})].some((e) => e.textContent.includes(${JSON.stringify(text)}))`;
}

export async function smokeTest(window: BrowserWindow): Promise<void> {
  const timer = setTimeout(() => {
    console.error("SMOKE FAIL: timed out");
    app.exit(2);
  }, 90_000);
  try {
    await new Promise<void>((resolve) => window.webContents.once("did-finish-load", () => resolve()));
    const bridge: unknown = await window.webContents.executeJavaScript(
      "typeof window.edutools === 'object' && typeof window.edutools.listSites === 'function' && typeof window.edutools.on === 'function' && typeof require === 'undefined'",
    );
    if (bridge !== true) {
      throw new Error("the preload bridge is missing, or node leaked into the page");
    }
    await waitFor(window, "document.querySelector('.window .sidebar')", "the app to render");
    await waitFor(window, has(".statusbar", COURSE.code), "the current course in the status bar");

    await click(window, '.nav-item[data-screen="overview"]');
    await waitFor(window, has("#panel-assignments td", "Smoke Assignment"), "the Assignments tab");
    for (const [tab, text] of [
      ["modules", "Smoke Module"],
      ["pages", "smoke-page"],
      ["groups", "Smoke Group"],
    ] as const) {
      await click(window, `[role="tab"][data-tab="${tab}"]`);
      await waitFor(window, has(`#panel-${tab} td`, text), `the ${tab} tab`);
    }

    await click(window, '.nav-item[data-screen="snapshot"]');
    await waitFor(window, "document.querySelector('.snapshot-about')", "the Snapshot screen");
    await click(window, "button.start-snapshot");
    await waitFor(window, "document.querySelector('.snapshot-summary')", "the snapshot to finish");
    await waitFor(window, has(".snapshot-log", "Downloading"), "progress events in the log");
    await waitFor(window, has(".snapshot-problems", "rubrics"), "the snapshot's problems to be listed");

    await click(window, '.nav-item[data-screen="outline"]');
    await waitFor(window, has(".outline-table td", "Lab 1: Hello"), "the Outline screen");
    if ((await window.webContents.executeJavaScript(has(".outline-table td", "Instructor notes"))) === true) {
      throw new Error("the outline shows a never_publish module");
    }

    await click(window, '.nav-item[data-screen="dates"]');
    await waitFor(window, has(".dates-table td", "Lab 1: Hello"), "the Dates screen");
    await waitFor(window, has(".screen-body .message.ok", "consistent"), "the Dates screen to find no problems");

    await click(window, '.nav-item[data-screen="edit"]');
    await waitFor(window, has(".object-list td", "Smoke Page"), "the Edit object list");
    await click(window, ".object-list tbody tr");
    await waitFor(window, "document.querySelector('#edit-title')?.value === 'Smoke Page'", "the Edit object form");
    await waitFor(window, "document.querySelector('.visible-guard')", "the published guard");
    await waitFor(window, "document.querySelector('button.save-object')?.disabled === true", "Save to stay disabled");

    // Publish: the dry run needs no Canvas, so it runs for real on the sample repository.
    await click(window, '.nav-item[data-screen="publish"]');
    await waitFor(window, "document.querySelector('.clean-sync .warning-box')", "the clean sync warning");
    await waitFor(window, "document.querySelector('button.run-push')?.disabled === true", "Publish to wait for a preview");
    await click(window, "button.preview-push");
    await waitFor(window, has(".preview-summary", "Preview finished"), "the preview result");
    await waitFor(window, has(".preview-summary", "Covers 4 files"), "the preview to cover the sample repository");
    await waitFor(window, "document.querySelector('button.run-push')?.disabled === false", "Publish to enable after a clean preview");

    await click(window, '.nav-item[data-screen="verify"]');
    await waitFor(window, "document.querySelector('.verify-about') && document.querySelector('button.run-verify')", "the Verify screen");
    await click(window, '.nav-item[data-screen="audit"]');
    await waitFor(window, "document.querySelector('.audit-about') && document.querySelector('button.run-audit')", "the Audit screen");

    // The repo's canvas.css is inlined by the native CSS inliner, so this loads it.
    const rendered = renderBody(path.join(sampleRepo, "modules", "week-01.md"), sampleRepo);
    if (!rendered.html.includes("style=")) {
      throw new Error("canvas.css was not inlined into the rendered body");
    }

    // A read of an account that does not exist: loads the native module and asks
    // the keychain without writing anything.
    await keychainStore("edutools-smoke-test").get("https://smoke-test.invalid");
    console.log("SMOKE OK");
    clearTimeout(timer);
    app.exit(0);
  } catch (error) {
    console.error(`SMOKE FAIL: ${error instanceof Error ? error.message : String(error)}`);
    app.exit(1);
  }
}

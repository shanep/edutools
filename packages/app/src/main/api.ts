/**
 * The main-process side of EdutoolsApi. Everything that touches the keychain or
 * Canvas happens here, never in the renderer.
 *
 * This module does not import electron, so tests build it with an in-memory secret
 * store and a fake Canvas client.
 */

import { existsSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CanvasLMS, DEFAULT_ENDPOINT } from "@edutools/core/canvas";
import {
  addSite,
  type CredentialOptions,
  configPath,
  defaultSite,
  importLegacyConfig,
  legacyConfigPath,
  listSites,
  normalizeEndpoint,
  removeSite,
  resolveCredentials,
  setDefaultSite,
  setToken,
} from "@edutools/core/credentials";
import {
  auditCourse as auditCourseRun,
  type CleanPlan,
  CleanRefusedError,
  type CourseCanvas,
  PUSH_GROUPS,
  planClean,
  push,
  verifyCourse as verifyCourseRun,
  writePreview,
} from "@edutools/core/course";
import { INDEX_NAME, KINDS, type PullCanvas } from "@edutools/core/pull";
import { toCourseRow } from "../shared/courses";
import type { CourseChoice, CurrentCourse, Emit, EdutoolsApi, SiteView, TestResult } from "../shared/ipc";
import { groupNames, toAssignmentGroupList, toAssignmentRow, toModuleRow, toPageRow } from "../shared/overview";
import {
  deleteObject,
  type EditContext,
  getDetail,
  listObjects,
  requireKind,
  requireObjectId,
  saveObject,
  setPublished,
} from "./editing";
import {
  checkPushRequest,
  describeCourseError,
  jobCallbacks,
  pushKey,
  toAuditSummary,
  toCleanPlanView,
  toPushSummary,
  toVerifySummary,
} from "./courseJobs";
import { buildOutline, buildSchedule, inspectRepo, outlineJsonText, renderBody } from "./repo";
import { loadSettings, repoKey, saveSettings } from "./settings";
import { checkKinds, defaultSnapshotFolder, runSnapshot } from "./snapshot";

/**
 * The part of CanvasLMS the app uses: the course reads, everything a pull calls,
 * everything a push, verify, audit or clean sync calls, and the single-object
 * calls Edit object makes.
 */
export type CanvasClient = PullCanvas &
  CourseCanvas &
  Pick<CanvasLMS, "getCourses" | "getCourse" | "getObject" | "createObject" | "updateObject" | "deleteObject">;

/** A file type a dialog offers, as Electron's FileFilter. */
export interface FileFilter {
  readonly name: string;
  readonly extensions: string[];
}

export interface ApiDeps {
  readonly version: string;
  readonly credentials: CredentialOptions;
  readonly canvas?: (endpoint: string, token: string) => CanvasClient;
  readonly openExternal: (url: string) => Promise<void>;
  /** Sends an event to the window. Defaults to dropping it. */
  readonly emit?: Emit;
  /** Where a snapshot goes by default, under `edutools/`. Defaults to ~/Documents. */
  readonly documentsDir?: string;
  /** The native folder dialog. */
  readonly chooseFolder?: (defaultPath: string, title?: string) => Promise<string | null>;
  /** The native open-file dialog. */
  readonly chooseOpenFile?: (defaultPath: string, title: string, filters: FileFilter[]) => Promise<string | null>;
  /** The native save dialog. */
  readonly chooseSaveFile?: (defaultPath: string, title: string, filters: FileFilter[]) => Promise<string | null>;
  /** Reveal a path in Finder or Explorer. */
  readonly showItemInFolder?: (fullPath: string) => void;
}

/** Arguments come from the renderer, so they are checked rather than trusted. */
function requireText(value: unknown, what: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${what} is required.`);
  }
  return value.trim();
}

/**
 * A Canvas course id. The ids the app sends come from the course list, so only
 * plain numbers are accepted; anything else would be spliced into a Canvas path.
 */
function requireCourseId(value: unknown): string {
  const id = requireText(value, "The course id");
  if (!/^\d+$/.test(id)) {
    throw new Error(`'${id}' is not a Canvas course id.`);
  }
  return id;
}

function requireFolder(value: unknown): string {
  const folder = requireText(value, "The folder");
  if (!path.isAbsolute(folder)) {
    throw new Error(`Choose a full folder path, not '${folder}'.`);
  }
  return path.normalize(folder);
}

function requireChoice(value: unknown): CourseChoice {
  if (typeof value !== "object" || value === null) {
    throw new Error("A course is required.");
  }
  // A non-null object from the renderer: reading the three fields to check them.
  const c = value as Record<string, unknown>;
  return {
    id: requireCourseId(c.id),
    name: typeof c.name === "string" ? c.name : "",
    code: typeof c.code === "string" ? c.code : "",
  };
}

/** The deepest folder of `target` that exists, so a dialog opens somewhere real. */
function existingAncestor(target: string): string {
  let current = target;
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return current;
}

export function createApi(deps: ApiDeps): EdutoolsApi {
  // The app ignores CANVAS_TOKEN and CANVAS_ENDPOINT: Settings is the one place a
  // designer manages credentials, and a stray variable in a launch environment
  // would make the Courses screen disagree with what Settings shows.
  const options: CredentialOptions = { env: {}, ...deps.credentials };
  const canvas = deps.canvas ?? ((endpoint, token) => new CanvasLMS({ endpoint, token }));
  const emit: Emit = deps.emit ?? (() => {});
  const documents = deps.documentsDir ?? path.join(os.homedir(), "Documents");

  // One long Canvas job at a time, across snapshot, push, clean sync, verify
  // and audit: Canvas throttles parallel work and charges a pre-flight penalty
  // for it, two pulls into one folder would fight over its index.json, and two
  // pushes would race each other through the manifest.
  let runningJob: string | null = null;
  const exclusive = async <T>(job: string, work: () => Promise<T>): Promise<T> => {
    if (runningJob !== null) {
      throw new Error(`A ${runningJob} is already running. Wait for it to finish before starting another.`);
    }
    runningJob = job;
    try {
      return await work();
    } finally {
      runningJob = null;
    }
  };

  // Main-process memory the page cannot forge: the push options last previewed
  // per course (a real push must match one), the HTML that preview rendered,
  // and the clean plan last shown.
  const previewed = new Set<string>();
  const rendered = new Map<string, ReadonlyMap<string, string>>();
  const cleanPlans = new Map<string, { plan: CleanPlan; confirmText: string }>();

  const sites = async (): Promise<SiteView[]> => listSites(options);

  const test = async (endpoint: string, token: string): Promise<TestResult> => {
    const courses = await canvas(endpoint, token).getCourses();
    return { endpoint, courseCount: courses.length };
  };

  /** A client for the default site, and its endpoint for building links. */
  const connect = async (): Promise<{ client: CanvasClient; endpoint: string }> => {
    const resolved = await resolveCredentials(undefined, options);
    return { client: canvas(resolved.endpoint, resolved.token), endpoint: resolved.endpoint };
  };

  const siteEndpoint = (): string => {
    const site = defaultSite(options);
    if (!site) {
      throw new Error("No Canvas site is set up. Add one in Settings.");
    }
    return site.endpoint;
  };

  /** The repository remembered for this course on the default site, or null. */
  const repoOf = (courseId: string): string | null => {
    const site = defaultSite(options);
    return site ? (loadSettings(options).repos[repoKey(site.endpoint, courseId)] ?? null) : null;
  };

  const requireRepo = (courseId: string): string => {
    const repo = repoOf(courseId);
    if (repo === null) {
      throw new Error("No course repository is chosen for this course. Choose the folder that holds its canvas.toml.");
    }
    if (!existsSync(repo)) {
      throw new Error(`The course repository ${repo} is not there any more. Choose it again.`);
    }
    return repo;
  };

  /** What the designer types to confirm a clean sync: the course code they know it by. */
  const currentCourseCode = (courseId: string): string => {
    const course = loadSettings(options).currentCourse;
    return course?.id === courseId && course.code.trim() ? course.code.trim() : courseId;
  };

  const editContext = async (courseId: string): Promise<EditContext> => {
    const { client, endpoint } = await connect();
    return { client, endpoint, courseId, repo: repoOf(courseId) };
  };

  const editTarget = async (target: unknown) => {
    if (typeof target !== "object" || target === null) {
      throw new Error("Say which object.");
    }
    // A non-null object from the renderer: its three fields are checked below.
    const t = target as Record<string, unknown>;
    const courseId = requireCourseId(t.courseId);
    const kind = requireKind(t.kind);
    const id = requireObjectId(kind, t.id);
    return { ctx: await editContext(courseId), kind, id };
  };

  return {
    async appInfo() {
      return {
        version: deps.version,
        configPath: configPath(options),
        legacyPath: legacyConfigPath(options),
        defaultEndpoint: DEFAULT_ENDPOINT,
        platform: options.platform ?? process.platform,
      };
    },

    listSites: sites,

    async addSite(input) {
      const endpoint = normalizeEndpoint(requireText(input?.endpoint, "The Canvas address"));
      const token = requireText(input?.token, "The access token");
      const name = typeof input?.name === "string" && input.name.trim() ? input.name : new URL(endpoint).hostname;
      await addSite({ name, endpoint, token }, options);
      return sites();
    },

    async removeSite(name) {
      await removeSite(requireText(name, "The site name"), options);
      return sites();
    },

    async setDefaultSite(name) {
      setDefaultSite(requireText(name, "The site name"), options);
      return sites();
    },

    async setToken(name, token) {
      await setToken(requireText(name, "The site name"), requireText(token, "The access token"), options);
      return sites();
    },

    async testSite(name) {
      const resolved = await resolveCredentials(requireText(name, "The site name"), options);
      return test(resolved.endpoint, resolved.token);
    },

    async testConnection(input) {
      const endpoint = normalizeEndpoint(requireText(input?.endpoint, "The Canvas address"));
      return test(endpoint, requireText(input?.token, "The access token"));
    },

    async importLegacyConfig() {
      const result = await importLegacyConfig(options);
      if (!result) {
        return { imported: false, created: false, siteName: null, path: legacyConfigPath(options) };
      }
      return { imported: true, created: result.created, siteName: result.site.name, path: result.path };
    },

    async listCourses(request) {
      const resolved = await resolveCredentials(undefined, options);
      const courses = await canvas(resolved.endpoint, resolved.token).getCourses({
        includeAll: request?.includeAll === true,
      });
      return { site: resolved.site, endpoint: resolved.endpoint, courses: courses.map(toCourseRow) };
    },

    async openExternal(url) {
      // Only web links: a file: or custom-scheme URL from the renderer could launch
      // a local program.
      const parsed = new URL(requireText(url, "The link"));
      if (parsed.protocol !== "https:") {
        throw new Error(`Refusing to open ${parsed.protocol} links.`);
      }
      await deps.openExternal(parsed.toString());
    },

    async getCurrentCourse() {
      const course = loadSettings(options).currentCourse;
      // A course id means nothing on another Canvas site, so a course chosen
      // before the default site changed is not the current course any more.
      if (!course || course.endpoint !== defaultSite(options)?.endpoint) {
        return null;
      }
      return course;
    },

    async setCurrentCourse(choice) {
      const settings = loadSettings(options);
      if (choice === null) {
        saveSettings({ ...settings, currentCourse: null }, options);
        return null;
      }
      const checked = requireChoice(choice);
      const site = defaultSite(options);
      if (!site) {
        throw new Error("No Canvas site is set up. Add one in Settings.");
      }
      const course: CurrentCourse = { ...checked, endpoint: site.endpoint };
      saveSettings({ ...settings, currentCourse: course }, options);
      return course;
    },

    async listAssignments(courseId) {
      const id = requireCourseId(courseId);
      const { client } = await connect();
      // Sequential on purpose: Canvas throttles parallel requests.
      const assignments = await client.listAssignments(id);
      const groups = groupNames(await client.listAssignmentGroups(id));
      return assignments.map((a) => toAssignmentRow(a, groups));
    },

    async listModules(courseId) {
      const id = requireCourseId(courseId);
      const { client, endpoint } = await connect();
      const modulesUrl = `${endpoint}/courses/${id}/modules`;
      const rows = [];
      for (const module of await client.listModules(id)) {
        const items = await client.listModuleItems(id, String(module.id ?? ""));
        rows.push(toModuleRow(module, items, modulesUrl));
      }
      return rows;
    },

    async listPages(courseId) {
      const id = requireCourseId(courseId);
      const { client } = await connect();
      return (await client.listPages(id)).map(toPageRow);
    },

    async listAssignmentGroups(courseId) {
      const id = requireCourseId(courseId);
      const { client, endpoint } = await connect();
      const course = await client.getCourse(id);
      const groups = await client.listAssignmentGroups(id, { withAssignments: true });
      return toAssignmentGroupList(course, groups, `${endpoint}/courses/${id}/assignments`);
    },

    async snapshotDefaults(choice) {
      const course = requireChoice(choice);
      return { folder: defaultSnapshotFolder(documents, course.code, course.id), kinds: [...KINDS] };
    },

    async chooseFolder(defaultPath) {
      if (!deps.chooseFolder) {
        throw new Error("Choosing a folder is not available here.");
      }
      const start = typeof defaultPath === "string" && path.isAbsolute(defaultPath) ? defaultPath : documents;
      return deps.chooseFolder(existingAncestor(start), "Choose a snapshot folder");
    },

    async startSnapshot(request) {
      const courseId = requireCourseId(request?.courseId);
      const folder = requireFolder(request?.folder);
      const kinds = checkKinds(request?.kinds);
      return exclusive("snapshot", async () => {
        const { client } = await connect();
        return runSnapshot(client, courseId, folder, kinds, (message) => emit("snapshotProgress", { courseId, message }));
      });
    },

    async showFolder(folder) {
      if (!deps.showItemInFolder) {
        throw new Error("Showing a folder is not available here.");
      }
      const target = requireFolder(folder);
      if (!existsSync(target) || !statSync(target).isDirectory()) {
        throw new Error(`${target} is not a folder.`);
      }
      // Revealing index.json opens the snapshot folder itself, where revealing
      // the folder would open its parent with the folder selected.
      const index = path.join(target, INDEX_NAME);
      deps.showItemInFolder(existsSync(index) ? index : target);
    },

    async getCourseRepo(courseId) {
      const folder = repoOf(requireCourseId(courseId));
      return folder === null ? null : inspectRepo(folder);
    },

    async chooseCourseRepo(courseId) {
      const id = requireCourseId(courseId);
      if (!deps.chooseFolder) {
        throw new Error("Choosing a folder is not available here.");
      }
      const endpoint = siteEndpoint();
      const picked = await deps.chooseFolder(
        existingAncestor(repoOf(id) ?? documents),
        "Choose the course repository (the folder with canvas.toml)",
      );
      if (picked === null) {
        return null;
      }
      const info = inspectRepo(path.normalize(picked));
      // A folder with no canvas.toml is not remembered: it can never become a
      // repository by editing, whereas a canvas.toml with a mistake can.
      if (!existsSync(path.join(info.path, "canvas.toml"))) {
        return info;
      }
      const settings = loadSettings(options);
      saveSettings({ ...settings, repos: { ...settings.repos, [repoKey(endpoint, id)]: info.path } }, options);
      return info;
    },

    async forgetCourseRepo(courseId) {
      const key = repoKey(siteEndpoint(), requireCourseId(courseId));
      const settings = loadSettings(options);
      const { [key]: _gone, ...repos } = settings.repos;
      saveSettings({ ...settings, repos }, options);
    },

    async courseOutline(courseId) {
      const repo = requireRepo(requireCourseId(courseId));
      return { repo, modules: buildOutline(repo) };
    },

    async exportOutline(courseId) {
      const repo = requireRepo(requireCourseId(courseId));
      if (!deps.chooseSaveFile) {
        throw new Error("Saving a file is not available here.");
      }
      // Built before the dialog, so a broken repo says so rather than after a save.
      const text = outlineJsonText(repo);
      const target = await deps.chooseSaveFile(path.join(repo, "outline.json"), "Export the module outline", [
        { name: "JSON", extensions: ["json"] },
      ]);
      if (target === null) {
        return null;
      }
      writeFileSync(target, text, "utf8");
      return target;
    },

    async courseSchedule(courseId, shiftDays) {
      const repo = requireRepo(requireCourseId(courseId));
      const days = shiftDays ?? 0;
      if (typeof days !== "number" || !Number.isInteger(days) || Math.abs(days) > 366) {
        throw new Error("Shift by a whole number of days, at most a year either way.");
      }
      return buildSchedule(repo, days);
    },

    async listObjects(courseId, kind) {
      const id = requireCourseId(courseId);
      const { client } = await connect();
      return listObjects(client, id, requireKind(kind));
    },

    async getObjectDetail(target) {
      const { ctx, kind, id } = await editTarget(target);
      return getDetail(ctx, kind, id);
    },

    async chooseMarkdownFile(courseId) {
      const id = requireCourseId(courseId);
      if (!deps.chooseOpenFile) {
        throw new Error("Choosing a file is not available here.");
      }
      return deps.chooseOpenFile(existingAncestor(repoOf(id) ?? documents), "Choose a markdown file for the body", [
        { name: "Markdown", extensions: ["md", "markdown"] },
      ]);
    },

    async renderMarkdownBody(courseId, file) {
      const id = requireCourseId(courseId);
      return renderBody(requireText(file, "The markdown file"), repoOf(id));
    },

    async saveObject(request) {
      const courseId = requireCourseId(request?.courseId);
      const ctx = await editContext(courseId);
      return saveObject(ctx, request);
    },

    async setObjectPublished(target, published) {
      const { ctx, kind, id } = await editTarget(target);
      return setPublished(ctx, kind, id, published);
    },

    async deleteObject(target) {
      const { ctx, kind, id } = await editTarget(target);
      return deleteObject(ctx, kind, id);
    },

    async pushGroups() {
      return [...PUSH_GROUPS];
    },

    async previewPush(request) {
      const courseId = requireCourseId(request?.courseId);
      const repo = requireRepo(courseId);
      const checked = checkPushRequest(request, PUSH_GROUPS);
      // No client and no lock: a dry run renders from the repository and never
      // asks Canvas anything, so it needs no token and cannot collide with a job.
      const result = await courseCall(() =>
        push(null, { repo, courseId, dryRun: true, ...checked, ...jobCallbacks(emit, "push", courseId) }),
      );
      rendered.set(courseId, result.rendered);
      if (result.problems.length === 0) {
        previewed.add(pushKey(courseId, checked));
      }
      return toPushSummary(result);
    },

    async runPush(request) {
      const courseId = requireCourseId(request?.courseId);
      const repo = requireRepo(courseId);
      const checked = checkPushRequest(request, PUSH_GROUPS);
      // The page enables Publish only after a clean preview; this holds that
      // even for a page that skips the step.
      if (!previewed.has(pushKey(courseId, checked))) {
        throw new Error("Preview these exact options first, and check the result, before publishing to Canvas.");
      }
      return exclusive("push", async () => {
        const { client } = await connect();
        const result = await courseCall(() =>
          push(client, { repo, courseId, dryRun: false, ...checked, ...jobCallbacks(emit, "push", courseId) }),
        );
        rendered.set(courseId, result.rendered);
        return toPushSummary(result);
      });
    },

    async writePushPreview(courseId) {
      const id = requireCourseId(courseId);
      const bodies = rendered.get(id);
      if (!bodies || bodies.size === 0) {
        throw new Error("Preview first: there is no rendered HTML to write yet.");
      }
      if (!deps.chooseFolder || !deps.showItemInFolder) {
        throw new Error("Choosing a folder is not available here.");
      }
      const folder = await deps.chooseFolder(
        existingAncestor(path.join(documents, "edutools", "preview")),
        "Choose a folder for the HTML preview",
      );
      if (folder === null) {
        return null;
      }
      writePreview(bodies, folder);
      deps.showItemInFolder(folder);
      return folder;
    },

    async planCleanSync(courseId) {
      const id = requireCourseId(courseId);
      const repo = requireRepo(id);
      const confirmText = currentCourseCode(id);
      return exclusive("clean sync plan", async () => {
        const { client } = await connect();
        const plan = await courseCall(() => planClean(client, { repo, courseId: id, ...jobCallbacks(emit, "clean", id) }));
        cleanPlans.set(id, { plan, confirmText });
        return toCleanPlanView(plan, confirmText);
      });
    },

    async runCleanSync(request) {
      const id = requireCourseId(request?.courseId);
      const repo = requireRepo(id);
      const stored = cleanPlans.get(id);
      if (!stored) {
        throw new Error("Plan the clean sync first, and read what it would delete.");
      }
      if (stored.plan.refused.length > 0) {
        // No override: a course with student work in it is not a fresh copy.
        throw describeCourseError(new CleanRefusedError(stored.plan.refused));
      }
      if (typeof request.confirmText !== "string" || request.confirmText.trim() !== stored.confirmText) {
        throw new Error(`Type ${stored.confirmText} exactly to confirm the clean sync.`);
      }
      return exclusive("clean sync", async () => {
        // A plan is used once: after this run, what it listed is gone or changed.
        cleanPlans.delete(id);
        const { client } = await connect();
        const result = await courseCall(() =>
          push(client, {
            repo,
            courseId: id,
            dryRun: false,
            publish: request.publish === true,
            clean: stored.plan,
            verify: true,
            ...jobCallbacks(emit, "clean", id),
          }),
        );
        rendered.set(id, result.rendered);
        return toPushSummary(result);
      });
    },

    async verifyCourse(courseId) {
      const id = requireCourseId(courseId);
      const repo = requireRepo(id);
      return exclusive("verify", async () => {
        const { client } = await connect();
        return toVerifySummary(await courseCall(() => verifyCourseRun(client, { repo, courseId: id, ...jobCallbacks(emit, "verify", id) })));
      });
    },

    async auditCourse(courseId) {
      const id = requireCourseId(courseId);
      const repo = requireRepo(id);
      return exclusive("audit", async () => {
        const { client } = await connect();
        return toAuditSummary(await courseCall(() => auditCourseRun(client, { repo, courseId: id, ...jobCallbacks(emit, "audit", id) })));
      });
    },
  };
}

/** Run a course.ts call, rethrowing its errors in plain words. */
async function courseCall<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw describeCourseError(error);
  }
}

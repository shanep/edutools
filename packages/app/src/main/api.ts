/**
 * The main-process side of EdutoolsApi. Everything that touches the keychain or
 * Canvas happens here, never in the renderer.
 *
 * This module does not import electron, so tests build it with an in-memory secret
 * store and a fake Canvas client.
 */

import { existsSync, statSync } from "node:fs";
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
import { INDEX_NAME, KINDS, type PullCanvas } from "@edutools/core/pull";
import { toCourseRow } from "../shared/courses";
import type { CourseChoice, CurrentCourse, Emit, EdutoolsApi, SiteView, TestResult } from "../shared/ipc";
import { groupNames, toAssignmentGroupList, toAssignmentRow, toModuleRow, toPageRow } from "../shared/overview";
import { loadSettings, saveSettings } from "./settings";
import { checkKinds, defaultSnapshotFolder, runSnapshot } from "./snapshot";

/** The part of CanvasLMS the app uses: the course reads, and everything a pull calls. */
export type CanvasClient = PullCanvas & Pick<CanvasLMS, "getCourses" | "getCourse">;

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
  readonly chooseFolder?: (defaultPath: string) => Promise<string | null>;
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

  // Canvas throttles parallel work and charges a pre-flight penalty for it, and
  // two pulls into one folder would fight over its index.json. One at a time.
  let snapshotRunning = false;

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
      return deps.chooseFolder(existingAncestor(start));
    },

    async startSnapshot(request) {
      const courseId = requireCourseId(request?.courseId);
      const folder = requireFolder(request?.folder);
      const kinds = checkKinds(request?.kinds);
      if (snapshotRunning) {
        throw new Error("A snapshot is already running. Wait for it to finish before starting another.");
      }
      snapshotRunning = true;
      try {
        const { client } = await connect();
        return await runSnapshot(client, courseId, folder, kinds, (message) =>
          emit("snapshotProgress", { courseId, message }),
        );
      } finally {
        snapshotRunning = false;
      }
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
  };
}

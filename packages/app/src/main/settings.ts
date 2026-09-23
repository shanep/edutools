/**
 * The app's own preferences, next to the site list in the edutools config
 * directory. Nothing secret goes here: tokens stay in the keychain.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type CredentialOptions, configDir } from "@edutools/core/credentials";
import type { CurrentCourse } from "../shared/ipc";

export const SETTINGS_FILENAME = "app-settings.json";

export interface AppSettings {
  readonly currentCourse: CurrentCourse | null;
  /** Course repository folder per course, keyed by `repoKey`. */
  readonly repos: Readonly<Record<string, string>>;
}

const EMPTY: AppSettings = { currentCourse: null, repos: {} };

/**
 * Repositories are remembered per site and course: a course id means nothing on
 * another Canvas site, and one designer may keep a repo per course.
 */
export function repoKey(endpoint: string, courseId: string): string {
  return `${endpoint}#${courseId}`;
}

export function settingsPath(options: CredentialOptions): string {
  return path.join(configDir(options), SETTINGS_FILENAME);
}

function isCourse(value: unknown): value is CurrentCourse {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  // A non-null object from JSON.parse: reading its fields to check them.
  const c = value as Record<string, unknown>;
  return (
    typeof c.id === "string" && typeof c.name === "string" && typeof c.code === "string" && typeof c.endpoint === "string"
  );
}

/**
 * Read the settings. A missing or unreadable file is the defaults: losing a
 * remembered course is a small thing, and the app must still start.
 */
export function loadSettings(options: CredentialOptions): AppSettings {
  const file = settingsPath(options);
  if (!existsSync(file)) {
    return EMPTY;
  }
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return EMPTY;
  }
  if (typeof data !== "object" || data === null) {
    return EMPTY;
  }
  // Checked to be a non-null object just above.
  const record = data as Record<string, unknown>;
  const course = record.currentCourse;
  const rawRepos = record.repos;
  const repos: Record<string, string> = {};
  if (typeof rawRepos === "object" && rawRepos !== null && !Array.isArray(rawRepos)) {
    for (const [key, value] of Object.entries(rawRepos)) {
      if (typeof value === "string") {
        repos[key] = value;
      }
    }
  }
  return {
    currentCourse: isCourse(course)
      ? { id: course.id, name: course.name, code: course.code, endpoint: course.endpoint }
      : null,
    repos,
  };
}

/** Write through a temporary file, so a crash never leaves half a file. */
export function saveSettings(settings: AppSettings, options: CredentialOptions): void {
  const file = settingsPath(options);
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ version: 1, ...settings }, null, 2)}\n`, "utf8");
  renameSync(temp, file);
}

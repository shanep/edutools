/**
 * The Snapshot screen's pull: a thin layer over core's Puller that adds what the
 * app shows afterwards, a count of what landed for each kind.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { KINDS, type PullCanvas, type PullResult, Puller, type Reporter, safeComponent } from "@edutools/core/pull";
import type { KindCount, SnapshotSummary } from "../shared/ipc";

/** Kinds a pull writes as one JSON list rather than one file per object. */
const LIST_FILES: Readonly<Record<string, string>> = {
  modules: "modules.json",
  groups: "assignment_groups.json",
  rubrics: "rubrics.json",
};

/** The length of a JSON list the pull wrote, or 0 when it is missing or not a list. */
function listLength(file: string): number {
  try {
    const data: unknown = JSON.parse(readFileSync(file, "utf-8"));
    return Array.isArray(data) ? data.length : 0;
  } catch {
    return 0;
  }
}

/**
 * How many objects of each kind the snapshot holds. A kind that failed to list
 * keeps its previous copy, so this counts what is on disk, not what was fetched.
 */
export function countKinds(result: PullResult, kinds: readonly string[], out: string): KindCount[] {
  return kinds.map((kind) => {
    const entries = result.entries.filter((e) => e.kind === kind);
    const listFile = LIST_FILES[kind];
    if (listFile !== undefined) {
      return { kind, count: entries.length > 0 ? listLength(path.join(out, listFile)) : 0 };
    }
    if (kind === "files") {
      // The first files entry is folders.json and files.json, not a course file.
      return { kind, count: entries.filter((e) => e.ident !== "").length };
    }
    if (kind === "syllabus") {
      return { kind, count: entries.some((e) => e.paths.length > 0) ? 1 : 0 };
    }
    return { kind, count: entries.length };
  });
}

/** `~/Documents/edutools/<course code or id>`, as one legal folder name. */
export function defaultSnapshotFolder(documents: string, code: string, id: string): string {
  return path.join(documents, "edutools", safeComponent(code.trim() || id));
}

/** The kinds the renderer asked for, in pull order, refusing any the pull does not know. */
export function checkKinds(requested: unknown): string[] {
  if (!Array.isArray(requested) || requested.length === 0) {
    throw new Error("Choose at least one kind of content to snapshot.");
  }
  const unknown = requested.filter((k) => typeof k !== "string" || !KINDS.includes(k));
  if (unknown.length > 0) {
    throw new Error(`Unknown kind ${unknown.map(String).join(", ")}.`);
  }
  return KINDS.filter((k) => requested.includes(k));
}

export async function runSnapshot(
  canvas: PullCanvas,
  courseId: string,
  folder: string,
  kinds: readonly string[],
  report: Reporter,
): Promise<SnapshotSummary> {
  const puller = new Puller(canvas, courseId, folder, { kinds, report });
  const index = await puller.run();
  const result = puller.result;
  return {
    courseId,
    courseName: typeof index.course_name === "string" ? index.course_name : "",
    folder,
    counts: countKinds(result, puller.kinds, folder),
    downloaded: result.downloaded,
    unchanged: result.unchanged,
    removed: [...result.removed],
    problems: [...result.errors],
  };
}

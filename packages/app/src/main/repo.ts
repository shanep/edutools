/**
 * Everything the app reads from a course repository: whether canvas.toml loads,
 * the outline and schedule a push would produce, a markdown body rendered the
 * way a push renders it, and which object the manifest tracks. Nothing here
 * writes to the repository or talks to Canvas.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { crossCheckSyllabus, DateConfigError, type ItemDates, isoformat, loadConfig, validate } from "@edutools/core/dates";
import { type OutlineModule, outline, toJsonText } from "@edutools/core/outline";
import {
  assertNoForbiddenTags,
  decorate,
  Manifest,
  markTableRows,
  PublishError,
  renderMarkdown,
  ValueError,
  wrapTables,
} from "@edutools/core/publish";
import { Publisher } from "@edutools/core/publisher";
import type { DateTime } from "luxon";
import { parse as parseToml, TomlError } from "smol-toml";
import type { CourseSchedule, DateRow, EditKind, RenderedBody, RepoInfo } from "../shared/ipc";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A problem with the repository, in words a designer can act on. The core's
 * messages name the file and the field; this says which file and what to do.
 */
export function describeRepoError(error: unknown): string {
  if (error instanceof DateConfigError) {
    return `canvas.toml has a problem: ${error.message}. Fix it in the file, then choose Refresh.`;
  }
  if (error instanceof TomlError) {
    // smol-toml's message carries a multi-line code excerpt; the first line says what.
    const first = (error.message.split("\n")[0] ?? "").replace(/^Invalid TOML document:\s*/, "");
    return `canvas.toml is not valid TOML (line ${error.line}): ${first}. Fix it in the file, then choose Refresh.`;
  }
  if (error instanceof PublishError || error instanceof ValueError) {
    return `The repository has a problem: ${error.message}`;
  }
  return messageOf(error);
}

/** Check a folder is a course repository and describe it. Never throws. */
export function inspectRepo(folder: string): RepoInfo {
  if (!existsSync(path.join(folder, "canvas.toml"))) {
    return {
      path: folder,
      problem: "This folder has no canvas.toml, so it is not a course repository. Choose the folder that holds it.",
      weeks: null,
      timezone: null,
    };
  }
  try {
    const config = loadConfig(folder);
    return { path: folder, problem: null, weeks: config.term.weeks, timezone: config.term.timezone };
  } catch (error) {
    return { path: folder, problem: describeRepoError(error), weeks: null, timezone: null };
  }
}

/** Rethrow any repository failure in plain words. */
function plainly<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    throw new Error(describeRepoError(error));
  }
}

/** The `[[module]]` tables of canvas.toml, as the Python `outline` command reads them. */
function moduleTables(repo: string): unknown[] {
  const raw = parseToml(readFileSync(path.join(repo, "canvas.toml"), "utf8"));
  const modules = raw.module;
  return Array.isArray(modules) ? modules : [];
}

/** What `edutools outline` prints: the kinds come from the push's own plan. */
export function buildOutline(repo: string): OutlineModule[] {
  return plainly(() => {
    const publisher = new Publisher(repo, "", null, { report: () => {} });
    const kinds = Object.fromEntries(publisher.plan().map((p) => [p.key, p.kind]));
    return outline(repo, moduleTables(repo), kinds, Object.fromEntries(publisher.dates), publisher.config.term);
  });
}

/** The same modules, as `outline --out` writes them. */
export function outlineJsonText(repo: string): string {
  return `${toJsonText(buildOutline(repo))}\n`;
}

// strftime "%b %d %H:%M", as `edutools dates --show` prints each date, in the term's zone.
function show(stamp: DateTime | null): string {
  return stamp ? stamp.setLocale("en-US").toFormat("LLL dd HH:mm") : "-";
}

function toDateRow(item: ItemDates): DateRow {
  return {
    path: item.path,
    title: item.title,
    kind: item.kind,
    week: item.week,
    points: item.points,
    unlockAt: item.unlockAt ? isoformat(item.unlockAt) : null,
    dueAt: isoformat(item.dueAt),
    lockAt: isoformat(item.lockAt),
    unlockText: show(item.unlockAt),
    dueText: show(item.dueAt),
    lockText: show(item.lockAt),
  };
}

/** `edutools dates --show [--shift Nd]`: the schedule, then every problem found. */
export function buildSchedule(repo: string, shiftDays: number): CourseSchedule {
  return plainly(() => {
    const publisher = new Publisher(repo, "", null, { report: () => {} });
    const config = publisher.config;
    // compute's order, which the publisher keeps: by due date, then path.
    let items = [...publisher.dates.values()];
    if (shiftDays !== 0) {
      items = items.map((item) => item.shifted(shiftDays));
    }
    const problems = validate(items, config.term);
    const syllabus = path.join(repo, "syllabus.md");
    if (existsSync(syllabus)) {
      problems.push(...crossCheckSyllabus(syllabus, config.term));
    }
    return {
      repo,
      weeks: config.term.weeks,
      timezone: config.term.timezone,
      shiftDays,
      items: items.map(toDateRow),
      totalPoints: items.reduce((sum, item) => sum + item.points, 0),
      problems,
    };
  });
}

function isInside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * A markdown file as Canvas HTML. Inside the course repository it goes through
 * the push's own renderer, with the repo's canvas.css and heading icons, so a
 * hand edit matches what the next push would send. Elsewhere it gets the same
 * pipeline the CLI's --body-file uses, without the repo's styling.
 */
export function renderBody(file: string, repo: string | null): RenderedBody {
  if (!path.isAbsolute(file) || !/\.(md|markdown)$/i.test(file)) {
    throw new Error("Choose a markdown file (.md).");
  }
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new Error(`No such file: ${file}`);
  }
  return plainly(() => {
    if (repo && isInside(repo, file) && existsSync(path.join(repo, "canvas.toml"))) {
      const [title, html] = new Publisher(repo, "", null, { report: () => {} }).render(file);
      return { title, html };
    }
    const [title, rendered] = renderMarkdown(file, null);
    const html = wrapTables(markTableRows(decorate(rendered)));
    checkHtml(html);
    return { title, html };
  });
}

/** Canvas strips these silently and answers 200, so refuse them before sending. */
export function checkHtml(html: string): void {
  const forbidden = assertNoForbiddenTags(html);
  if (forbidden.length > 0) {
    throw new Error(`Canvas would silently remove ${forbidden.map((t) => `<${t}>`).join(", ")} from this body. Take it out first.`);
  }
}

/** The repo path the course's manifest tracks this object under, or null. */
export function managedBy(repo: string | null, courseId: string, kind: EditKind, id: string): string | null {
  if (!repo) {
    return null;
  }
  let manifest: Manifest;
  try {
    manifest = Manifest.forCourse(repo, courseId);
  } catch {
    // An unreadable manifest cannot say anything is tracked; the push will say more.
    return null;
  }
  for (const [key, entry] of manifest.entries) {
    if (entry.kind !== kind) {
      continue;
    }
    if (kind === "page" ? entry.pageUrl === id : entry.canvasId === id) {
      return key;
    }
  }
  return null;
}

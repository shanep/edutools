/**
 * The Publish, Verify and Audit screens' side of core's course.ts: shaping its
 * typed results for the page, and saying its errors in words a designer can act
 * on. course.ts does the work and keeps the rules (unpublished by default,
 * published content left alone, a clean sync refused on student work); this
 * module only presents them.
 */

import type { Difference } from "@edutools/core/audit";
import {
  type AuditResult,
  type CleanPlan,
  CleanFailedError,
  CleanRefusedError,
  CourseError,
  NothingToVerifyError,
  type Progress,
  type PushResult,
  UnmatchedPathError,
  type VerifyResult,
} from "@edutools/core/course";
import type {
  AuditSummary,
  CleanPlanView,
  CourseJob,
  DifferenceRow,
  Emit,
  PushRequest,
  PushSummary,
  VerifySummary,
} from "../shared/ipc";
import { stripMarkup } from "../shared/ipc";

export function toDifferenceRow(d: Difference): DifferenceRow {
  return { side: d.side, kind: d.kind, ident: d.ident, title: d.title, key: d.key, detail: d.detail };
}

export function toVerifySummary(result: VerifyResult): VerifySummary {
  return {
    checked: result.checked,
    drafts: [...result.drafts],
    failures: result.failures.map((f) => ({ key: f.key, check: f.check, detail: f.detail })),
  };
}

export function toPushSummary(result: PushResult): PushSummary {
  return {
    dryRun: result.dryRun,
    publish: result.publish,
    clean:
      result.clean === null
        ? null
        : { deleted: result.clean.deleted.map(toDifferenceRow), forgotten: result.clean.forgotten.map(toDifferenceRow) },
    drafts: [...result.drafts],
    orphanedDrafts: [...result.orphanedDrafts],
    selected: [...result.selected],
    created: result.created,
    updated: result.updated,
    skipped: result.skipped,
    problems: [...result.problems],
    unresolved: result.unresolved.map((u) => ({ key: u.key, link: u.link })),
    droppedCss: [...result.droppedCss],
    unlisted: [...result.unlisted],
    protected: [...result.protected],
    rendered: result.rendered.size,
    verify: result.verify === null ? null : toVerifySummary(result.verify),
  };
}

export function toCleanPlanView(plan: CleanPlan, confirmText: string): CleanPlanView {
  return {
    courseId: plan.courseId,
    targets: plan.targets.map(toDifferenceRow),
    stale: plan.stale.map(toDifferenceRow),
    kept: plan.kept,
    refused: plan.refused.map((r) => ({ target: toDifferenceRow(r.target), reason: r.reason })),
    confirmText,
  };
}

export function toAuditSummary(result: AuditResult): AuditSummary {
  return { tracked: result.tracked, differences: result.differences.map(toDifferenceRow) };
}

function named(d: { readonly kind: string; readonly title: string; readonly ident: string }): string {
  return `${d.kind} "${d.title || d.ident}"`;
}

/**
 * Core's course errors in plain words. Only the message crosses IPC, so
 * everything the designer needs (what was refused and why, what was already
 * deleted) is written into it here.
 */
export function describeCourseError(error: unknown): Error {
  if (error instanceof CleanFailedError) {
    const gone = error.deleted.length > 0 ? error.deleted.map(named).join(", ") : "nothing";
    return new Error(
      `The clean sync stopped: it could not delete ${named(error.target)} (${error.message}). ` +
        `Already deleted before it stopped: ${gone}. Nothing was pushed. Plan the clean sync again to see what is left.`,
    );
  }
  if (error instanceof CleanRefusedError) {
    const reasons = error.refused.map((r) => `${named(r.target)} ${r.reason}`).join("; ");
    return new Error(`The clean sync will not run, because students have used this course: ${reasons}. Nothing was deleted.`);
  }
  if (error instanceof NothingToVerifyError) {
    return new Error(
      "Nothing has been published from this repository to this course yet, so there is nothing to verify. Publish first.",
    );
  }
  if (error instanceof UnmatchedPathError) {
    const some = error.available.slice(0, 15).join(", ");
    return new Error(
      `No file in the repository matches ${error.missed.join(", ")}. ` +
        `Check the spelling; files it can match include ${some}${error.available.length > 15 ? ", ..." : ""}.`,
    );
  }
  if (error instanceof CourseError) {
    return new Error(`The repository has a problem: ${error.message}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

/** Core's two callbacks, sent to the page as jobProgress events. */
export function jobCallbacks(emit: Emit, job: CourseJob, courseId: string) {
  return {
    report: (line: string) => {
      const { text, dim } = stripMarkup(line);
      emit("jobProgress", { job, courseId, kind: "report", message: text, dim, done: null, total: null });
    },
    progress: (p: Progress) =>
      emit("jobProgress", {
        job,
        courseId,
        kind: "progress",
        message: p.message,
        dim: false,
        done: p.done ?? null,
        total: p.total ?? null,
      }),
  };
}

/** The renderer's push options, checked. */
export function checkPushRequest(request: unknown, groups: readonly string[]): Omit<PushRequest, "courseId"> {
  if (typeof request !== "object" || request === null) {
    throw new Error("Say what to publish.");
  }
  // A non-null object from the renderer: each field is checked below.
  const r = request as Record<string, unknown>;
  const list = (value: unknown, what: string): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
      throw new Error(`${what} must be a list of names.`);
    }
    return value.map((v: string) => v.trim()).filter((v) => v !== "");
  };
  const only = list(r.only, "The groups");
  const unknown = only.filter((g) => !groups.includes(g));
  if (unknown.length > 0) {
    throw new Error(`Unknown group ${unknown.join(", ")}; expected ${groups.join(", ")}.`);
  }
  return {
    publish: r.publish === true,
    updatePublished: r.updatePublished === true,
    only,
    paths: list(r.paths, "The file filter"),
    verify: r.verify !== false,
  };
}

/** Two requests are the same push when every option matches. */
export function pushKey(courseId: string, options: Omit<PushRequest, "courseId">): string {
  return JSON.stringify([
    courseId,
    options.publish,
    options.updatePublished,
    [...options.only].sort(),
    [...options.paths].sort(),
  ]);
}

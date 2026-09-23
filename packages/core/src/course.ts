/**
 * Whole-course operations on a course repository: push, verify, audit, the
 * start-of-term clean sync, and the repo-only outline and dates.
 *
 * This is the orchestration the Python cli.py did inline, moved here so the CLI
 * and the desktop app run the same sequence. Nothing in this module prints or
 * prompts. Progress goes to a callback, everything worth showing comes back in a
 * typed result, and a step that needs a human's yes (deleting objects in a clean
 * sync) is split in two: `planClean` says what would go, and `executeClean`, or a
 * `push` handed that plan, does it once the caller has asked.
 *
 * The rules that make a push safe on a live course hold here, not in a caller:
 * published content is left alone unless `updatePublished` is set (Publisher
 * enforces it); a clean sync refuses outright when anything it would delete holds
 * student work, and checks again right before deleting; and every Canvas call is
 * awaited one at a time, because Canvas throttles parallel requests.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import {
  auditModules,
  auditObjects,
  cleanKeep,
  cleanTargets,
  type DeclaredModule,
  type Difference,
  declaredModules,
  kindIdent,
  liveAssignments,
  liveDiscussions,
  liveFiles,
  liveModules,
  livePages,
  liveQuizzes,
  studentWork,
} from "./audit";
import type { CanvasLMS } from "./canvas";
import {
  compute,
  type DateConfig,
  DateConfigError,
  type ItemDates,
  loadConfig,
  crossCheckSyllabus,
  validate,
} from "./dates";
import { type OutlineModule, outline } from "./outline";
import { fnmatch } from "./paths";
import { type Entry, Manifest, PublishError, parseQuiz, rewriteLinks, ValueError } from "./publish";
import { type Plan, Publisher, type PublisherCanvas, type Reporter } from "./publisher";
import type { Payload } from "./types";
import {
  checkBody,
  checkFile,
  checkGradebookTotal,
  checkIdentity,
  checkLinks,
  checkModuleMembership,
  checkQuizQuestions,
  type Failure,
  knownLinkTargets,
} from "./verify";

export type { Reporter } from "./publisher";

/** Everything a push, verify, audit or clean sync asks of Canvas. */
export type CourseCanvas = PublisherCanvas &
  Pick<
    CanvasLMS,
    | "listPages"
    | "getPage"
    | "getAssignments"
    | "getAssignmentFull"
    | "listDiscussions"
    | "getDiscussion"
    | "listQuizzes"
    | "getQuiz"
    | "listFiles"
    | "getFile"
    | "listJson"
    | "getObject"
    | "deleteObject"
  >;

/** Where a long run is up to. Each call replaces the last; none is worth keeping. */
export interface Progress {
  readonly message: string;
  /** Items finished and the total, when the step has a count. */
  readonly done?: number;
  readonly total?: number;
}

export type ProgressReporter = (progress: Progress) => void;

export interface Callbacks {
  /**
   * A line worth keeping on screen as it happens. Publisher's own notes arrive
   * here (the groups a dry run would write), in Rich-style markup such as
   * `[dim]...[/dim]`, which a caller renders or strips.
   */
  readonly report?: Reporter;
  readonly progress?: ProgressReporter;
}

/** A course repository problem that stops an operation before it writes anything. */
export class CourseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CourseError";
  }
}

/** A --path pattern that matches nothing: a typo, which would otherwise look like success. */
export class UnmatchedPathError extends CourseError {
  readonly missed: readonly string[];
  readonly available: readonly string[];

  constructor(missed: readonly string[], available: readonly string[]) {
    super(`no file in the repo matches: ${missed.join(", ")}`);
    this.name = "UnmatchedPathError";
    this.missed = missed;
    this.available = available;
  }
}

/** Python's `<` on two strings, by code point, which is how sorted() ordered keys. */
function compare(a: string, b: string): number {
  if (a === b) return 0;
  const x = Array.from(a, (c) => c.codePointAt(0) as number);
  const y = Array.from(b, (c) => c.codePointAt(0) as number);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number);
  }
  return x.length - y.length;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readToml(repo: string): Payload {
  return parseToml(readFileSync(path.join(repo, "canvas.toml"), "utf-8"));
}

/**
 * Build a Publisher, turning the ways a repository can be malformed into one
 * CourseError, which is what the CLI reports and exits 1 on.
 */
function openRepo(repo: string, courseId: string, canvas: PublisherCanvas | null, options: ConstructorParameters<typeof Publisher>[3] = {}): Publisher {
  try {
    return new Publisher(repo, courseId, canvas, options);
  } catch (error) {
    if (error instanceof PublishError || error instanceof ValueError || error instanceof DateConfigError) {
      throw new CourseError(error.message);
    }
    throw error;
  }
}

function planOf(publisher: Publisher): Plan[] {
  try {
    return publisher.plan();
  } catch (error) {
    if (error instanceof PublishError || error instanceof ValueError || error instanceof DateConfigError) {
      throw new CourseError(error.message);
    }
    throw error;
  }
}

// ============================================================================
// Reading the whole course, for audit and the clean sync
// ============================================================================

export interface CourseDifferences {
  readonly differences: Difference[];
  readonly declared: DeclaredModule[];
  /** The parsed canvas.toml. */
  readonly raw: Payload;
}

/**
 * Read the whole course and compare it with the manifest, both ways.
 *
 * Shared by `auditCourse`, which reports the differences, and `planClean`,
 * which deletes the untracked ones.
 */
export async function readDifferences(
  canvas: CourseCanvas,
  publisher: Publisher,
  callbacks: Callbacks = {},
): Promise<CourseDifferences> {
  const progress = callbacks.progress ?? (() => {});
  const course = publisher.courseId;
  const manifest = publisher.manifest;
  const drafts = new Set([...manifest.entries.keys()].filter((key) => publisher.isDraftKey(key)));
  const raw = readToml(publisher.repo);
  const declared = declaredModules(raw, publisher.config.term);

  progress({ message: "Reading pages" });
  const live = livePages(await canvas.listPages(course));
  progress({ message: "Reading assignments" });
  live.push(...liveAssignments(await canvas.getAssignments(course)));
  progress({ message: "Reading discussions" });
  live.push(...liveDiscussions(await canvas.listDiscussions(course)));
  progress({ message: "Reading quizzes" });
  live.push(...liveQuizzes(await canvas.listQuizzes(course)));
  progress({ message: "Reading files" });
  live.push(...liveFiles(await canvas.listFiles(course)));
  progress({ message: "Reading modules" });
  const stored = await canvas.listModules(course);
  const items: Record<string, Payload[]> = {};
  for (const module of stored) {
    const id = String(module.id ?? "");
    items[id] = await canvas.listModuleItems(course, id);
  }
  const modules = liveModules(stored, items);

  const differences = [
    ...auditObjects(manifest, live, drafts),
    ...auditModules(declared, modules, items, manifest),
  ];
  return { differences, declared, raw };
}

// ============================================================================
// audit
// ============================================================================

export interface AuditOptions extends Callbacks {
  readonly repo: string;
  readonly courseId: string;
}

export interface AuditResult {
  readonly differences: readonly Difference[];
  /** How many objects the manifest tracks. */
  readonly tracked: number;
  /** The differences that fail an audit: the manifest points at something Canvas no longer has. */
  readonly stale: readonly Difference[];
}

/**
 * Compare the manifest with what the course actually contains, both ways.
 *
 * verify proves that every tracked object is still there and intact. This is
 * the other question: what is in Canvas that the repo did not put there, and
 * what does the manifest still track that Canvas no longer has. Only the second
 * kind is a failure, because a hand-built exam quiz is expected and a manifest
 * pointing at nothing is not.
 */
export async function auditCourse(canvas: CourseCanvas, options: AuditOptions): Promise<AuditResult> {
  const publisher = openRepo(options.repo, options.courseId, canvas);
  const { differences } = await readDifferences(canvas, publisher, options);
  return {
    differences,
    tracked: publisher.manifest.entries.size,
    stale: differences.filter((d) => d.side === "stale"),
  };
}

// ============================================================================
// The clean sync
// ============================================================================

export interface CleanRefusal {
  readonly target: Difference;
  /** Why it holds student work, e.g. "has submissions" or "has 3 post(s)". */
  readonly reason: string;
}

/** What a clean sync would do. Nothing has been deleted when this exists. */
export interface CleanPlan {
  readonly repo: string;
  readonly courseId: string;
  /** Untracked objects to delete, modules last. */
  readonly targets: readonly Difference[];
  /** Manifest entries pointing at objects Canvas no longer has, to forget. */
  readonly stale: readonly Difference[];
  /** How many objects are kept by name: native module items, `[clean] keep`, and the front page. */
  readonly kept: number;
  /** Targets holding student work. Any at all and the clean sync will not run. */
  readonly refused: readonly CleanRefusal[];
}

export interface CleanOutcome {
  readonly deleted: readonly Difference[];
  readonly forgotten: readonly Difference[];
}

/** A clean sync that must not run, because something it would delete holds student work. */
export class CleanRefusedError extends CourseError {
  readonly refused: readonly CleanRefusal[];

  constructor(refused: readonly CleanRefusal[]) {
    super(
      "A clean sync is for a course nobody has used yet. Delete or keep those " +
        "by hand (add them to [clean] keep), then run it again.",
    );
    this.name = "CleanRefusedError";
    this.refused = refused;
  }
}

/** A delete that failed part-way through a clean sync; what went before it is gone. */
export class CleanFailedError extends CourseError {
  readonly target: Difference;
  readonly deleted: readonly Difference[];

  constructor(target: Difference, deleted: readonly Difference[], cause: string) {
    super(`could not delete ${target.kind} ${target.ident}: ${cause}`);
    this.name = "CleanFailedError";
    this.target = target;
    this.deleted = deleted;
  }
}

/** Every target that holds student work, read fresh from Canvas, one at a time. */
async function studentWorkIn(
  canvas: CourseCanvas,
  courseId: string,
  targets: readonly Difference[],
): Promise<CleanRefusal[]> {
  const refused: CleanRefusal[] = [];
  for (const target of targets) {
    if (!["assignment", "discussion", "quiz"].includes(target.kind)) continue;
    const stored = await canvas.getObject(target.kind, courseId, target.ident);
    const assignmentId = stored.assignment_id;
    const assignment =
      assignmentId !== null && assignmentId !== undefined && assignmentId !== ""
        ? await canvas.getAssignmentFull(courseId, String(assignmentId))
        : null;
    const reason = studentWork(target.kind, stored, assignment);
    if (reason) refused.push({ target, reason });
  }
  return refused;
}

/**
 * What a start-of-term clean sync would delete. Reads only.
 *
 * Never touches files, anything a [[module]] names as a native item, anything
 * under `[clean] keep`, or the course front page. Anything it would delete that
 * holds student work lands in `refused`, and a plan with refusals cannot run.
 */
export async function planClean(
  canvas: CourseCanvas,
  options: AuditOptions,
): Promise<CleanPlan> {
  const publisher = openRepo(options.repo, options.courseId, canvas, { updatePublished: true });
  planOf(publisher);
  const courseId = options.courseId;
  const { differences, declared, raw } = await readDifferences(canvas, publisher, options);
  let keep: Set<string>;
  try {
    keep = cleanKeep(raw, declared);
  } catch (error) {
    if (error instanceof ValueError) throw new CourseError(error.message);
    throw error;
  }
  try {
    const front = await canvas.getJson(`/api/v1/courses/${courseId}/front_page`);
    keep.add(kindIdent("page", String(front.url ?? "")));
  } catch {
    // no front page set
  }

  const targets = cleanTargets(differences, keep);
  options.progress?.({ message: "Checking for student work" });
  return {
    repo: publisher.repo,
    courseId,
    targets,
    stale: differences.filter((d) => d.side === "stale"),
    kept: keep.size,
    refused: await studentWorkIn(canvas, courseId, targets),
  };
}

/**
 * Carry out a clean plan: delete its targets, then forget its stale entries.
 *
 * Refuses a plan with refusals, and reads every graded target again before
 * deleting anything, since time passes between showing a plan and a yes and a
 * student may have submitted in between. Deletes one at a time, and stops at
 * the first failure without forgetting anything.
 */
export async function executeClean(
  canvas: CourseCanvas,
  plan: CleanPlan,
  callbacks: Callbacks = {},
): Promise<CleanOutcome> {
  if (plan.refused.length > 0) throw new CleanRefusedError(plan.refused);
  const refused = await studentWorkIn(canvas, plan.courseId, plan.targets);
  if (refused.length > 0) throw new CleanRefusedError(refused);

  const deleted: Difference[] = [];
  for (const target of plan.targets) {
    callbacks.progress?.({
      message: `Deleting ${target.kind} ${target.title}`,
      done: deleted.length,
      total: plan.targets.length,
    });
    try {
      await canvas.deleteObject(target.kind, plan.courseId, target.ident);
    } catch (error) {
      throw new CleanFailedError(target, deleted, messageOf(error));
    }
    deleted.push(target);
  }
  const manifest = Manifest.forCourse(plan.repo, plan.courseId);
  for (const entry of plan.stale) manifest.drop(entry.key);
  return { deleted, forgotten: [...plan.stale] };
}

// ============================================================================
// verify
// ============================================================================

export interface VerifyResult {
  /** Objects read back: every manifest entry except drafts. */
  readonly checked: number;
  /** Manifest entries not verified because their file is now a draft. */
  readonly drafts: readonly string[];
  readonly failures: readonly Failure[];
}

/** Verify was asked of a course the repo has never been pushed to. */
export class NothingToVerifyError extends CourseError {
  constructor() {
    super("Nothing in the manifest for this course, push first.");
    this.name = "NothingToVerifyError";
  }
}

/** Read one tracked object back, with the body verify compares; null skips the kind. */
async function readBack(
  canvas: CourseCanvas,
  courseId: string,
  entry: Entry,
): Promise<[Payload, string] | null> {
  const text = (value: unknown): string => (value === null || value === undefined ? "" : String(value));
  switch (entry.kind) {
    case "page": {
      const stored = await canvas.getPage(courseId, entry.pageUrl);
      return [stored, text(stored.body)];
    }
    case "assignment": {
      const stored = await canvas.getAssignmentFull(courseId, entry.canvasId);
      return [stored, text(stored.description)];
    }
    case "discussion": {
      const stored = await canvas.getDiscussion(courseId, entry.canvasId);
      return [stored, text(stored.message)];
    }
    case "quiz": {
      const stored = await canvas.getQuiz(courseId, entry.canvasId);
      return [stored, text(stored.description)];
    }
    case "file":
      return [await canvas.getFile(entry.canvasId), ""];
    default:
      return null;
  }
}

/**
 * Read every published object back from Canvas and prove it arrived intact.
 *
 * Catches what a 200 response does not: silent sanitiser stripping, partial
 * quiz writes, files stuck pending, and drift from someone editing in the
 * Canvas UI. Reads only.
 */
export async function verifyCourse(canvas: CourseCanvas, options: AuditOptions): Promise<VerifyResult> {
  const courseId = options.courseId;
  const publisher = openRepo(options.repo, courseId, canvas);
  const plans = new Map(planOf(publisher).map((p) => [p.key, p]));
  const manifest = publisher.manifest;
  if (manifest.entries.size === 0) throw new NothingToVerifyError();

  const drafts = [...manifest.entries.keys()].filter((key) => publisher.isDraftKey(key)).sort(compare);
  const skip = new Set(drafts);
  const failures: Failure[] = [];
  const known = knownLinkTargets(manifest, courseId);
  const resolves = (link: string): Promise<boolean> => canvas.exists(`/api/v1${link}`);
  const total = manifest.entries.size - drafts.length;
  let done = 0;

  const ordered = [...manifest.entries.entries()].sort(([a], [b]) => compare(a, b));
  for (const [key, entry] of ordered) {
    if (skip.has(key)) continue;
    options.progress?.({ message: `Verifying ${key}`, done, total });
    done += 1;
    const plan = plans.get(key);

    let read: [Payload, string] | null;
    try {
      read = await readBack(canvas, courseId, entry);
    } catch {
      failures.push(...checkIdentity(key, entry, null));
      continue;
    }
    if (read === null) continue;
    const [stored, body] = read;

    failures.push(...checkIdentity(key, entry, stored));
    if (publisher.neverPublished.has(key) && stored.published) {
      failures.push({
        key,
        check: "visibility",
        detail: "published, but its module is never_publish; the next push unpublishes it",
      });
    }

    const source = plan?.source ?? null;
    if (entry.kind === "file" && source !== null) {
      failures.push(...checkFile(key, statSync(source).size, stored));
    } else if (source !== null) {
      try {
        let intended = publisher.rendered.get(key);
        if (intended === undefined) {
          const [, html] = publisher.render(source);
          [intended] = rewriteLinks(html, source, publisher.repo, manifest, courseId);
        }
        failures.push(...checkBody(key, intended, body));
        failures.push(...(await checkLinks(key, body, courseId, known, resolves)));
      } catch (error) {
        // Report it, do not abort the sweep.
        failures.push({ key, check: "render", detail: messageOf(error) });
      }
    }

    if (entry.kind === "quiz" && source !== null) {
      const expected = parseQuiz(source).length;
      const questions = await canvas.listQuizQuestions(courseId, entry.canvasId);
      failures.push(...checkQuizQuestions(key, expected, questions));
    }
  }

  const assignments = await canvas.listJson(`/api/v1/courses/${courseId}/assignments`);
  const published = assignments.filter((a) => a.published);
  const expectedTotal = publisher.config.term.totalPoints;
  if (published.length > 0 && expectedTotal) {
    failures.push(...checkGradebookTotal(published, expectedTotal));
  }

  failures.push(...checkModuleMembership(publisher.unlisted(plans.values())));
  return { checked: total, drafts, failures };
}

// ============================================================================
// push
// ============================================================================

/** The --only group each plan kind belongs to. */
const KIND_GROUP: Readonly<Record<string, string>> = {
  page: "pages",
  assignment: "assignments",
  discussion: "discussions",
  quiz: "quizzes",
  file: "files",
  syllabus: "syllabus",
};

/** What --only accepts. */
export const PUSH_GROUPS: readonly string[] = [
  "pages",
  "assignments",
  "discussions",
  "quizzes",
  "files",
  "modules",
  "syllabus",
  "rubrics",
  "groups",
];

export interface PushOptions extends Callbacks {
  readonly repo: string;
  readonly courseId: string;
  /** Render everything, write nothing. Needs no client. */
  readonly dryRun?: boolean;
  /** Make objects student-visible; without it, new objects are unpublished. */
  readonly publish?: boolean;
  /** Also rewrite content students can already see. */
  readonly updatePublished?: boolean;
  /** Limit to these groups (PUSH_GROUPS). */
  readonly only?: readonly string[];
  /** Limit to these repo files, exact or glob. Skips the module rebuild. */
  readonly paths?: readonly string[];
  /** Read everything back afterwards. Default true; never on a dry run or a push with problems. */
  readonly verify?: boolean;
  /**
   * A clean plan the caller has shown and had approved. It is carried out
   * before anything is written, and the push then rewrites everything,
   * published content included: the course is about to start, so nothing in
   * it is being read yet. Refused with --only or --path.
   */
  readonly clean?: CleanPlan | null;
}

export interface UnresolvedLink {
  readonly key: string;
  readonly link: string;
}

export interface PushResult {
  readonly dryRun: boolean;
  readonly publish: boolean;
  /** What the clean sync did, when the push carried one out. */
  readonly clean: CleanOutcome | null;
  /** Repo files marked `draft: true`, not pushed. */
  readonly drafts: readonly string[];
  /** Files that became drafts after being pushed: forgotten, their Canvas objects left for a human. */
  readonly orphanedDrafts: readonly string[];
  /** The repo keys this push covered, after --only and --path. */
  readonly selected: readonly string[];
  readonly created: number;
  readonly updated: number;
  readonly skipped: number;
  /** Everything that went wrong, as the CLI lists it; non-empty means the push failed. */
  readonly problems: readonly string[];
  readonly unresolved: readonly UnresolvedLink[];
  /** CSS properties canvas.css uses that Canvas would strip. */
  readonly droppedCss: readonly string[];
  /** Gradable items among `selected` that no [[module]] places. */
  readonly unlisted: readonly string[];
  /** Published objects left untouched, which --update-published would overwrite. */
  readonly protected: readonly string[];
  /** Rendered HTML by repo key, for a preview. */
  readonly rendered: ReadonlyMap<string, string>;
  /** The read-back that follows a clean push, or null when it did not run. */
  readonly verify: VerifyResult | null;
}

/**
 * Publish a course repository to Canvas.
 *
 * Two passes: create or update every object, then rewrite relative links now
 * that ids exist. Everything is created UNPUBLISHED unless `publish` is set, and
 * anything already published is left alone unless `updatePublished` is, because
 * rewriting what a class is part-way through reading is worse than leaving it
 * stale.
 *
 * `paths` pushes one correction rather than the whole course. It runs the same
 * pipeline, so dates, links, rubric and styling all still come from the
 * repository; the whole-course module rebuild is skipped, since that is a
 * structural change rather than a correction.
 */
export async function push(canvas: CourseCanvas | null, options: PushOptions): Promise<PushResult> {
  const dryRun = options.dryRun ?? false;
  const only = options.only ?? [];
  const patterns = options.paths ?? [];
  const clean = options.clean ?? null;
  const progress = options.progress ?? (() => {});

  if (clean !== null && (only.length > 0 || patterns.length > 0)) {
    throw new CourseError("--clean syncs the whole course; it cannot be combined with --only or --path");
  }
  if (!dryRun && canvas === null) throw new CourseError("a push that writes needs a Canvas client");
  if (clean !== null && (clean.repo !== path.resolve(options.repo) || clean.courseId !== options.courseId)) {
    throw new CourseError("the clean plan is for a different repository or course");
  }

  let cleaned: CleanOutcome | null = null;
  if (clean !== null && !dryRun && canvas !== null && (clean.targets.length > 0 || clean.stale.length > 0)) {
    // Planned once more before the clean sync deletes anything, so a repo
    // broken since the plan was made stops the push while the course is intact.
    planOf(openRepo(options.repo, options.courseId, null, { dryRun: true, report: () => {} }));
    cleaned = await executeClean(canvas, clean, options);
  }

  const publisher = openRepo(options.repo, options.courseId, dryRun ? null : canvas, {
    publish: options.publish ?? false,
    dryRun,
    updatePublished: (options.updatePublished ?? false) || clean !== null,
    report: options.report ?? (() => {}),
  });
  const plans = planOf(publisher);
  const drafts = [...publisher.drafts].sort(compare);
  // A file that was pushed before it became a draft still has an object in
  // Canvas. Forgetting it here is what stops verify reporting it, but the
  // object itself is left alone because it may already have submissions.
  const orphanedDrafts = dryRun ? [] : publisher.pruneDrafts();

  const wanted = new Set(only);
  let selected = plans.filter((p) => wanted.size === 0 || wanted.has(KIND_GROUP[p.kind] ?? ""));
  if (patterns.length > 0) {
    const hits = (pattern: string): string[] => selected.filter((p) => fnmatch(p.key, pattern)).map((p) => p.key);
    // A pattern that matches nothing is a typo, and silently pushing zero
    // objects looks exactly like a successful push.
    const missed = patterns.filter((pattern) => hits(pattern).length === 0);
    if (missed.length > 0) {
      throw new UnmatchedPathError(missed, selected.map((p) => p.key).sort(compare));
    }
    const chosen = new Set(patterns.flatMap(hits));
    selected = selected.filter((p) => chosen.has(p.key));
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const problems: string[] = [];
  const unresolved: UnresolvedLink[] = [];

  // Groups first: every assignment, quiz and graded discussion below is filed
  // into one, so the ids have to exist before the objects do. A --path push
  // reaches the same sync lazily, through the item that needs it.
  if (wanted.size === 0 || wanted.has("groups")) {
    try {
      const outcome = await publisher.syncGroups();
      created += outcome.created;
      updated += outcome.updated;
      skipped += outcome.skipped;
    } catch (error) {
      problems.push(`assignment groups: ${messageOf(error)}`);
    }
  }

  const label = dryRun ? "Rendering" : "Publishing";
  let done = 0;
  for (const item of selected) {
    progress({ message: `${label} ${item.key}`, done, total: selected.length });
    try {
      const outcome = await publisher.createOrUpdate(item);
      created += outcome.created;
      updated += outcome.updated;
      skipped += outcome.skipped;
      problems.push(...outcome.errors);
    } catch (error) {
      problems.push(`${item.key}: ${messageOf(error)}`);
    }
    done += 1;
  }

  if (!dryRun) {
    done = 0;
    for (const item of selected) {
      progress({ message: `Rewriting links in ${item.key}`, done, total: selected.length });
      try {
        for (const link of await publisher.rewrite(item)) {
          unresolved.push({ key: item.key, link });
          problems.push(`${item.key}: unresolved link ${link}`);
        }
      } catch (error) {
        problems.push(`${item.key}: ${messageOf(error)}`);
      }
      done += 1;
    }
  }

  const droppedCss = [...publisher.droppedCss].sort(compare);
  if (droppedCss.length > 0) problems.push("canvas.css contains properties Canvas will not store");

  if (wanted.has("modules") || (wanted.size === 0 && patterns.length === 0)) {
    progress({ message: "Building modules" });
    try {
      const outcome = await publisher.pushModules();
      created += outcome.created;
      updated += outcome.updated;
      problems.push(...outcome.errors);
    } catch (error) {
      problems.push(`modules: ${messageOf(error)}`);
    }
  }

  if (wanted.has("rubrics") || patterns.length > 0) {
    progress({ message: "Attaching rubrics" });
    try {
      const outcome = await publisher.pushRubrics(patterns.length > 0 ? new Set(selected.map((p) => p.key)) : null);
      created += outcome.created;
      problems.push(...outcome.errors);
    } catch (error) {
      problems.push(`rubrics: ${messageOf(error)}`);
    }
  }

  // Over `selected` rather than every plan: a full push names every orphan, a
  // --path push names only the file just pushed, --only pages says nothing.
  const unlisted = publisher.unlisted(selected);

  let verify: VerifyResult | null = null;
  if (!dryRun && problems.length === 0 && (options.verify ?? true) && canvas !== null) {
    verify = await verifyCourse(canvas, options);
  }

  return {
    dryRun,
    publish: options.publish ?? false,
    clean: cleaned,
    drafts,
    orphanedDrafts,
    selected: selected.map((p) => p.key),
    created,
    updated,
    skipped,
    problems,
    unresolved,
    droppedCss,
    unlisted,
    protected: [...publisher.protected].sort(compare),
    rendered: publisher.rendered,
    verify,
  };
}

/**
 * Write each rendered body to `dir` as a standalone page to open in a browser.
 * Returns how many were written.
 */
export function writePreview(rendered: ReadonlyMap<string, string>, dir: string): number {
  mkdirSync(dir, { recursive: true });
  let written = 0;
  for (const [key, html] of rendered) {
    const name = key.replaceAll("/", "__").replaceAll(".md", ".html");
    writeFileSync(
      path.join(dir, name),
      "<!doctype html><meta charset=utf-8>" +
        "<div style='max-width:900px;margin:40px auto;font-family:system-ui'>" +
        `<h1>${key}</h1>${html}</div>`,
      "utf-8",
    );
    written += 1;
  }
  return written;
}

// ============================================================================
// From the repo alone: outline and dates
// ============================================================================

/**
 * The module outline a push will build, computed from the repo alone: the same
 * modules, the same items in the same order, with the due date and points of
 * each gradable one. Needs no Canvas client.
 */
export function courseOutline(repo: string): OutlineModule[] {
  const publisher = openRepo(repo, "", null, { report: () => {} });
  const raw = readToml(publisher.repo);
  const modules = Array.isArray(raw.module) ? raw.module : [];
  const kinds: Record<string, string> = {};
  for (const plan of planOf(publisher)) kinds[plan.key] = plan.kind;
  const dates: Record<string, ItemDates> = Object.fromEntries(publisher.dates);
  return outline(publisher.repo, modules, kinds, dates, publisher.config.term);
}

export interface CourseDates {
  readonly config: DateConfig;
  readonly items: readonly ItemDates[];
  /** Schedule problems, and disagreements with syllabus.md when there is one. */
  readonly problems: readonly string[];
}

/**
 * Every due, available-from and until date for the course, from canvas.toml
 * alone, optionally with the whole term shifted by `shiftDays`. Throws
 * DateConfigError for a malformed configuration.
 */
export function courseDates(repo: string, options: { shiftDays?: number } = {}): CourseDates {
  const config = loadConfig(repo);
  let items = compute(repo, config);
  const shift = options.shiftDays ?? 0;
  if (shift !== 0) items = items.map((item) => item.shifted(shift));
  const problems = validate(items, config.term);
  const syllabus = path.join(repo, "syllabus.md");
  try {
    if (statSync(syllabus).isFile()) problems.push(...crossCheckSyllabus(syllabus, config.term));
  } catch {
    // no syllabus.md to check against
  }
  return { config, items, problems };
}

/**
 * Drive a whole course repository into Canvas, then check it landed.
 *
 * Two passes, because links need ids that do not exist until objects are created:
 * pass one creates or updates every object and records it in the manifest; pass two
 * rewrites relative links against that manifest and updates the bodies.
 *
 * Every Canvas call here is awaited one at a time, never gathered with
 * Promise.all: Canvas throttles with 429 and charges a pre-flight penalty for
 * parallel requests, so the writes are sequential on purpose.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { asNumber, CanvasApiError, type CanvasLMS } from "./canvas";
import {
  compute,
  type DateConfig,
  DateConfigError,
  type Group,
  type ItemDates,
  isoformat,
  loadConfig,
  moduleTitle,
} from "./dates";
import { pyRepr } from "./objects";
import { globRepo, isFile, repoKey } from "./paths";
import {
  addHeadingIcons,
  assertNoForbiddenTags,
  assignmentOptions,
  canvasPath,
  decorate,
  Entry,
  formatG,
  inlineCss,
  Manifest,
  markTableRows,
  moduleEntries,
  moduleKeys,
  type NativeKind,
  PublishError,
  parseNativeItems,
  parseQuiz,
  attachedRubric,
  parseRubric,
  pathIsDraft,
  questionFields,
  renderMarkdown,
  rewriteLinks,
  rubricFields,
  sameCriteria,
  ValueError,
  wrapTables,
} from "./publish";
import type { Payload } from "./types";

export type Reporter = (message: string) => void;

/**
 * The part of CanvasLMS the publisher drives. A Pick rather than the class, so a
 * test can hand in a plain object of fakes.
 */
export type PublisherCanvas = Pick<
  CanvasLMS,
  | "getJson"
  | "exists"
  | "updateSyllabus"
  | "listAssignmentGroups"
  | "createAssignmentGroup"
  | "updateAssignmentGroup"
  | "setGroupWeighting"
  | "createPage"
  | "updatePage"
  | "createAssignment"
  | "updateAssignment"
  | "createDiscussion"
  | "updateDiscussion"
  | "createQuiz"
  | "updateQuiz"
  | "listQuizQuestions"
  | "createQuizQuestion"
  | "deleteQuizQuestion"
  | "uploadFile"
  | "listFiles"
  | "downloadBytes"
  | "listModules"
  | "createModule"
  | "updateModule"
  | "listModuleItems"
  | "createModuleItem"
  | "deleteModuleItem"
  | "createRubric"
  | "updateRubric"
>;

// Which Canvas object each gradable kind becomes.  An exam guide is a study guide,
// published as a page; the exam itself is a Canvas quiz built by hand.
export const KIND_TO_CANVAS: Readonly<Record<string, string>> = {
  lab: "assignment",
  project: "assignment",
  extra: "assignment",
  quiz: "quiz",
  discussion: "discussion",
  exam: "page",
  reminder: "assignment",
};

type ItemKind = NativeKind | "header";

// What the module items API calls each kind of object.
const MODULE_ITEM_TYPES: Readonly<Record<ItemKind, string>> = {
  page: "Page",
  assignment: "Assignment",
  discussion: "Discussion",
  quiz: "Quiz",
  file: "File",
  header: "SubHeader",
};

// What a `never_publish` module is written with on every push. Unpublished is the
// real guard; the far-off unlock date is the second one, for a publish clicked in
// the Canvas UI between pushes: students would see a module locked until 2099,
// not its contents.
const NEVER_PUBLISH_FIELDS: Readonly<Record<string, string>> = {
  "module[published]": "false",
  "module[unlock_at]": "2099-12-31T23:59:00Z",
};

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

/** Python's `str()` of a JSON value: a missing one reads "None", as it would there. */
function pyStr(value: unknown): string {
  return typeof value === "string" ? value : pyRepr(value);
}

/**
 * A Canvas id out of a payload. Canvas sends a null assignment_id for an ungraded
 * discussion, which is recorded as no id rather than as the text "None".
 */
function idOf(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

/**
 * The Canvas module a [[module]] table builds into, if it exists yet.
 *
 * The exact name wins. Failing that, a module with the same title and some
 * other date span, "Module 3: Risk (January 25 - January 31)" from last term,
 * is the same module and is renamed rather than duplicated.
 */
function findModule(stored: readonly Payload[], name: string, base: string): Payload | null {
  for (const module of stored) {
    if (pyStr(module.name) === name) return module;
  }
  for (const module of stored) {
    if (pyStr(module.name) === base) return module;
  }
  if (base !== name) {
    for (const module of stored) {
      if (pyStr(module.name).startsWith(`${base} (`)) return module;
    }
  }
  return null;
}

/** Module ids in the order Canvas shows them. */
function moduleOrder(stored: readonly Payload[]): string[] {
  // Canvas lists modules by position already; sorting again guards against a
  // gap in the numbering. A module with no position keeps its listed place.
  return stored
    .map((module, index) => ({
      id: pyStr(module.id),
      rank: typeof module.position === "number" ? module.position : index,
    }))
    .sort((a, b) => a.rank - b.rank)
    .map((module) => module.id);
}

/**
 * Where a repo module belongs, as the 1-based Canvas position to send, with
 * `order` updated to match.
 *
 * A module goes right after `after`, the repo module before it, and the first
 * one goes ahead of every other repo module. Canvas also holds modules the
 * repo does not manage (a shell's "Course Links") and published ones a push
 * skips; neither is moved, so their slots are counted rather than assumed
 * away, which is what a plain index into canvas.toml got wrong. A module that
 * already follows `after` with only unmanaged modules in between stays put, so
 * a module placed by hand between two weeks keeps its place.
 */
export function placeModule(
  order: string[],
  id: string,
  after: string | null,
  managed: ReadonlySet<string>,
): number {
  const isManaged = (other: string): boolean => other !== id && managed.has(other);
  const current = order.indexOf(id);
  if (current !== -1) {
    const from = after === null ? 0 : order.indexOf(after) + 1;
    const anchored = after === null || from > 0;
    if (anchored && current >= from && !order.slice(from, current).some(isManaged)) {
      return current + 1;
    }
    order.splice(current, 1);
  }
  let target: number;
  if (after !== null && order.includes(after)) {
    target = order.indexOf(after) + 1;
  } else {
    const first = order.findIndex(isManaged);
    target = first === -1 ? order.length : first;
  }
  order.splice(target, 0, id);
  return target + 1;
}

/** One object to publish. */
export class Plan {
  key: string;
  kind: string;
  title: string;
  source: string | null;
  points: number | null;
  dates: ItemDates | null;
  // The repo kind this came from ("lab", "project", ...), which is what an
  // assignment group is declared against. `kind` above has already been
  // flattened to what Canvas calls the object.
  itemKind: string | null;
  extra: Record<string, string>;

  constructor(fields: {
    key: string;
    kind: string;
    title: string;
    source?: string | null;
    points?: number | null;
    dates?: ItemDates | null;
    itemKind?: string | null;
    extra?: Record<string, string>;
  }) {
    this.key = fields.key;
    this.kind = fields.kind;
    this.title = fields.title;
    this.source = fields.source ?? null;
    this.points = fields.points ?? null;
    this.dates = fields.dates ?? null;
    this.itemKind = fields.itemKind ?? null;
    this.extra = fields.extra ?? {};
  }
}

export class Result {
  created = 0;
  updated = 0;
  skipped = 0;
  errors: string[] = [];
}

function slug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** True if Canvas's copy of this group does not match what the repo declares. */
function groupDiffers(stored: Payload, group: Group, position: number): boolean {
  if (group.weight !== null && asNumber(stored.group_weight) !== group.weight) return true;
  return Math.trunc(asNumber(stored.position)) !== position;
}

export interface PublisherOptions {
  publish?: boolean;
  dryRun?: boolean;
  updatePublished?: boolean;
  report?: Reporter;
}

export class Publisher {
  readonly repo: string;
  readonly courseId: string;
  readonly canvas: PublisherCanvas | null;
  readonly publish: boolean;
  readonly dryRun: boolean;
  readonly updatePublished: boolean;
  readonly report: Reporter;
  readonly manifest: Manifest;
  readonly config: DateConfig;
  readonly dates: Map<string, ItemDates>;
  readonly css: string;
  readonly rendered = new Map<string, string>();
  readonly protected = new Set<string>();
  // Repo paths marked `draft: true`, filled in by plan().
  readonly drafts = new Set<string>();
  // Canvas assignment group name -> id, filled in by syncGroups().
  readonly groups = new Map<string, string>();
  readonly droppedCss = new Set<string>();
  private groupsSynced = false;
  private neverPublishedKeys: Set<string> | null = null;
  // The course's files, listed once per push by courseFiles().
  private courseFileList: Payload[] | null = null;
  private alwaysPublishedKeys: Set<string> | null = null;

  constructor(
    repo: string,
    courseId: string,
    canvas: PublisherCanvas | null = null,
    options: PublisherOptions = {},
  ) {
    // Resolved lexically rather than through realpath, so a source path handed in
    // by a caller stays comparable with the repo when links are rewritten.
    this.repo = path.resolve(repo);
    this.courseId = courseId;
    this.canvas = canvas;
    this.publish = options.publish ?? false;
    this.dryRun = options.dryRun ?? false;
    this.updatePublished = options.updatePublished ?? false;
    this.report = options.report ?? ((message: string) => console.log(message));
    this.manifest = Manifest.forCourse(this.repo, courseId);
    this.config = loadConfig(this.repo);
    this.dates = new Map(compute(this.repo, this.config).map((item) => [item.path, item]));
    const cssPath = path.join(this.repo, "canvas.css");
    this.css = existsSync(cssPath) ? readFileSync(cssPath, "utf-8") : "";
  }

  // -- rendering ------------------------------------------------------

  /** Markdown -> decorated, styled, Canvas-safe HTML. */
  render(source: string): [string, string] {
    const [title, rendered] = renderMarkdown(source, this.repo);
    let html = wrapTables(markTableRows(decorate(rendered)));
    const icons = this.config.icons.map((icon): [string, string] => [icon.pattern, icon.path]);
    html = addHeadingIcons(html, icons, source, this.repo);
    if (this.css) {
      const [styled, dropped] = inlineCss(html, this.css);
      html = styled;
      for (const prop of dropped) this.droppedCss.add(prop);
    }
    const forbidden = assertNoForbiddenTags(html);
    if (forbidden.length > 0) {
      throw new PublishError(`${path.basename(source)}: Canvas would strip ${forbidden.join(", ")}`);
    }
    return [title, html];
  }

  // -- planning -------------------------------------------------------

  /** Everything that will be created or updated, in dependency order. */
  plan(): Plan[] {
    const layout = this.config.layout;
    const plans: Plan[] = [];
    const claimed = new Set<string>();
    const sourceOf = (key: string): string => path.join(this.repo, key);

    /**
     * A draft is not a Canvas object, so it never enters the plan.
     *
     * Claiming the key as well keeps a later, looser glob from picking the
     * same file back up as a page.
     */
    const skip = (key: string): boolean => {
      if (!pathIsDraft(sourceOf(key))) return false;
      this.drafts.add(key);
      claimed.add(key);
      return true;
    };

    for (const pattern of layout.files) {
      for (const key of globRepo(this.repo, pattern)) {
        if (isFile(this.repo, key) && !skip(key) && !claimed.has(key)) {
          claimed.add(key);
          plans.push(new Plan({ key, kind: "file", title: path.basename(key), source: sourceOf(key) }));
        }
      }
    }

    // Heading icons are course files too. Uploading them from the [icons]
    // table means a repo names each image once, not again under [layout].
    for (const icon of this.config.icons) {
      const key = repoKey(this.repo, icon.path);
      if (isFile(this.repo, key) && !claimed.has(key)) {
        claimed.add(key);
        plans.push(new Plan({ key, kind: "file", title: path.basename(key), source: sourceOf(key) }));
      }
    }

    // Ungraded discussions before pages, so a Q&A board that sits among a
    // module's pages is not caught by a looser page glob first.
    for (const pattern of layout.discussions) {
      for (const key of globRepo(this.repo, pattern)) {
        if (isFile(this.repo, key) && !skip(key) && !claimed.has(key)) {
          claimed.add(key);
          plans.push(new Plan({ key, kind: "discussion", title: "", source: sourceOf(key) }));
        }
      }
    }

    // Pages before gradable items: a file matched by both, such as an exam guide
    // sitting under assignments/, stays a page.
    for (const pattern of layout.pages) {
      for (const key of globRepo(this.repo, pattern)) {
        if (isFile(this.repo, key) && !skip(key) && !claimed.has(key)) {
          claimed.add(key);
          plans.push(new Plan({ key, kind: "page", title: "", source: sourceOf(key) }));
        }
      }
    }

    for (const [pattern, kind] of layout.gradable) {
      const canvasKind = Object.hasOwn(KIND_TO_CANVAS, kind) ? KIND_TO_CANVAS[kind] : undefined;
      if (canvasKind === undefined) continue;
      for (const key of globRepo(this.repo, pattern)) {
        if (!isFile(this.repo, key) || skip(key) || claimed.has(key)) continue;
        claimed.add(key);
        const item = this.dates.get(key) ?? null;
        plans.push(
          new Plan({
            key,
            kind: canvasKind,
            title: "",
            source: sourceOf(key),
            points: item ? item.points : null,
            dates: item,
            itemKind: kind,
          }),
        );
      }
    }

    plans.push(
      new Plan({
        key: layout.syllabus,
        kind: "syllabus",
        title: "Syllabus",
        source: sourceOf(layout.syllabus),
      }),
    );
    return plans;
  }

  // -- helpers --------------------------------------------------------

  /**
   * What to say about visibility, or null to say nothing at all.
   *
   * On create there is no prior state, so the flag decides it. On update,
   * --publish still publishes, but its absence must leave the object alone:
   * pushing a correction to a live assignment should not pull it out from
   * under the class currently reading it.
   *
   * An object in a `never_publish` module is the exception both ways: it is
   * written unpublished every time, whatever the flag, so a push also takes
   * back a publish someone clicked in the Canvas UI.
   */
  visibility(exists: boolean, key = ""): boolean | null {
    if (this.neverPublished.has(key)) return false;
    if (this.alwaysPublished.has(key)) return true;
    return !exists || this.publish ? this.publish : null;
  }

  /**
   * Repo keys placed in a [[module]] marked `publish = true`.
   *
   * For content every student needs from day one, such as Course Resources:
   * it is published whether or not the push was given --publish. A key that
   * is also in a never_publish module stays hidden; hiding wins.
   */
  get alwaysPublished(): Set<string> {
    if (this.alwaysPublishedKeys === null) {
      const shown = this.moduleTables().filter((m) => m.publish === true);
      const hidden = this.neverPublished;
      this.alwaysPublishedKeys = new Set([...moduleKeys(shown)].filter((key) => !hidden.has(key)));
    }
    return this.alwaysPublishedKeys;
  }

  /** Repo keys placed in a [[module]] marked `never_publish = true`. */
  get neverPublished(): Set<string> {
    if (this.neverPublishedKeys === null) {
      const hidden = this.moduleTables().filter((m) => m.never_publish === true);
      this.neverPublishedKeys = moduleKeys(hidden);
    }
    return this.neverPublishedKeys;
  }

  dateFields(prefix: string, item: ItemDates | null): Record<string, string> {
    if (item === null) return {};
    // A course that wants no "Available from" date omits unlock from its policy.
    // That has to be sent as an empty value rather than left out: omitting the
    // field on an update makes Canvas keep whatever date is already there.
    return {
      [`${prefix}[due_at]`]: isoformat(item.dueAt),
      [`${prefix}[unlock_at]`]: item.unlockAt ? isoformat(item.unlockAt) : "",
      [`${prefix}[lock_at]`]: isoformat(item.lockAt),
    };
  }

  private client(): PublisherCanvas {
    if (this.canvas === null) throw new PublishError("no Canvas client configured");
    return this.canvas;
  }

  /**
   * Whether a repo path is a draft.
   *
   * Reads the file rather than trusting `this.drafts` so that it is right
   * even when nothing has called `plan()` yet.
   */
  isDraftKey(key: string): boolean {
    if (this.drafts.has(key)) return true;
    if (isFile(this.repo, key) && pathIsDraft(path.join(this.repo, key))) {
      this.drafts.add(key);
      return true;
    }
    return false;
  }

  /**
   * Forget the Canvas objects of files that have since become drafts.
   *
   * A file that was pushed and is now a draft leaves an object behind in
   * Canvas. Dropping the manifest entry is what makes the draft invisible to
   * `verify`, but it also orphans that object, so the keys are returned for
   * the caller to report. Deleting it is left to a human: an assignment may
   * already have submissions against it.
   */
  pruneDrafts(): string[] {
    const orphaned: string[] = [];
    for (const key of [...this.manifest.entries.keys()].sort()) {
      if (this.isDraftKey(key)) {
        orphaned.push(key);
        this.manifest.drop(key);
      }
    }
    return orphaned;
  }

  /**
   * True if this object is already published, so students can see it.
   *
   * Rewriting something a class is part-way through reading is worse than
   * leaving it stale, so a push skips it unless asked to do otherwise. The
   * syllabus has no published flag of its own: it is visible whenever the
   * course is, so treat it as live in a published course.
   */
  async isLive(entry: Entry | null): Promise<boolean> {
    if (entry === null || this.updatePublished) return false;
    const canvas = this.client();
    if (entry.kind === "syllabus") {
      const course = await canvas.getJson(`/api/v1/courses/${this.courseId}`);
      return String(course.workflow_state ?? "") === "available";
    }
    if (entry.kind === "file") return false;
    let stored: Payload;
    try {
      stored = await canvas.getJson(`/api/v1${canvasPath(entry, this.courseId)}`);
    } catch (error) {
      // Deleted in Canvas since the last push: nothing is live, and the create
      // path below recreates it. Throwing here instead failed the whole item.
      if (error instanceof CanvasApiError && error.status === 404) return false;
      throw error;
    }
    return Boolean(stored.published);
  }

  // -- assignment groups ----------------------------------------------

  /**
   * Create or update the course's assignment groups from [[group]].
   *
   * Memoised, because the CLI calls it up front so the counts are reported
   * and a single-item push reaches it lazily through groupFields.
   */
  async syncGroups(): Promise<Result> {
    const result = new Result();
    if (this.groupsSynced || this.config.groups.length === 0) return result;
    this.groupsSynced = true;

    if (this.dryRun) {
      for (const group of this.config.groups) {
        const weight = group.weight !== null ? ` (${formatG(group.weight)}%)` : "";
        const kinds = group.kinds.length > 0 ? ` <- ${group.kinds.join(", ")}` : "";
        this.report(`[dim]group ${group.name}${weight}${kinds}[/dim]`);
        result.skipped += 1;
      }
      return result;
    }

    const canvas = this.client();
    const existing = new Map<string, Payload>();
    for (const stored of await canvas.listAssignmentGroups(this.courseId)) {
      existing.set(String(stored.name ?? ""), stored);
    }
    let position = 0;
    for (const group of this.config.groups) {
      position += 1;
      const fields: Record<string, string> = { name: group.name, position: String(position) };
      if (group.weight !== null) fields.group_weight = formatG(group.weight);
      const stored = existing.get(group.name);
      if (stored === undefined) {
        const created = await canvas.createAssignmentGroup(this.courseId, fields);
        this.groups.set(group.name, String(created.id));
        result.created += 1;
        continue;
      }
      const groupId = String(stored.id ?? "");
      this.groups.set(group.name, groupId);
      if (groupDiffers(stored, group, position)) {
        await canvas.updateAssignmentGroup(this.courseId, groupId, fields);
        result.updated += 1;
      } else {
        result.skipped += 1;
      }
    }

    // Weights are inert until the course itself is set to weight by group.
    if (this.config.groups.some((group) => group.weight !== null)) {
      await canvas.setGroupWeighting(this.courseId, true);
    }
    return result;
  }

  /** The assignment group field for this item, or nothing if none applies. */
  private async groupFields(prefix: string, item: Plan): Promise<Record<string, string>> {
    const group = item.itemKind ? this.config.groupFor(item.itemKind) : null;
    if (group === null) return {};
    await this.syncGroups();
    const groupId = this.groups.get(group.name);
    return groupId ? { [`${prefix}[assignment_group_id]`]: groupId } : {};
  }

  // -- pass one -------------------------------------------------------

  async createOrUpdate(item: Plan): Promise<Result> {
    const result = new Result();
    if (item.source === null) return result;

    if (item.kind === "file") return this.pushFile(item);

    const [title, html] = this.render(item.source);
    item.title = title || item.title;
    this.rendered.set(item.key, html);

    if (this.dryRun) {
      result.skipped = 1;
      return result;
    }

    const canvas = this.client();
    const existing = this.manifest.get(item.key);
    const course = this.courseId;

    // A never_publish object that is somehow live is the one case where a
    // push must rewrite published content: that is how it comes back down.
    if (!this.neverPublished.has(item.key) && (await this.isLive(existing))) {
      this.protected.add(item.key);
      result.skipped = 1;
      return result;
    }

    if (item.kind === "syllabus") {
      await canvas.updateSyllabus(course, html);
      this.manifest.put(item.key, new Entry({ kind: "syllabus", canvasId: course, title }));
      result.updated = 1;
    } else if (item.kind === "page") {
      let pageUrl: string;
      if (existing && (await canvas.exists(`/api/v1/courses/${course}/pages/${existing.pageUrl}`))) {
        const visible = this.visibility(true, item.key);
        const stored = await canvas.updatePage(course, existing.pageUrl, {
          title,
          body: html,
          ...(visible === null ? {} : { published: visible }),
        });
        result.updated = 1;
        // Canvas re-slugs a page whose title changes, and the old slug
        // stops working as a module item's page_url. Keep the new one.
        pageUrl = stored.url ? String(stored.url) : existing.pageUrl;
      } else {
        const created = await canvas.createPage(course, title, html, Boolean(this.visibility(false, item.key)));
        pageUrl = created.url === undefined ? slug(title) : pyStr(created.url);
        result.created = 1;
      }
      this.manifest.put(item.key, new Entry({ kind: "page", canvasId: pageUrl, pageUrl, title }));
    } else if (item.kind === "assignment") {
      const options = assignmentOptions(readFileSync(item.source, "utf-8"));
      // A list rather than a record: submission_types[] repeats once per type.
      const fields: Array<[string, string]> = [
        ["assignment[name]", title],
        ["assignment[description]", html],
        ["assignment[points_possible]", formatG(item.points || 0)],
        ...options.submissionTypes.map((t): [string, string] => ["assignment[submission_types][]", t]),
        ...Object.entries(await this.groupFields("assignment", item)),
        ...Object.entries(this.dateFields("assignment", item.dates)),
      ];
      if (options.gradingType) fields.push(["assignment[grading_type]", options.gradingType]);
      let canvasId: string;
      if (existing && (await canvas.exists(`/api/v1/courses/${course}/assignments/${existing.canvasId}`))) {
        const visible = this.visibility(true, item.key);
        if (visible !== null) fields.push(["assignment[published]", String(visible)]);
        await canvas.updateAssignment(course, existing.canvasId, fields);
        canvasId = existing.canvasId;
        result.updated = 1;
      } else {
        const visible = Boolean(this.visibility(false, item.key));
        fields.push(["assignment[published]", String(visible)]);
        const created = await canvas.createAssignment(course, fields);
        canvasId = String(created.id);
        result.created = 1;
      }
      this.manifest.put(item.key, new Entry({ kind: "assignment", canvasId, title }));
    } else if (item.kind === "discussion") {
      const fields: Record<string, string> = { title, message: html };
      // A graded discussion hangs its points, group and dates off an
      // assignment; sending any of them to an ungraded one would make
      // Canvas create that assignment and put the board in the gradebook.
      if (item.itemKind !== null) {
        Object.assign(fields, {
          "assignment[points_possible]": formatG(item.points || 0),
          ...(await this.groupFields("assignment", item)),
          ...this.dateFields("assignment", item.dates),
        });
      }
      let stored: Payload;
      let canvasId: string;
      if (existing && (await canvas.exists(`/api/v1/courses/${course}/discussion_topics/${existing.canvasId}`))) {
        const visible = this.visibility(true, item.key);
        if (visible !== null) fields.published = String(visible);
        stored = await canvas.updateDiscussion(course, existing.canvasId, fields);
        canvasId = existing.canvasId;
        result.updated = 1;
      } else {
        fields.published = String(Boolean(this.visibility(false, item.key)));
        stored = await canvas.createDiscussion(course, fields);
        canvasId = String(stored.id);
        result.created = 1;
      }
      const extra = { assignment_id: idOf(stored.assignment_id) };
      this.manifest.put(item.key, new Entry({ kind: "discussion", canvasId, title, extra }));
    } else if (item.kind === "quiz") {
      const graded = (item.points || 0) > 0;
      const fields: Record<string, string> = {
        "quiz[title]": title,
        "quiz[description]": html,
        "quiz[quiz_type]": graded ? "assignment" : "practice_quiz",
        // Always written unpublished, then published again below once the
        // questions exist. Canvas freezes a quiz's question set when it is
        // published, so questions added to an already-published quiz are
        // never counted: the quiz reads 0 questions and 0 points to
        // students until someone unpublishes and republishes it by hand.
        "quiz[published]": "false",
        "quiz[allowed_attempts]": "1",
        "quiz[scoring_policy]": "keep_highest",
        ...(await this.groupFields("quiz", item)),
        ...this.dateFields("quiz", item.dates),
      };
      let wasLive = false;
      let canvasId: string;
      const quizPath = existing ? `/api/v1/courses/${course}/quizzes/${existing.canvasId}` : "";
      if (existing && (await canvas.exists(quizPath))) {
        const storedQuiz = await canvas.getJson(quizPath);
        wasLive = Boolean(storedQuiz.published);
        await canvas.updateQuiz(course, existing.canvasId, fields);
        canvasId = existing.canvasId;
        result.updated = 1;
      } else {
        const created = await canvas.createQuiz(course, fields);
        canvasId = String(created.id);
        result.created = 1;
      }
      this.manifest.put(item.key, new Entry({ kind: "quiz", canvasId, title }));
      await this.pushQuestions(item, canvasId);
      // wasLive: the write above forced published=false to let the question
      // set be rebuilt, so a quiz that arrived published has to go back.
      const wanted = this.publish || wasLive || this.alwaysPublished.has(item.key);
      if (wanted && !this.neverPublished.has(item.key)) {
        await canvas.updateQuiz(course, canvasId, { "quiz[published]": "true" });
      }
    }
    return result;
  }

  private async pushFile(item: Plan): Promise<Result> {
    const result = new Result();
    if (item.source === null) return result;
    if (this.dryRun) {
      result.skipped = 1;
      return result;
    }
    const reused = await this.matchingCourseFile(item);
    if (reused !== null) {
      this.recordFile(item.key, reused);
      result.skipped = 1;
      return result;
    }
    const folder = `course files/${path.basename(path.dirname(item.source))}`;
    const stored = await this.client().uploadFile(this.courseId, item.source, folder);
    this.recordFile(item.key, stored);
    (await this.courseFiles()).push(stored);
    result.created = 1;
    return result;
  }

  private recordFile(key: string, stored: Payload): void {
    this.manifest.put(
      key,
      new Entry({
        kind: "file",
        canvasId: String(stored.id),
        title: path.basename(key),
        extra: { size: idOf(stored.size) },
      }),
    );
  }

  private async courseFiles(): Promise<Payload[]> {
    if (this.courseFileList === null) {
      this.courseFileList = await this.client().listFiles(this.courseId);
    }
    return this.courseFileList;
  }

  /**
   * A file already in the course with exactly the repo file's bytes, if any.
   *
   * A course copied from a shell arrives with the shell's files, such as its icon
   * set, often under other names ("AI Allowed.svg" for ai-allowed.svg), so the
   * match is on content, never on name. Uploading anyway leaves two copies of
   * every icon side by side. The file the manifest already records is tried
   * first so a course that has been pushed keeps pointing where it did; after
   * that the oldest wins, which is the shell's original. Only files of the same
   * size are downloaded, and a hidden or locked one is passed over because
   * students could not load it.
   */
  private async matchingCourseFile(item: Plan): Promise<Payload | null> {
    if (item.source === null) return null;
    const bytes = readFileSync(item.source);
    const tracked = this.manifest.get(item.key)?.canvasId ?? "";
    const candidates = (await this.courseFiles())
      .filter((file) => asNumber(file.size) === bytes.length && typeof file.url === "string" && file.url !== "")
      .filter((file) => file.hidden !== true && file.locked !== true)
      .sort((a, b) => {
        const trackedFirst = Number(idOf(b.id) === tracked) - Number(idOf(a.id) === tracked);
        return trackedFirst || asNumber(a.id) - asNumber(b.id);
      });
    for (const file of candidates) {
      const label = typeof file.display_name === "string" ? file.display_name : idOf(file.id);
      // The filter above kept only files whose url is a non-empty string.
      const stored = await this.client().downloadBytes(file.url as string, label);
      if (stored.equals(bytes)) return file;
    }
    return null;
  }

  /** Replace a quiz's questions so a re-push never duplicates them. */
  private async pushQuestions(item: Plan, quizId: string): Promise<void> {
    if (item.source === null) return;
    const canvas = this.client();
    for (const existing of await canvas.listQuizQuestions(this.courseId, quizId)) {
      await canvas.deleteQuizQuestion(this.courseId, quizId, String(existing.id));
    }
    let position = 0;
    for (const question of parseQuiz(item.source)) {
      position += 1;
      await canvas.createQuizQuestion(this.courseId, quizId, questionFields(question, position));
    }
  }

  // -- pass two -------------------------------------------------------

  /** Point relative links at Canvas objects and update the body. */
  async rewrite(item: Plan): Promise<string[]> {
    if (item.source === null || item.kind === "file" || this.protected.has(item.key)) return [];
    const html = this.rendered.get(item.key);
    const entry = this.manifest.get(item.key);
    if (html === undefined || entry === null) return [];
    const [rewritten, unresolved] = rewriteLinks(html, item.source, this.repo, this.manifest, this.courseId);
    this.rendered.set(item.key, rewritten);
    if (this.dryRun || rewritten === html) return unresolved;

    const canvas = this.client();
    const course = this.courseId;
    if (entry.kind === "page") {
      await canvas.updatePage(course, entry.pageUrl, { body: rewritten });
    } else if (entry.kind === "assignment") {
      await canvas.updateAssignment(course, entry.canvasId, { "assignment[description]": rewritten });
    } else if (entry.kind === "discussion") {
      await canvas.updateDiscussion(course, entry.canvasId, { message: rewritten });
    } else if (entry.kind === "quiz") {
      await canvas.updateQuiz(course, entry.canvasId, { "quiz[description]": rewritten });
    } else if (entry.kind === "syllabus") {
      await canvas.updateSyllabus(course, rewritten);
    }
    return unresolved;
  }

  // -- modules --------------------------------------------------------

  /** The raw [[module]] tables of canvas.toml, in the order written. */
  moduleTables(): Record<string, unknown>[] {
    const raw: Record<string, unknown> = parseToml(readFileSync(path.join(this.repo, "canvas.toml"), "utf-8"));
    const modules = raw.module ?? [];
    if (!Array.isArray(modules)) return [];
    return modules.filter(isTable);
  }

  /**
   * Gradable items among `plans` that no [[module]] places.
   *
   * Students find their work through Modules, so an assignment that no
   * table lists is published and yet invisible. Forgetting the line in
   * canvas.toml is the easiest mistake in the workflow and, until this,
   * made no noise anywhere. A repo with no [[module]] tables at all does
   * not use modules and gets no warning.
   */
  unlisted(plans: Iterable<Plan>): string[] {
    const modules = this.moduleTables();
    if (modules.length === 0) return [];
    const placed = moduleKeys(modules);
    const keys: string[] = [];
    for (const plan of plans) {
      if (plan.itemKind !== null && !placed.has(plan.key) && !this.isDraftKey(plan.key)) {
        keys.push(plan.key);
      }
    }
    return keys.sort();
  }

  /** Build the weekly modules from the [[module]] tables in canvas.toml. */
  async pushModules(): Promise<Result> {
    const result = new Result();
    const modules = this.moduleTables();
    if (this.dryRun) {
      result.skipped = modules.length;
      return result;
    }

    const canvas = this.client();
    const course = this.courseId;
    const storedModules = await canvas.listModules(course);

    // Each table's name, and the Canvas module it already has, worked out up
    // front so that placing one module knows which of the others are the
    // repo's. A table whose title fails is reported in the loop below.
    const named = modules.map((module, index) => {
      const base = pyStr(module.title ?? `Module ${index + 1}`);
      try {
        const name = moduleTitle(module, this.config.term);
        return { module, name, error: null, stored: findModule(storedModules, name, base) };
      } catch (error) {
        if (!(error instanceof DateConfigError)) throw error;
        return { module, name: "", error: error.message, stored: null };
      }
    });
    const order = moduleOrder(storedModules);
    const managed = new Set(named.flatMap(({ stored }) => (stored === null ? [] : [pyStr(stored.id)])));

    // The repo module placed or skipped last, which the next one goes after.
    let after: string | null = null;
    for (const { module, name, error, stored } of named) {
      if (error !== null) {
        result.errors.push(error);
        continue;
      }
      const hidden = module.never_publish === true;
      const shown = module.publish === true && !hidden;
      if (stored?.published && !this.updatePublished && !hidden) {
        result.skipped += 1;
        after = pyStr(stored.id);
        continue;
      }
      let moduleId: string;
      if (stored === null) {
        const position = placeModule(order, "", after, managed);
        const created = await canvas.createModule(course, name, position, (this.publish || shown) && !hidden);
        moduleId = String(created.id);
        order[position - 1] = moduleId;
        managed.add(moduleId);
        result.created += 1;
        if (hidden) await canvas.updateModule(course, moduleId, { ...NEVER_PUBLISH_FIELDS });
      } else {
        moduleId = pyStr(stored.id);
        const position = placeModule(order, moduleId, after, managed);
        const fields: Record<string, string> = { "module[position]": String(position) };
        if (hidden) Object.assign(fields, NEVER_PUBLISH_FIELDS);
        // A new term moves every date, so the same module comes back
        // under a new name; renaming it keeps one module, not two.
        if (pyStr(stored.name) !== name) fields["module[name]"] = name;
        await canvas.updateModule(course, moduleId, fields);
        result.updated += 1;
      }
      after = moduleId;

      for (const current of await canvas.listModuleItems(course, moduleId)) {
        await canvas.deleteModuleItem(course, moduleId, String(current.id));
      }

      // Repo items and text headers first, in the order written, then the
      // Canvas-native ones named under `canvas`: a hand built quiz or an
      // uploaded file that has no repo file but still belongs in the module.
      let entries: ReturnType<typeof moduleEntries>;
      try {
        entries = moduleEntries(module);
      } catch (error) {
        if (!(error instanceof ValueError)) throw error;
        result.errors.push(`module ${pyRepr(name)}: ${error.message}`);
        entries = [];
      }
      const placed: Array<[ItemKind, string, string]> = [];
      for (const line of entries) {
        if (line.header) {
          placed.push(["header", "", line.header]);
          continue;
        }
        if (line.native !== null) {
          placed.push([line.native.kind, line.native.ident, line.native.title]);
          continue;
        }
        if (this.isDraftKey(line.key)) continue;
        const entry = this.manifest.get(line.key);
        if (entry === null) {
          result.errors.push(`module ${pyRepr(name)}: ${line.key} has not been published`);
          continue;
        }
        const kind = entry.kind;
        if (
          kind === "page" ||
          kind === "assignment" ||
          kind === "discussion" ||
          kind === "quiz" ||
          kind === "file"
        ) {
          const ident = kind === "page" ? entry.pageUrl : entry.canvasId;
          placed.push([kind, ident, entry.title]);
        }
      }
      let native: ReturnType<typeof parseNativeItems>;
      try {
        native = parseNativeItems(module);
      } catch (error) {
        if (!(error instanceof ValueError)) throw error;
        result.errors.push(`module ${pyRepr(name)}: ${error.message}`);
        native = [];
      }
      for (const item of native) placed.push([item.kind, item.ident, item.title]);

      let index = 0;
      for (const [kind, ident, title] of placed) {
        index += 1;
        const fields: Record<string, string> = {
          "module_item[type]": MODULE_ITEM_TYPES[kind],
          "module_item[position]": String(index),
        };
        // Canvas takes the content's own title when none is sent, which
        // is what a native item wants; a repo item sends the rendered one.
        if (title) fields["module_item[title]"] = title;
        if (kind === "page") fields["module_item[page_url]"] = ident;
        else if (kind !== "header") fields["module_item[content_id]"] = ident;
        await canvas.createModuleItem(course, moduleId, fields);
      }

      if ((this.publish || shown) && !hidden) {
        await canvas.updateModule(course, moduleId, { "module[published]": "true" });
      }
    }
    return result;
  }

  // -- rubrics --------------------------------------------------------

  /**
   * Bind a Canvas rubric to each lab and discussion that has a '## Rubric' table.
   *
   * The rubric already attached is read first. Unchanged criteria are left alone,
   * changed ones are rewritten in place, and a rubric is only created for an
   * assignment that has none. Creating one every push used to replace the rubric
   * an assignment was graded with, so SpeedGrader showed a new, empty rubric
   * beside grades that had been given with the old one.
   *
   * `keys` limits the sweep to particular repo files, so a scoped push carries
   * the corrected rubric without touching every other assignment's.
   */
  async pushRubrics(keys: ReadonlySet<string> | null = null): Promise<Result> {
    const result = new Result();
    if (this.dryRun) return result;
    const canvas = this.client();
    const sorted = [...this.manifest.entries.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [key, entry] of sorted) {
      if ((entry.kind !== "assignment" && entry.kind !== "discussion") || this.protected.has(key)) continue;
      if (keys !== null && !keys.has(key)) continue;
      const source = path.join(this.repo, key);
      if (!existsSync(source)) continue;
      const criteria = parseRubric(readFileSync(source, "utf-8"));
      if (criteria.length === 0) continue;
      const association = entry.extra.assignment_id || entry.canvasId;
      if (entry.kind === "discussion" && !entry.extra.assignment_id) {
        result.errors.push(`${key}: no assignment_id, cannot attach a rubric`);
        continue;
      }
      const fields = rubricFields(`${entry.title} rubric`, criteria, association);
      const current = attachedRubric(
        await canvas.getJson(`/api/v1/courses/${this.courseId}/assignments/${association}`),
      );
      if (current === null) {
        await canvas.createRubric(this.courseId, fields);
        result.created += 1;
      } else if (sameCriteria(current.criteria, criteria)) {
        result.skipped += 1;
      } else {
        await canvas.updateRubric(this.courseId, current.id, fields);
        result.updated += 1;
      }
    }
    return result;
  }
}

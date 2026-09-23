/**
 * The contract between the renderer and the main process.
 *
 * `EdutoolsApi` is the whole surface the renderer can reach, exposed on
 * `window.edutools` by the preload script. The main process implements the same
 * interface, so a method added here fails to type-check until both sides have it.
 * Every call crosses one `ipcRenderer.invoke` channel named after the method.
 *
 * `EdutoolsEvents` is the other direction: one-way messages from main to the
 * page, each with a typed payload and a runtime check.
 *
 * This file is shared by main, preload and renderer, so it imports nothing from
 * node or from core: the renderer must type-check without node's types.
 */

import { isScreenId, type ScreenId } from "./screens";

/** A Canvas site as the renderer sees it. The token itself never crosses IPC. */
export interface SiteView {
  readonly name: string;
  readonly endpoint: string;
  readonly isDefault: boolean;
  /** `****abcd`, or null when no token is saved for the site. */
  readonly tokenHint: string | null;
}

export interface NewSiteInput {
  readonly name: string;
  readonly endpoint: string;
  readonly token: string;
}

export interface ConnectionInput {
  readonly endpoint: string;
  readonly token: string;
}

export interface TestResult {
  readonly endpoint: string;
  readonly courseCount: number;
}

export interface ImportResult {
  /** False when there was no old config file, or it had no token. */
  readonly imported: boolean;
  readonly created: boolean;
  readonly siteName: string | null;
  readonly path: string;
}

export interface CourseRow {
  readonly id: string;
  readonly name: string;
  readonly code: string;
  readonly term: string;
  readonly state: string;
}

export interface CourseList {
  readonly site: string | null;
  readonly endpoint: string;
  readonly courses: readonly CourseRow[];
}

/** What the renderer sends to choose a course: the parts of a Courses row it keeps. */
export interface CourseChoice {
  readonly id: string;
  readonly name: string;
  readonly code: string;
}

/**
 * The course the app is working on, chosen on the Courses screen and remembered
 * across launches. It belongs to the site it was chosen on: when the default site
 * changes, there is no current course until one is chosen again.
 */
export interface CurrentCourse extends CourseChoice {
  readonly endpoint: string;
}

export interface AssignmentRow {
  readonly id: string;
  readonly name: string;
  readonly points: number | null;
  /** ISO 8601 as Canvas sends it; the renderer shows it in local time. */
  readonly dueAt: string | null;
  readonly published: boolean;
  readonly group: string;
  readonly htmlUrl: string;
}

export interface ModuleItemRow {
  readonly id: string;
  readonly title: string;
  /** Canvas's item type: Page, Assignment, Quiz, SubHeader, ExternalUrl, File... */
  readonly type: string;
  readonly indent: number;
  /** Null when Canvas reports no state, as for an item the user cannot manage. */
  readonly published: boolean | null;
  /** Empty for a SubHeader, which is only a label and has nowhere to go. */
  readonly htmlUrl: string;
}

export interface ModuleRow {
  readonly id: string;
  readonly name: string;
  readonly published: boolean;
  readonly htmlUrl: string;
  readonly items: readonly ModuleItemRow[];
}

export interface PageRow {
  /** The url slug, which is how Canvas addresses a page. */
  readonly url: string;
  readonly title: string;
  readonly published: boolean;
  readonly updatedAt: string | null;
  readonly htmlUrl: string;
}

export interface AssignmentGroupRow {
  readonly id: string;
  readonly name: string;
  readonly weight: number | null;
  readonly assignmentCount: number;
}

export interface AssignmentGroupList {
  /** Canvas ignores every group weight until this course-level flag is on. */
  readonly weighted: boolean;
  readonly groups: readonly AssignmentGroupRow[];
  /** The course's Assignments page, where the groups are edited. */
  readonly htmlUrl: string;
}

/** What the Snapshot screen starts from. */
export interface SnapshotDefaults {
  readonly folder: string;
  /** Every kind a pull knows, in the order it walks them. */
  readonly kinds: readonly string[];
}

export interface SnapshotRequest {
  readonly courseId: string;
  readonly folder: string;
  readonly kinds: readonly string[];
}

export interface KindCount {
  readonly kind: string;
  readonly count: number;
}

export interface SnapshotSummary {
  readonly courseId: string;
  readonly courseName: string;
  readonly folder: string;
  readonly counts: readonly KindCount[];
  readonly downloaded: number;
  /** Course files already on disk at the size and time Canvas reports. */
  readonly unchanged: number;
  /** Paths an earlier snapshot wrote that this one removed, because Canvas no longer has them. */
  readonly removed: readonly string[];
  /** Everything that could not be fetched. The snapshot kept its previous copy of each. */
  readonly problems: readonly string[];
}

/**
 * The course repository chosen for the current course: a folder of markdown with
 * a canvas.toml. `problem` is set, in plain words, when canvas.toml does not load.
 */
export interface RepoInfo {
  readonly path: string;
  readonly problem: string | null;
  readonly weeks: number | null;
  readonly timezone: string | null;
}

export interface OutlineItemRow {
  /** page, assignment, discussion, quiz, file or header. */
  readonly kind: string;
  readonly title: string;
  /** Repo path without .md; empty for an item that already lives in Canvas. */
  readonly path: string;
  /** ISO 8601 with offset. */
  readonly dueAt: string | null;
  readonly points: number | null;
  readonly canvasId: string;
}

export interface OutlineModuleRow {
  readonly title: string;
  readonly items: readonly OutlineItemRow[];
}

export interface CourseOutline {
  readonly repo: string;
  readonly modules: readonly OutlineModuleRow[];
}

export interface DateRow {
  readonly path: string;
  readonly title: string;
  readonly kind: string;
  /** Null for a finals-week item. */
  readonly week: number | null;
  readonly points: number;
  readonly unlockAt: string | null;
  readonly dueAt: string;
  readonly lockAt: string;
  /** The three dates as `edutools dates --show` prints them, in the term's time zone. */
  readonly unlockText: string;
  readonly dueText: string;
  readonly lockText: string;
}

export interface CourseSchedule {
  readonly repo: string;
  readonly weeks: number;
  readonly timezone: string;
  readonly shiftDays: number;
  readonly items: readonly DateRow[];
  readonly totalPoints: number;
  /** Empty when the schedule is coherent. */
  readonly problems: readonly string[];
}

/** What Edit object works on: objects.ts's KINDS. */
export type EditKind = "page" | "assignment" | "discussion" | "quiz" | "module";

export const EDIT_KINDS: readonly EditKind[] = ["page", "assignment", "discussion", "quiz", "module"];

export interface ObjectSummary {
  /** The url slug for a page, the numeric id for everything else. */
  readonly id: string;
  readonly title: string;
  readonly published: boolean;
}

export interface ObjectDetail {
  readonly kind: EditKind;
  readonly id: string;
  readonly title: string;
  /** Null for a module, which has no body. */
  readonly body: string | null;
  readonly points: number | null;
  readonly dueAt: string | null;
  readonly unlockAt: string | null;
  readonly lockAt: string | null;
  readonly published: boolean;
  readonly htmlUrl: string;
  /** The repo path the current repository's manifest tracks this object under, if any. */
  readonly managedBy: string | null;
}

export type BodyInput = { readonly kind: "html"; readonly html: string } | { readonly kind: "markdown"; readonly file: string };

/**
 * Only what the designer changed. A field left out is not sent, so a save never
 * clears what it did not mention. An empty date string clears that date.
 */
export interface ObjectChanges {
  readonly title?: string;
  readonly body?: BodyInput;
  readonly points?: number;
  readonly dueAt?: string;
  readonly unlockAt?: string;
  readonly lockAt?: string;
}

export interface SaveObjectRequest {
  readonly courseId: string;
  readonly kind: EditKind;
  /** Null creates a new, unpublished object. */
  readonly id: string | null;
  readonly changes: ObjectChanges;
  /**
   * The designer ticked "This is visible to students; change it anyway". Without
   * it, a save to an object Canvas reports as published is refused.
   */
  readonly changeVisible: boolean;
}

export interface ObjectTarget {
  readonly courseId: string;
  readonly kind: EditKind;
  readonly id: string;
}

export interface RenderedBody {
  readonly title: string;
  readonly html: string;
}

export interface AppInfo {
  readonly version: string;
  readonly configPath: string;
  readonly legacyPath: string;
  readonly defaultEndpoint: string;
  readonly platform: string;
}

/** Invoked methods: each one is a request and a promised reply. */
export interface EdutoolsApi {
  appInfo(): Promise<AppInfo>;
  listSites(): Promise<SiteView[]>;
  addSite(input: NewSiteInput): Promise<SiteView[]>;
  removeSite(name: string): Promise<SiteView[]>;
  setDefaultSite(name: string): Promise<SiteView[]>;
  setToken(name: string, token: string): Promise<SiteView[]>;
  /** Tests a saved site's token by listing its courses. */
  testSite(name: string): Promise<TestResult>;
  /** Tests an endpoint and token before they are saved. */
  testConnection(input: ConnectionInput): Promise<TestResult>;
  importLegacyConfig(): Promise<ImportResult>;
  listCourses(options: { includeAll: boolean }): Promise<CourseList>;
  openExternal(url: string): Promise<void>;
  /** Null when none is chosen, or it was chosen on a site that is no longer the default. */
  getCurrentCourse(): Promise<CurrentCourse | null>;
  /** Choose the current course on the default site, or clear it with null. */
  setCurrentCourse(course: CourseChoice | null): Promise<CurrentCourse | null>;
  listAssignments(courseId: string): Promise<AssignmentRow[]>;
  listModules(courseId: string): Promise<ModuleRow[]>;
  listPages(courseId: string): Promise<PageRow[]>;
  listAssignmentGroups(courseId: string): Promise<AssignmentGroupList>;
  snapshotDefaults(course: CourseChoice): Promise<SnapshotDefaults>;
  /** The native folder dialog; null when the user cancels. */
  chooseFolder(defaultPath: string): Promise<string | null>;
  /**
   * Pull the course to disk, sending `snapshotProgress` events as it goes, and
   * resolve with the summary when it is done. Rejects while another pull runs.
   */
  startSnapshot(request: SnapshotRequest): Promise<SnapshotSummary>;
  /** Reveal a snapshot folder in Finder or Explorer. */
  showFolder(folder: string): Promise<void>;
  /** The repository chosen for this course on the default site, checked again now. */
  getCourseRepo(courseId: string): Promise<RepoInfo | null>;
  /** Pick the repository folder with the native dialog; null when the user cancels. */
  chooseCourseRepo(courseId: string): Promise<RepoInfo | null>;
  forgetCourseRepo(courseId: string): Promise<void>;
  /** The module outline a push will build, from the repository alone. */
  courseOutline(courseId: string): Promise<CourseOutline>;
  /** Write the outline JSON through a save dialog; the path written, or null when cancelled. */
  exportOutline(courseId: string): Promise<string | null>;
  /** The semester's computed dates, optionally previewed shifted by whole days. Writes nothing. */
  courseSchedule(courseId: string, shiftDays: number): Promise<CourseSchedule>;
  listObjects(courseId: string, kind: EditKind): Promise<ObjectSummary[]>;
  getObjectDetail(target: ObjectTarget): Promise<ObjectDetail>;
  /** Pick a markdown file for a body, starting in the course repository. */
  chooseMarkdownFile(courseId: string): Promise<string | null>;
  /** Render a markdown file the way a push would, to preview it. */
  renderMarkdownBody(courseId: string, file: string): Promise<RenderedBody>;
  saveObject(request: SaveObjectRequest): Promise<ObjectDetail>;
  setObjectPublished(target: ObjectTarget, published: boolean): Promise<ObjectDetail>;
  /** Delete after the renderer has confirmed; resolves with the title of what went. */
  deleteObject(target: ObjectTarget): Promise<string>;
}

export type ApiMethod = keyof EdutoolsApi;

/**
 * Every method name, checked for completeness by the `satisfies` clause: adding a
 * method to EdutoolsApi without listing it here is a type error, so the preload
 * can never silently lack a channel.
 */
const METHODS = {
  appInfo: true,
  listSites: true,
  addSite: true,
  removeSite: true,
  setDefaultSite: true,
  setToken: true,
  testSite: true,
  testConnection: true,
  importLegacyConfig: true,
  listCourses: true,
  openExternal: true,
  getCurrentCourse: true,
  setCurrentCourse: true,
  listAssignments: true,
  listModules: true,
  listPages: true,
  listAssignmentGroups: true,
  snapshotDefaults: true,
  chooseFolder: true,
  startSnapshot: true,
  showFolder: true,
  getCourseRepo: true,
  chooseCourseRepo: true,
  forgetCourseRepo: true,
  courseOutline: true,
  exportOutline: true,
  courseSchedule: true,
  listObjects: true,
  getObjectDetail: true,
  chooseMarkdownFile: true,
  renderMarkdownBody: true,
  saveObject: true,
  setObjectPublished: true,
  deleteObject: true,
} as const satisfies Record<ApiMethod, true>;

// Object.keys widens to string[]; the satisfies clause above guarantees every key is an ApiMethod.
export const API_METHODS = Object.keys(METHODS) as ApiMethod[];

export function channelOf(method: ApiMethod): string {
  return `edutools:${method}`;
}

/**
 * What an invoke resolves to on the wire. Errors are carried as a message rather
 * than thrown, because Electron wraps a thrown error's message in
 * "Error invoking remote method ..." noise the user should not have to read.
 */
export type Reply<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

// ---------------------------------------------------------------------------
// Events: main to renderer, one way
// ---------------------------------------------------------------------------

/** One line of a running snapshot, from the pull's report callback. */
export interface SnapshotProgress {
  readonly courseId: string;
  readonly message: string;
}

/**
 * Every event the main process sends, and the payload each carries. Like
 * EdutoolsApi, this is the one definition: the sender in main, the preload's
 * checks and the renderer's listeners are all typed from it.
 */
export interface EdutoolsEvents {
  /** The application menu asked for a screen. */
  navigate: ScreenId;
  snapshotProgress: SnapshotProgress;
}

export type EventName = keyof EdutoolsEvents;

/** Sends an event to the renderer. The main-process api is handed one of these. */
export type Emit = <E extends EventName>(event: E, payload: EdutoolsEvents[E]) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A runtime check per event, because a payload arrives untyped. The mapped type
 * makes a missing check a type error, the way METHODS does for invokes, and its
 * keys double as the list of event names.
 */
export const EVENT_GUARDS: { readonly [E in EventName]: (value: unknown) => value is EdutoolsEvents[E] } = {
  navigate: isScreenId,
  snapshotProgress: (value): value is SnapshotProgress =>
    isRecord(value) && typeof value.courseId === "string" && typeof value.message === "string",
};

// Object.keys widens to string[]; EVENT_GUARDS has exactly one key per EventName.
export const EVENT_NAMES = Object.keys(EVENT_GUARDS) as EventName[];

export function eventChannelOf(event: EventName): string {
  return `edutools:event:${event}`;
}

type RawListener = (event: unknown, payload: unknown) => void;

/** The part of ipcRenderer a subscription uses, so a test can hand in an emitter. */
export interface EventSource {
  on(channel: string, listener: RawListener): unknown;
  removeListener(channel: string, listener: RawListener): unknown;
}

/**
 * Listen for one event, dropping any payload that fails its check. Returns the
 * unsubscribe function.
 */
export function subscribe<E extends EventName>(
  source: EventSource,
  event: E,
  listener: (payload: EdutoolsEvents[E]) => void,
): () => void {
  const guard: (value: unknown) => value is EdutoolsEvents[E] = EVENT_GUARDS[event];
  const channel = eventChannelOf(event);
  const handler: RawListener = (_event, payload) => {
    if (guard(payload)) {
      listener(payload);
    }
  };
  source.on(channel, handler);
  return () => {
    source.removeListener(channel, handler);
  };
}

/** The part of webContents that sending uses. */
export interface EventSink {
  send(channel: string, payload: unknown): void;
}

export function sendEvent<E extends EventName>(sink: EventSink, event: E, payload: EdutoolsEvents[E]): void {
  sink.send(eventChannelOf(event), payload);
}

/** What the preload adds on top of the invoked methods. */
export interface EdutoolsBridge extends EdutoolsApi {
  /** Subscribe to an event from the main process; returns the unsubscribe function. */
  on<E extends EventName>(event: E, listener: (payload: EdutoolsEvents[E]) => void): () => void;
}

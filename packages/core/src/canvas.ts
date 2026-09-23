/**
 * The only module that talks HTTP to Canvas. Everything else in the core is pure
 * and testable without a token; a new Canvas endpoint is a method here, never a
 * fetch call anywhere else.
 */

import { createWriteStream, mkdirSync, openAsBlob, statSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { Payload, RequestData, RequestParams } from "./types";

export const DEFAULT_ENDPOINT = "https://boisestatecanvas.instructure.com";

export interface CanvasOptions {
  /** Defaults to process.env.CANVAS_TOKEN; a missing token throws. */
  token?: string;
  /** Defaults to process.env.CANVAS_ENDPOINT, then DEFAULT_ENDPOINT. */
  endpoint?: string;
  /** Injected in tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Injected in tests so retry backoff does not really wait. */
  sleep?: (ms: number) => Promise<void>;
}

/** A rubric assessment: criterion id -> {"points": 4, "comments": "...", "rating_id": "..."} */
export type RubricAssessment = Record<string, Record<string, string | number>>;

// Pattern to extract the "next" URL from the Link header.
// Canvas returns: <https://...?page=2&per_page=100>; rel="next", ...
const LINK_NEXT_RE = /<([^>]+)>;\s*rel="next"/;

const DECIMAL_RE = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/** Canvas object kind -> the collection segment of its course-scoped path. */
export const KIND_PATHS: Readonly<Record<string, string>> = {
  page: "pages",
  assignment: "assignments",
  discussion: "discussion_topics",
  quiz: "quizzes",
  module: "modules",
};

/** Path segment for a Canvas object kind. */
export function kindPath(kind: string): string {
  const segment = Object.hasOwn(KIND_PATHS, kind) ? KIND_PATHS[kind] : undefined;
  if (segment === undefined) {
    throw new Error(
      `unknown Canvas kind '${kind}'; expected one of ${Object.keys(KIND_PATHS).join(", ")}`,
    );
  }
  return segment;
}

/**
 * Coerce a value out of a Canvas payload to a number, 0 if it is not one.
 *
 * Canvas JSON is typed `unknown` on the way in, and it is not consistent about
 * whether a weight or a position comes back as a number or as a string.
 */
export function asNumber(value: unknown): number {
  if (typeof value === "number") return Number.isNaN(value) ? 0 : value;
  // Number("") is 0 and Number("0x10") is 16, where Python's float() refuses
  // both, and parseFloat reads "40abc" as 40. Only a plain decimal is a number.
  if (typeof value === "string" && DECIMAL_RE.test(value.trim())) return Number(value.trim());
  return 0;
}

const TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 300_000; // the CyBOK PDF is 21 MB
const RETRY_STATUS: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 5;
// What requests follows before giving up, which download_attachment relied on.
const MAX_REDIRECTS = 30;

interface RequestOptions {
  data?: RequestData | undefined;
  params?: RequestParams | undefined;
  absolute?: boolean;
  timeoutMs?: number;
  redirect?: RequestInit["redirect"];
}

function hasEntries(data: RequestData | RequestParams | undefined): boolean {
  if (data === undefined) return false;
  return Array.isArray(data) ? data.length > 0 : Object.keys(data).length > 0;
}

/** Form or query pairs in order, repeated keys kept, as requests encodes them. */
function encodePairs(data: RequestData | RequestParams): URLSearchParams {
  const pairs: Array<[string, string]> = Array.isArray(data)
    ? data
    : Object.entries(data).map(([k, v]) => [k, String(v)]);
  return new URLSearchParams(pairs);
}

/** `url` with `params` appended to whatever query string it already carries. */
function withParams(url: string, params: RequestParams | undefined): string {
  if (!hasEntries(params) || params === undefined) return url;
  const target = new URL(url);
  for (const [k, v] of encodePairs(params)) target.searchParams.append(k, v);
  return target.toString();
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function jitter(): number {
  return Math.random() * 0.5;
}

export class CanvasLMS {
  readonly endpoint: string;
  protected readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(options: CanvasOptions = {}) {
    const token = options.token ?? process.env.CANVAS_TOKEN;
    if (!token) {
      throw new Error(
        "CANVAS_TOKEN not set. Add a Canvas token in Settings or run 'edutools init'.",
      );
    }
    this.token = token;
    this.endpoint = options.endpoint ?? process.env.CANVAS_ENDPOINT ?? DEFAULT_ENDPOINT;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.sleepImpl =
      options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private get headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` };
  }

  /** One attempt, no retry: what the read-only helpers below have always done. */
  private async send(url: string, params?: RequestParams): Promise<Response> {
    return this.fetchImpl(withParams(url, params), {
      method: "GET",
      headers: this.headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  /** Fetch all pages of a paginated Canvas API endpoint. */
  private async getPaginated(
    urlPath: string,
    params: Record<string, string | number>,
  ): Promise<Payload[]> {
    let url: string | undefined = this.endpoint + urlPath;
    let query: Record<string, string | number> = { ...params, per_page: 100 };
    const all: Payload[] = [];
    while (url !== undefined) {
      const response = await this.send(url, query);
      if (!response.ok) {
        throw new Error(`Canvas API error ${response.status}: ${await response.text()}`);
      }
      // Canvas answers a collection with a JSON list; its shape is its business.
      all.push(...((await response.json()) as Payload[]));

      // After the first request, params are baked into the next URL.
      query = {};

      const match = LINK_NEXT_RE.exec(response.headers.get("Link") ?? "");
      url = match?.[1];
    }
    return all;
  }

  /** Fetch a single Canvas API resource (no pagination). */
  private async getSingle(
    urlPath: string,
    params: Record<string, string | number>,
  ): Promise<Payload> {
    const response = await this.send(this.endpoint + urlPath, params);
    if (!response.ok) {
      throw new Error(`Canvas API error ${response.status}: ${await response.text()}`);
    }
    // A single resource is a JSON object; Canvas is loose about what is in it.
    return (await response.json()) as Payload;
  }

  async getCourses(options: { includeAll?: boolean } = {}): Promise<Payload[]> {
    const includeAll = options.includeAll ?? false;
    const params: Record<string, string | number> = {
      enrollment_type: "teacher",
      "include[]": "term",
    };
    if (!includeAll) params["state[]"] = "available";
    const courses = await this.getPaginated("/api/v1/courses", params);
    if (includeAll) return courses;
    const now = Date.now();
    const active: Payload[] = [];
    for (const c of courses) {
      if (c.workflow_state !== "available") continue;
      const term = c.term;
      const end =
        term !== null && typeof term === "object" && !Array.isArray(term)
          ? (term as Payload).end_at // narrowed to a plain object just above
          : undefined;
      if (typeof end === "string" && end && Date.parse(end) < now) continue;
      active.push(c);
    }
    return active;
  }

  /** Fetch a single course by ID. */
  async getCourse(courseId: string): Promise<Payload> {
    return this.getSingle(`/api/v1/courses/${courseId}`, {});
  }

  /** The course, carrying its syllabus body, which Canvas omits unless asked. */
  async getCourseWithSyllabus(courseId: string): Promise<Payload> {
    return this.getJson(`/api/v1/courses/${courseId}`, { "include[]": "syllabus_body" });
  }

  async getAssignments(courseId: string): Promise<Payload[]> {
    return this.getPaginated(`/api/v1/courses/${courseId}/assignments`, {});
  }

  async getStudents(courseId: string): Promise<Payload[]> {
    return this.getPaginated(`/api/v1/courses/${courseId}/users`, {
      "enrollment_type[]": "student",
    });
  }

  async getSubmissions(courseId: string, assignmentId: string): Promise<Payload[]> {
    return this.getPaginated(
      `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions`,
      {},
    );
  }

  async getAssignment(courseId: string, assignmentId: string): Promise<Payload> {
    return this.getSingle(`/api/v1/courses/${courseId}/assignments/${assignmentId}/`, {});
  }

  /** Return all submissions whose grade is unset (the '-' in the Canvas gradebook). */
  async getUngradedSubmissions(courseId: string): Promise<Payload[]> {
    const submissions = await this.getPaginated(
      `/api/v1/courses/${courseId}/students/submissions`,
      { "student_ids[]": "all" },
    );
    return submissions.filter((s) => s.grade === null || s.grade === undefined);
  }

  // ------------------------------------------------------------------
  // Write half: retrying request layer + typed resource methods.
  //
  // Canvas throttles with 429 and reports quota in X-Rate-Limit-Remaining.
  // Sequential requests rarely trip it; parallel ones take a pre-flight
  // penalty, so everything here is deliberately sequential.
  // ------------------------------------------------------------------

  /** Issue one Canvas request, retrying transient failures. */
  private async request(
    method: string,
    url: string,
    options: RequestOptions = {},
  ): Promise<Response> {
    const target = options.absolute ? url : this.endpoint + url;
    const init: RequestInit = { method, headers: { ...this.headers } };
    if (options.redirect) init.redirect = options.redirect;
    if (options.data !== undefined && hasEntries(options.data)) {
      init.body = encodePairs(options.data).toString();
      init.headers = { ...this.headers, "Content-Type": "application/x-www-form-urlencoded" };
    }
    const full = withParams(target, options.params);
    let lastError = "";
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(full, {
          ...init,
          signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
        });
      } catch (error) {
        lastError =
          error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        if (attempt === MAX_ATTEMPTS) break;
        await this.sleepImpl((Math.min(2 ** attempt, 30) + jitter()) * 1000);
        continue;
      }

      if (response.ok || !RETRY_STATUS.has(response.status)) return response;

      lastError = `HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`;
      if (attempt === MAX_ATTEMPTS) break;
      // Honour the throttle rather than hammering it.
      let backoff = Math.min(2 ** attempt, 30) + jitter();
      if (response.status === 429) backoff = Math.max(backoff, 5.0);
      await this.sleepImpl(backoff * 1000);
    }

    throw new Error(
      `Canvas API error after ${MAX_ATTEMPTS} attempts (${method} ${target}): ${lastError}`,
    );
  }

  private async json(
    method: string,
    urlPath: string,
    data?: RequestData,
    params?: RequestParams,
  ): Promise<Payload> {
    const response = await this.request(method, urlPath, { data, params });
    if (!response.ok) {
      throw new Error(`Canvas API error ${response.status}: ${await response.text()}`);
    }
    // A single resource is a JSON object; Canvas is loose about what is in it.
    return (await response.json()) as Payload;
  }

  /** GET a single resource, with retries. Used by the verify pass. */
  async getJson(urlPath: string, params?: Record<string, string | number>): Promise<Payload> {
    return this.json("GET", urlPath, undefined, params);
  }

  /** GET a paginated collection, with retries. */
  async listJson(urlPath: string, params?: Record<string, string | number>): Promise<Payload[]> {
    let url: string | undefined = this.endpoint + urlPath;
    const merged: Record<string, string | number> = { ...(params ?? {}), per_page: 100 };
    const results: Payload[] = [];
    let first = true;
    while (url !== undefined) {
      const response = await this.request("GET", url, {
        params: first ? merged : undefined,
        absolute: true,
      });
      if (!response.ok) {
        throw new Error(`Canvas API error ${response.status}: ${await response.text()}`);
      }
      // Canvas answers a collection with a JSON list; its shape is its business.
      results.push(...((await response.json()) as Payload[]));
      first = false;
      const match = LINK_NEXT_RE.exec(response.headers.get("Link") ?? "");
      url = match?.[1];
    }
    return results;
  }

  /** True if the resource is present (a 404 is an answer, not an error). */
  async exists(urlPath: string): Promise<boolean> {
    const response = await this.request("GET", urlPath);
    return response.ok;
  }

  // -- course ---------------------------------------------------------

  async updateSyllabus(courseId: string, body: string): Promise<Payload> {
    return this.json("PUT", `/api/v1/courses/${courseId}`, { "course[syllabus_body]": body });
  }

  // -- assignment groups ----------------------------------------------

  async listAssignmentGroups(
    courseId: string,
    options: { withAssignments?: boolean } = {},
  ): Promise<Payload[]> {
    // Canvas leaves the assignments out of this payload unless asked, so a
    // caller counting what is in a group has to opt in or it counts zero.
    const params = options.withAssignments ? { "include[]": "assignments" } : undefined;
    return this.listJson(`/api/v1/courses/${courseId}/assignment_groups`, params);
  }

  async createAssignmentGroup(courseId: string, fields: Record<string, string>): Promise<Payload> {
    // This endpoint takes bare parameters (name, position, group_weight),
    // not the assignment_group[...] bracket namespace the docs suggest.
    return this.json("POST", `/api/v1/courses/${courseId}/assignment_groups`, fields);
  }

  async updateAssignmentGroup(
    courseId: string,
    groupId: string,
    fields: Record<string, string>,
  ): Promise<Payload> {
    return this.json("PUT", `/api/v1/courses/${courseId}/assignment_groups/${groupId}`, fields);
  }

  /**
   * Weight the final grade by assignment group, or stop doing so.
   *
   * Canvas stores a group_weight on every group either way and ignores all of
   * them until this course-level flag is on, so a course that sets weights and
   * not this reads as if the weights never took.
   */
  async setGroupWeighting(courseId: string, enabled: boolean): Promise<Payload> {
    return this.json("PUT", `/api/v1/courses/${courseId}`, {
      "course[apply_assignment_group_weights]": String(enabled),
    });
  }

  /**
   * Every assignment, with retries, which getAssignments does not have.
   *
   * A pull makes hundreds of sequential requests, so one 429 partway through
   * should back off rather than abandon the snapshot.
   */
  async listAssignments(courseId: string): Promise<Payload[]> {
    return this.listJson(`/api/v1/courses/${courseId}/assignments`);
  }

  // -- pages ----------------------------------------------------------

  async listPages(courseId: string): Promise<Payload[]> {
    return this.listJson(`/api/v1/courses/${courseId}/pages`);
  }

  async getPage(courseId: string, pageUrl: string): Promise<Payload> {
    return this.getJson(`/api/v1/courses/${courseId}/pages/${pageUrl}`);
  }

  async createPage(
    courseId: string,
    title: string,
    body: string,
    published = false,
  ): Promise<Payload> {
    return this.json("POST", `/api/v1/courses/${courseId}/pages`, {
      "wiki_page[title]": title,
      "wiki_page[body]": body,
      "wiki_page[published]": String(published),
    });
  }

  async updatePage(
    courseId: string,
    pageUrl: string,
    changes: { title?: string; body?: string; published?: boolean } = {},
  ): Promise<Payload> {
    const data: Record<string, string> = {};
    if (changes.title !== undefined) data["wiki_page[title]"] = changes.title;
    if (changes.body !== undefined) data["wiki_page[body]"] = changes.body;
    if (changes.published !== undefined) data["wiki_page[published]"] = String(changes.published);
    return this.json("PUT", `/api/v1/courses/${courseId}/pages/${pageUrl}`, data);
  }

  // -- assignments ----------------------------------------------------

  async getAssignmentFull(courseId: string, assignmentId: string): Promise<Payload> {
    return this.getJson(`/api/v1/courses/${courseId}/assignments/${assignmentId}`);
  }

  async createAssignment(courseId: string, fields: RequestData): Promise<Payload> {
    return this.json("POST", `/api/v1/courses/${courseId}/assignments`, fields);
  }

  async updateAssignment(
    courseId: string,
    assignmentId: string,
    fields: RequestData,
  ): Promise<Payload> {
    return this.json("PUT", `/api/v1/courses/${courseId}/assignments/${assignmentId}`, fields);
  }

  // -- discussions ----------------------------------------------------

  async listDiscussions(courseId: string): Promise<Payload[]> {
    return this.listJson(`/api/v1/courses/${courseId}/discussion_topics`);
  }

  async listAnnouncements(courseId: string): Promise<Payload[]> {
    // Announcements are discussion topics, but the topics listing leaves them
    // out unless asked for them alone.
    return this.listJson(`/api/v1/courses/${courseId}/discussion_topics`, {
      only_announcements: "true",
    });
  }

  async getDiscussion(courseId: string, topicId: string): Promise<Payload> {
    return this.getJson(`/api/v1/courses/${courseId}/discussion_topics/${topicId}`);
  }

  async createDiscussion(courseId: string, fields: Record<string, string>): Promise<Payload> {
    return this.json("POST", `/api/v1/courses/${courseId}/discussion_topics`, fields);
  }

  async updateDiscussion(
    courseId: string,
    topicId: string,
    fields: Record<string, string>,
  ): Promise<Payload> {
    return this.json("PUT", `/api/v1/courses/${courseId}/discussion_topics/${topicId}`, fields);
  }

  // -- quizzes --------------------------------------------------------

  async listQuizzes(courseId: string): Promise<Payload[]> {
    return this.listJson(`/api/v1/courses/${courseId}/quizzes`);
  }

  async getQuiz(courseId: string, quizId: string): Promise<Payload> {
    return this.getJson(`/api/v1/courses/${courseId}/quizzes/${quizId}`);
  }

  async createQuiz(courseId: string, fields: Record<string, string>): Promise<Payload> {
    return this.json("POST", `/api/v1/courses/${courseId}/quizzes`, fields);
  }

  async updateQuiz(
    courseId: string,
    quizId: string,
    fields: Record<string, string>,
  ): Promise<Payload> {
    return this.json("PUT", `/api/v1/courses/${courseId}/quizzes/${quizId}`, fields);
  }

  async listQuizQuestions(courseId: string, quizId: string): Promise<Payload[]> {
    return this.listJson(`/api/v1/courses/${courseId}/quizzes/${quizId}/questions`);
  }

  /**
   * Create one question. `fields` is a list of pairs because Canvas uses
   * repeated bracketed keys for answers: question[answers][][answer_text].
   */
  async createQuizQuestion(
    courseId: string,
    quizId: string,
    fields: Array<[string, string]>,
  ): Promise<Payload> {
    return this.json("POST", `/api/v1/courses/${courseId}/quizzes/${quizId}/questions`, fields);
  }

  async deleteQuizQuestion(courseId: string, quizId: string, questionId: string): Promise<void> {
    await this.request(
      "DELETE",
      `/api/v1/courses/${courseId}/quizzes/${quizId}/questions/${questionId}`,
    );
  }

  // -- modules --------------------------------------------------------

  async listModules(courseId: string): Promise<Payload[]> {
    return this.listJson(`/api/v1/courses/${courseId}/modules`);
  }

  async createModule(
    courseId: string,
    name: string,
    position: number,
    published = false,
  ): Promise<Payload> {
    return this.json("POST", `/api/v1/courses/${courseId}/modules`, {
      "module[name]": name,
      "module[position]": String(position),
      "module[published]": String(published),
    });
  }

  async updateModule(
    courseId: string,
    moduleId: string,
    fields: Record<string, string>,
  ): Promise<Payload> {
    return this.json("PUT", `/api/v1/courses/${courseId}/modules/${moduleId}`, fields);
  }

  async listModuleItems(courseId: string, moduleId: string): Promise<Payload[]> {
    return this.listJson(`/api/v1/courses/${courseId}/modules/${moduleId}/items`);
  }

  async createModuleItem(
    courseId: string,
    moduleId: string,
    fields: Record<string, string>,
  ): Promise<Payload> {
    return this.json("POST", `/api/v1/courses/${courseId}/modules/${moduleId}/items`, fields);
  }

  async deleteModuleItem(courseId: string, moduleId: string, itemId: string): Promise<void> {
    await this.request("DELETE", `/api/v1/courses/${courseId}/modules/${moduleId}/items/${itemId}`);
  }

  // -- files ----------------------------------------------------------

  async listFiles(courseId: string): Promise<Payload[]> {
    return this.listJson(`/api/v1/courses/${courseId}/files`);
  }

  /** Every folder, whose full_name is the only place a file's path lives. */
  async listFolders(courseId: string): Promise<Payload[]> {
    return this.listJson(`/api/v1/courses/${courseId}/folders`);
  }

  async getFile(fileId: string): Promise<Payload> {
    return this.getJson(`/api/v1/files/${fileId}`);
  }

  /**
   * Upload a file using Canvas's three-step flow, and confirm it landed.
   *
   * Step 1 announces the file and returns an upload target; step 2 POSTs the
   * bytes with `file` last; step 3 follows the redirect to finalise. Skipping
   * step 3 leaves the file stuck in a 'pending' state.
   */
  async uploadFile(
    courseId: string,
    filePath: string,
    folder = "course files",
    overwrite = true,
  ): Promise<Payload> {
    const name = path.basename(filePath);
    const size = statSync(filePath).size;
    const announce = await this.json("POST", `/api/v1/courses/${courseId}/files`, {
      name,
      size: String(size),
      parent_folder_path: folder,
      on_duplicate: overwrite ? "overwrite" : "rename",
    });
    const uploadUrl = String(announce.upload_url);
    const uploadParams = announce.upload_params ?? {};
    if (uploadParams === null || typeof uploadParams !== "object" || Array.isArray(uploadParams)) {
      throw new Error(
        `unexpected upload_params for ${name}: ${JSON.stringify(uploadParams)}`,
      );
    }

    // Step 2. The file field must come after every other parameter. The upload
    // host is not Canvas, so the token is not sent there.
    const form = new FormData();
    for (const [k, v] of Object.entries(uploadParams)) form.append(k, String(v));
    form.append("file", await openAsBlob(filePath), name);
    const response = await this.fetchImpl(uploadUrl, {
      method: "POST",
      body: form,
      redirect: "manual",
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    if (![200, 201, 301, 302, 303].includes(response.status)) {
      throw new Error(
        `Canvas file upload failed for ${name}: ` +
          `HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`,
      );
    }

    // Step 3. Confirm, otherwise the file never becomes available.
    const location = response.headers.get("Location");
    let result: Payload;
    if (location) {
      const confirmed = await this.request("GET", new URL(location, uploadUrl).toString(), {
        absolute: true,
      });
      if (!confirmed.ok) {
        throw new Error(
          `Canvas file confirmation failed for ${name}: ${(await confirmed.text()).slice(0, 200)}`,
        );
      }
      // The confirmed file is a JSON object describing it.
      result = (await confirmed.json()) as Payload;
    } else {
      // Without a redirect, the upload answer is itself the file's JSON object.
      result = (await response.json()) as Payload;
    }

    const reported = result.size;
    const uploaded =
      typeof reported === "number" || typeof reported === "string"
        ? Math.trunc(Number(reported))
        : -1;
    if (uploaded !== size) {
      throw new Error(`${name} uploaded as ${uploaded} bytes but the local file is ${size}`);
    }
    return result;
  }

  // -- one object at a time -------------------------------------------
  //
  // The publisher drives a whole repository through the typed methods. These
  // four cover the other half: create, read, change, or remove a single object
  // of any kind. The only per-kind difference is the path segment, and a page
  // is addressed by its url slug where everything else uses a numeric id.
  // Canvas answers a DELETE with the deleted object rather than an empty body,
  // so deleteObject hands it back: it is the only record of what went.

  async createObject(
    kind: string,
    courseId: string,
    fields: Record<string, string>,
  ): Promise<Payload> {
    return this.json("POST", `/api/v1/courses/${courseId}/${kindPath(kind)}`, fields);
  }

  async getObject(kind: string, courseId: string, objectId: string): Promise<Payload> {
    return this.getJson(`/api/v1/courses/${courseId}/${kindPath(kind)}/${objectId}`);
  }

  async updateObject(
    kind: string,
    courseId: string,
    objectId: string,
    fields: Record<string, string>,
  ): Promise<Payload> {
    return this.json("PUT", `/api/v1/courses/${courseId}/${kindPath(kind)}/${objectId}`, fields);
  }

  async deleteObject(kind: string, courseId: string, objectId: string): Promise<Payload> {
    return this.json("DELETE", `/api/v1/courses/${courseId}/${kindPath(kind)}/${objectId}`);
  }

  /** Files live outside the course namespace, so they get their own method. */
  async deleteFile(fileId: string): Promise<Payload> {
    return this.json("DELETE", `/api/v1/files/${fileId}`);
  }

  // -- submissions and grading -----------------------------------------
  //
  // One endpoint carries both halves of "grade with feedback": submission[]
  // fields set the score, comment[] fields attach the feedback. Sending only
  // comment[text_comment] leaves the submission ungraded but commented, which
  // is how you return work without putting a number on it.

  /** Fetch one submission, with its comments and rubric by default. */
  async getSubmission(
    courseId: string,
    assignmentId: string,
    userId: string,
    options: { include?: readonly string[] } = {},
  ): Promise<Payload> {
    const include = options.include ?? ["submission_comments", "rubric_assessment", "user"];
    const response = await this.request(
      "GET",
      `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/${userId}`,
      { params: include.map((name): [string, string] => ["include[]", name]) },
    );
    if (!response.ok) {
      throw new Error(`Canvas API error ${response.status}: ${await response.text()}`);
    }
    // A submission is a JSON object; Canvas is loose about what is in it.
    return (await response.json()) as Payload;
  }

  /**
   * Set a score and/or attach a comment on one submission.
   *
   * `grade` is whatever the assignment's grading type accepts: points
   * ("18"), a percentage ("92%"), a letter ("B+"), or "pass"/"fail".
   */
  async gradeSubmission(
    courseId: string,
    assignmentId: string,
    userId: string,
    options: {
      grade?: string;
      comment?: string;
      groupComment?: boolean;
      excuse?: boolean;
      latePolicyStatus?: string;
      secondsLateOverride?: number;
      rubricAssessment?: RubricAssessment;
    } = {},
  ): Promise<Payload> {
    const data: Record<string, string> = {};
    if (options.grade !== undefined) data["submission[posted_grade]"] = options.grade;
    if (options.excuse !== undefined) data["submission[excuse]"] = String(options.excuse);
    if (options.latePolicyStatus !== undefined) {
      data["submission[late_policy_status]"] = options.latePolicyStatus;
    }
    if (options.secondsLateOverride !== undefined) {
      data["submission[seconds_late_override]"] = String(options.secondsLateOverride);
    }
    if (options.comment) {
      data["comment[text_comment]"] = options.comment;
      if (options.groupComment) data["comment[group_comment]"] = "true";
    }
    if (options.rubricAssessment) {
      for (const [criterionId, entry] of Object.entries(options.rubricAssessment)) {
        for (const [field, value] of Object.entries(entry)) {
          data[`rubric_assessment[${criterionId}][${field}]`] = String(value);
        }
      }
    }

    if (Object.keys(data).length === 0) {
      throw new Error("gradeSubmission needs at least a grade, a comment, or a rubric");
    }

    return this.json(
      "PUT",
      `/api/v1/courses/${courseId}/assignments/${assignmentId}/submissions/${userId}`,
      data,
    );
  }

  /**
   * Stream a submission attachment or a course file to disk, return its size.
   *
   * Canvas download URLs redirect to blob storage. Redirects are followed by hand
   * so the Authorization header is dropped as soon as the host changes, as
   * requests does: the token must never reach the storage host.
   */
  async downloadAttachment(url: string, dest: string): Promise<number> {
    mkdirSync(path.dirname(dest), { recursive: true });
    let current = new URL(url);
    const origin = current.hostname;
    let withToken = true;
    let response: Response | undefined;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      response = await this.fetchImpl(current.toString(), {
        method: "GET",
        headers: withToken ? this.headers : {},
        redirect: "manual",
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
      });
      const location = response.headers.get("Location");
      if (!isRedirect(response.status) || !location) break;
      await response.body?.cancel();
      current = new URL(location, current);
      if (current.hostname !== origin) withToken = false;
      if (hop === MAX_REDIRECTS) {
        throw new Error(`Canvas download failed for ${path.basename(dest)}: too many redirects`);
      }
    }
    if (response === undefined || !response.ok) {
      throw new Error(
        `Canvas download failed for ${path.basename(dest)}: HTTP ${response?.status ?? "none"}`,
      );
    }

    let written = 0;
    if (response.body === null) {
      await pipeline(Readable.from([]), createWriteStream(dest));
      return 0;
    }
    await pipeline(
      // The DOM and node:stream/web ReadableStream types describe the same object
      // but are declared separately, so fetch's body needs a cast to reach fromWeb.
      Readable.fromWeb(response.body as unknown as NodeReadableStream<Uint8Array>),
      async function* (source: AsyncIterable<Uint8Array>) {
        for await (const chunk of source) {
          written += chunk.length;
          yield chunk;
        }
      },
      createWriteStream(dest),
    );
    return written;
  }

  // -- rubrics --------------------------------------------------------

  async listRubrics(courseId: string): Promise<Payload[]> {
    return this.listJson(`/api/v1/courses/${courseId}/rubrics`);
  }

  async createRubric(courseId: string, fields: Array<[string, string]>): Promise<Payload> {
    return this.json("POST", `/api/v1/courses/${courseId}/rubrics`, fields);
  }
}

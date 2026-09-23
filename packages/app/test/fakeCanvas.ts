import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Payload } from "@edutools/core/types";
import type { CanvasClient } from "../src/main/api";

export interface FakeCall {
  readonly method: string;
  readonly args: unknown[];
}

/**
 * An in-memory course that answers every CanvasClient method and records each
 * call, so a test can check what was asked for and in what order. Replace a
 * field to change what Canvas "has"; set `failing` to make a listing throw the
 * way an HTTP error from CanvasLMS does.
 */
export class FakeCanvas implements CanvasClient {
  readonly calls: FakeCall[] = [];
  courses: Payload[] = [];
  course: Payload = { id: 20, name: "Software Engineering", course_code: "CS 471" };
  assignments: Payload[] = [];
  groups: Payload[] = [];
  pages: Payload[] = [];
  modules: Payload[] = [];
  moduleItems: Record<string, Payload[]> = {};
  files: Payload[] = [];
  folders: Payload[] = [{ id: 1, full_name: "course files" }];
  failing = new Set<string>();
  /** Awaited at the start of every call, so a test can hold a pull mid-flight. */
  gate: Promise<void> = Promise.resolve();

  constructor(
    readonly endpoint = "",
    readonly token = "",
  ) {}

  private async answer<T>(method: string, args: unknown[], value: T): Promise<T> {
    this.calls.push({ method, args });
    await this.gate;
    if (this.failing.has(method)) {
      throw new Error(`Canvas API error 403: ${method} is not allowed`);
    }
    // A copy, as a real response would be: the pull adds `items` to modules.
    return structuredClone(value);
  }

  getCourses(options?: { includeAll?: boolean }) {
    return this.answer("getCourses", [options], this.courses);
  }
  getCourse(courseId: string) {
    return this.answer("getCourse", [courseId], this.course);
  }
  getCourseWithSyllabus(courseId: string) {
    return this.answer("getCourseWithSyllabus", [courseId], this.course);
  }
  listPages(courseId: string) {
    return this.answer(
      "listPages",
      [courseId],
      this.pages.map(({ body: _body, ...rest }) => rest),
    );
  }
  getPage(courseId: string, pageUrl: string) {
    return this.answer("getPage", [courseId, pageUrl], this.pages.find((p) => p.url === pageUrl) ?? {});
  }
  listAssignments(courseId: string) {
    return this.answer("listAssignments", [courseId], this.assignments);
  }
  listDiscussions(courseId: string) {
    return this.answer("listDiscussions", [courseId], this.discussions);
  }
  listAnnouncements(courseId: string) {
    return this.answer("listAnnouncements", [courseId], [] as Payload[]);
  }
  listQuizzes(courseId: string) {
    return this.answer("listQuizzes", [courseId], this.quizzes);
  }
  listQuizQuestions(courseId: string, quizId: string) {
    return this.answer("listQuizQuestions", [courseId, quizId], [] as Payload[]);
  }
  listModules(courseId: string) {
    return this.answer("listModules", [courseId], this.modules);
  }
  listModuleItems(courseId: string, moduleId: string) {
    return this.answer("listModuleItems", [courseId, moduleId], this.moduleItems[moduleId] ?? []);
  }
  listAssignmentGroups(courseId: string, options?: { withAssignments?: boolean }) {
    const groups = options?.withAssignments
      ? this.groups.map((g) => ({ ...g, assignments: this.assignments.filter((a) => a.assignment_group_id === g.id) }))
      : this.groups;
    return this.answer("listAssignmentGroups", [courseId, options], groups);
  }
  listRubrics(courseId: string) {
    return this.answer("listRubrics", [courseId], [] as Payload[]);
  }
  listFolders(courseId: string) {
    return this.answer("listFolders", [courseId], this.folders);
  }
  listFiles(courseId: string) {
    return this.answer("listFiles", [courseId], this.files);
  }
  async downloadAttachment(url: string, dest: string): Promise<number> {
    await this.answer("downloadAttachment", [url, dest], null);
    const file = this.files.find((f) => f.url === url);
    const size = typeof file?.size === "number" ? file.size : 0;
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, "x".repeat(size));
    return size;
  }

  discussions: Payload[] = [];
  quizzes: Payload[] = [];

  private collection(kind: string): Payload[] {
    const lists: Record<string, Payload[]> = {
      page: this.pages,
      assignment: this.assignments,
      discussion: this.discussions,
      quiz: this.quizzes,
      module: this.modules,
    };
    return lists[kind] ?? [];
  }

  private find(kind: string, objectId: string): Payload {
    const found = this.collection(kind).find((o) => String(kind === "page" ? o.url : o.id) === objectId);
    if (!found) {
      throw new Error(`Canvas API error 404: no ${kind} ${objectId}`);
    }
    return found;
  }

  getObject(kind: string, courseId: string, objectId: string) {
    return this.answer("getObject", [kind, courseId, objectId], null).then(() => structuredClone(this.find(kind, objectId)));
  }
  createObject(kind: string, courseId: string, fields: Record<string, string>) {
    const created: Payload =
      kind === "page" ? { url: "new-page", title: "New", published: false } : { id: 900, name: "New", title: "New", published: false };
    return this.answer("createObject", [kind, courseId, fields], created);
  }
  /** Echoes the stored object, with `published` changed when the fields say so. */
  updateObject(kind: string, courseId: string, objectId: string, fields: Record<string, string>) {
    return this.answer("updateObject", [kind, courseId, objectId, fields], null).then(() => {
      const stored = this.find(kind, objectId);
      const published = Object.entries(fields).find(([k]) => k === "published" || k.endsWith("[published]"));
      if (published) {
        stored.published = published[1] === "true";
      }
      return structuredClone(stored);
    });
  }
  deleteObject(kind: string, courseId: string, objectId: string) {
    return this.answer("deleteObject", [kind, courseId, objectId], null).then(() => structuredClone(this.find(kind, objectId)));
  }

  /** The methods called, in order. */
  methods(): string[] {
    return this.calls.map((c) => c.method);
  }
}

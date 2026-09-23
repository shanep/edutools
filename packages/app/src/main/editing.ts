/**
 * Edit object: read, create, change, publish and delete one Canvas object.
 *
 * Canvas writes are real and immediate, so the rules the CLI keeps are kept
 * here too, in main rather than trusted to the page: a new object is created
 * unpublished, a save to an object Canvas reports as published is refused unless
 * the designer said to change it anyway, and a delete reads the object first so
 * nothing is removed that could not be named.
 */

import { buildFields } from "@edutools/core/objects";
import type { Payload } from "@edutools/core/types";
import type { BodyInput, EditKind, ObjectChanges, ObjectDetail, ObjectSummary, SaveObjectRequest } from "../shared/ipc";
import { EDIT_KINDS } from "../shared/ipc";
import { toObjectDetail, toObjectSummary } from "../shared/objects";
import type { CanvasClient } from "./api";
import { checkHtml, managedBy, renderBody } from "./repo";

export function requireKind(value: unknown): EditKind {
  const kind = EDIT_KINDS.find((k) => k === value);
  if (!kind) {
    throw new Error(`Unknown kind '${String(value)}'; expected one of ${EDIT_KINDS.join(", ")}.`);
  }
  return kind;
}

/**
 * An object id from the renderer. A page is addressed by its url slug, anything
 * else by a number; either way it is spliced into a Canvas path, so nothing that
 * could walk out of it is accepted.
 */
export function requireObjectId(kind: EditKind, value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  const ok = kind === "page" ? /^[A-Za-z0-9_~-][A-Za-z0-9._~-]*$/.test(id) && !id.includes("..") : /^\d+$/.test(id);
  if (!ok) {
    throw new Error(`'${id}' is not a ${kind} ${kind === "page" ? "url slug" : "id"}.`);
  }
  return id;
}

// ISO 8601 with a time zone, as Canvas and the push send it; "" clears the date.
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function requireTimestamp(value: unknown, what: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "" || (typeof value === "string" && TIMESTAMP_RE.test(value))) {
    return value;
  }
  throw new Error(`The ${what} date '${String(value)}' is not a date and time with a time zone.`);
}

export async function listObjects(client: CanvasClient, courseId: string, kind: EditKind): Promise<ObjectSummary[]> {
  const lists: Record<EditKind, () => Promise<Payload[]>> = {
    page: () => client.listPages(courseId),
    assignment: () => client.listAssignments(courseId),
    discussion: () => client.listDiscussions(courseId),
    quiz: () => client.listQuizzes(courseId),
    module: () => client.listModules(courseId),
  };
  return (await lists[kind]()).map((p) => toObjectSummary(kind, p));
}

export interface EditContext {
  readonly client: CanvasClient;
  readonly endpoint: string;
  readonly courseId: string;
  readonly repo: string | null;
}

function detail(ctx: EditContext, kind: EditKind, payload: Payload): ObjectDetail {
  // Canvas gives a module no html_url; its Modules page is where it is edited.
  const fallback = `${ctx.endpoint}/courses/${ctx.courseId}/${kind === "module" ? "modules" : ""}`;
  const shaped = toObjectDetail(kind, payload, fallback, null);
  return { ...shaped, managedBy: managedBy(ctx.repo, ctx.courseId, kind, shaped.id) };
}

export async function getDetail(ctx: EditContext, kind: EditKind, id: string): Promise<ObjectDetail> {
  return detail(ctx, kind, await ctx.client.getObject(kind, ctx.courseId, id));
}

function bodyHtml(body: BodyInput, repo: string | null): { html: string; title: string | null } {
  if (body.kind === "html") {
    if (typeof body.html !== "string") {
      throw new Error("The body is missing.");
    }
    checkHtml(body.html);
    return { html: body.html, title: null };
  }
  const rendered = renderBody(body.file, repo);
  return { html: rendered.html, title: rendered.title || null };
}

/** The changes as Canvas form fields, through objects.ts so every kind's names are right. */
function fieldsFor(
  kind: EditKind,
  changes: ObjectChanges,
  repo: string | null,
  creating: boolean,
): Record<string, string> {
  const body = changes.body ? bodyHtml(changes.body, repo) : null;
  const title = typeof changes.title === "string" && changes.title.trim() ? changes.title.trim() : null;
  const points = changes.points;
  if (points !== undefined && (typeof points !== "number" || !Number.isFinite(points) || points < 0)) {
    throw new Error("Points must be a number, zero or more.");
  }
  const chosenTitle = title ?? (creating ? body?.title : null) ?? null;
  if (creating && !chosenTitle) {
    throw new Error("A new object needs a title (or a markdown body with a # Title line).");
  }
  return buildFields(kind, {
    title: chosenTitle,
    body: body?.html ?? null,
    points: points ?? null,
    due: requireTimestamp(changes.dueAt, "due") ?? null,
    unlock: requireTimestamp(changes.unlockAt, "available from") ?? null,
    lock: requireTimestamp(changes.lockAt, "until") ?? null,
    // New objects are unpublished, as `create` and `push` leave them. An update
    // never touches visibility: that is what the Publish buttons are for.
    published: creating ? false : null,
  });
}

export async function saveObject(ctx: EditContext, request: SaveObjectRequest): Promise<ObjectDetail> {
  const kind = requireKind(request?.kind);
  const changes: ObjectChanges = request?.changes ?? {};
  if (request.id === null) {
    const fields = fieldsFor(kind, changes, ctx.repo, true);
    return detail(ctx, kind, await ctx.client.createObject(kind, ctx.courseId, fields));
  }
  const id = requireObjectId(kind, request.id);
  const fields = fieldsFor(kind, changes, ctx.repo, false);
  if (Object.keys(fields).length === 0) {
    throw new Error("Nothing has changed, so there is nothing to save.");
  }
  // Canvas's answer now, not what the page last saw: it may have been
  // published in the browser since the form was filled in.
  const current = await ctx.client.getObject(kind, ctx.courseId, id);
  if (current.published === true && request.changeVisible !== true) {
    throw new Error(
      "This is published, so students can see it. Tick 'This is visible to students; change it anyway' to save.",
    );
  }
  return detail(ctx, kind, await ctx.client.updateObject(kind, ctx.courseId, id, fields));
}

export async function setPublished(ctx: EditContext, kind: EditKind, id: string, published: boolean): Promise<ObjectDetail> {
  if (typeof published !== "boolean") {
    throw new Error("Say whether to publish or unpublish.");
  }
  const fields = buildFields(kind, { published });
  return detail(ctx, kind, await ctx.client.updateObject(kind, ctx.courseId, id, fields));
}

export async function deleteObject(ctx: EditContext, kind: EditKind, id: string): Promise<string> {
  // Never delete what could not be read first: the confirmation named it.
  const target = detail(ctx, kind, await ctx.client.getObject(kind, ctx.courseId, id));
  await ctx.client.deleteObject(kind, ctx.courseId, id);
  return target.title || `${kind} ${id}`;
}

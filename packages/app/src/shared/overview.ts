/**
 * Reduce Canvas payloads to the rows the Course overview shows. Pure, and shared
 * so the main process builds the rows and the tests check them without Electron.
 */

import type {
  AssignmentGroupList,
  AssignmentGroupRow,
  AssignmentRow,
  ModuleItemRow,
  ModuleRow,
  PageRow,
} from "./ipc";

type Payload = Record<string, unknown>;

function text(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return "";
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  // Canvas sends some numbers as strings, depending on the endpoint and version.
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** `assignment_group_id` -> group name, from the course's assignment groups. */
export function groupNames(groups: readonly Payload[]): Map<string, string> {
  return new Map(groups.map((g) => [text(g.id), text(g.name)]));
}

export function toAssignmentRow(assignment: Payload, groups: ReadonlyMap<string, string>): AssignmentRow {
  return {
    id: text(assignment.id),
    name: text(assignment.name),
    points: numberOrNull(assignment.points_possible),
    dueAt: textOrNull(assignment.due_at),
    published: assignment.published === true,
    group: groups.get(text(assignment.assignment_group_id)) ?? "",
    htmlUrl: text(assignment.html_url),
  };
}

export function toModuleItemRow(item: Payload): ModuleItemRow {
  return {
    id: text(item.id),
    title: text(item.title),
    type: text(item.type),
    indent: numberOrNull(item.indent) ?? 0,
    published: typeof item.published === "boolean" ? item.published : null,
    htmlUrl: text(item.html_url),
  };
}

/**
 * A module and its items. Canvas gives a module no html_url of its own, so it
 * links to the course's Modules page, anchored where Canvas anchors each module.
 */
export function toModuleRow(module: Payload, items: readonly Payload[], modulesUrl: string): ModuleRow {
  const id = text(module.id);
  return {
    id,
    name: text(module.name),
    published: module.published === true,
    htmlUrl: `${modulesUrl}#context_module_${id}`,
    items: items.map(toModuleItemRow),
  };
}

export function toPageRow(page: Payload): PageRow {
  return {
    url: text(page.url),
    title: text(page.title),
    published: page.published === true,
    updatedAt: textOrNull(page.updated_at),
    htmlUrl: text(page.html_url),
  };
}

/**
 * Groups from `listAssignmentGroups(..., { withAssignments: true })`: without that
 * include Canvas leaves `assignments` out and every group would count zero.
 */
export function toAssignmentGroupRow(group: Payload): AssignmentGroupRow {
  return {
    id: text(group.id),
    name: text(group.name),
    weight: numberOrNull(group.group_weight),
    assignmentCount: Array.isArray(group.assignments) ? group.assignments.length : 0,
  };
}

export function toAssignmentGroupList(
  course: Payload,
  groups: readonly Payload[],
  assignmentsUrl: string,
): AssignmentGroupList {
  return {
    weighted: course.apply_assignment_group_weights === true,
    groups: groups.map(toAssignmentGroupRow),
    htmlUrl: assignmentsUrl,
  };
}

/**
 * A Canvas timestamp in the viewer's local time, or `fallback` when there is
 * none. `timeZone` exists for tests; the app leaves it to the system.
 */
export function formatDate(iso: string | null, fallback = "", timeZone?: string): string {
  if (!iso) {
    return fallback;
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short", timeZone });
}

/** Points as Canvas shows them: 10, 2.5, or blank for an ungraded item. */
export function formatPoints(points: number | null): string {
  return points === null ? "" : String(points);
}

import type { CourseRow } from "./ipc";

function text(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return String(value);
  }
  return "";
}

/**
 * Reduce a Canvas course payload to the row the Courses table shows. Courses come
 * from `getCourses`, which asks for `include[]=term`, so the term arrives as a
 * nested object; a course with no term is Canvas's catch-all default term.
 */
export function toCourseRow(course: Record<string, unknown>): CourseRow {
  const term = course.term;
  const termName = typeof term === "object" && term !== null && "name" in term ? text(term.name) : "";
  return {
    id: text(course.id),
    name: text(course.name),
    code: text(course.course_code),
    term: termName,
    state: text(course.workflow_state),
  };
}

export type SortKey = "name" | "code" | "id" | "term";

/** Sort rows by a column. Ids compare numerically, the rest as text. */
export function sortCourses(rows: readonly CourseRow[], key: SortKey, descending = false): CourseRow[] {
  const direction = descending ? -1 : 1;
  return [...rows].sort((a, b) => {
    const order =
      key === "id"
        ? Number(a.id) - Number(b.id)
        : a[key].localeCompare(b[key], undefined, { numeric: true, sensitivity: "base" });
    return order * direction;
  });
}

/** Rows whose name, code, id or term contain the filter text, ignoring case. */
export function filterCourses(rows: readonly CourseRow[], filter: string): CourseRow[] {
  const needle = filter.trim().toLowerCase();
  if (!needle) {
    return [...rows];
  }
  return rows.filter((r) => [r.name, r.code, r.id, r.term].some((field) => field.toLowerCase().includes(needle)));
}

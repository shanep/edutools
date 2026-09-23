/**
 * The screens of the app, in navigation order. The sidebar and the View menu are
 * both built from this list, and the renderer maps each id to a component in
 * `renderer/src/screens/index.tsx`, whose type demands an entry for every id.
 *
 * To add a screen: add its id and entry here, write the component under
 * `renderer/src/screens/`, and add it to the map there. To bring a placeholder to
 * life, flip `available` and swap the Placeholder for the real component.
 */

export type ScreenId =
  | "courses"
  | "overview"
  | "snapshot"
  | "publish"
  | "verify"
  | "audit"
  | "outline"
  | "dates"
  | "edit"
  | "settings";

export interface ScreenInfo {
  readonly id: ScreenId;
  readonly title: string;
  /** Sidebar group heading. */
  readonly group: "Canvas" | "Course repository" | "Tools";
  /** One line shown under the title, and on the placeholder. */
  readonly summary: string;
  /** False while the screen is a placeholder that a later change wires up. */
  readonly available: boolean;
}

export const SCREENS: readonly ScreenInfo[] = [
  {
    id: "courses",
    title: "Courses",
    group: "Canvas",
    summary: "The courses you teach on the default Canvas site. Open one to work on it.",
    available: true,
  },
  {
    id: "overview",
    title: "Course overview",
    group: "Canvas",
    summary: "The current course's assignments, modules, pages and assignment groups, as Canvas has them.",
    available: true,
  },
  {
    id: "snapshot",
    title: "Snapshot",
    group: "Course repository",
    summary: "Pull a whole course to disk: pages, assignments, modules and files.",
    available: true,
  },
  {
    id: "publish",
    title: "Publish",
    group: "Course repository",
    summary: "Push a course repository of markdown into Canvas, unpublished by default.",
    available: false,
  },
  {
    id: "verify",
    title: "Verify",
    group: "Course repository",
    summary: "Read published content back and check that it arrived intact.",
    available: false,
  },
  {
    id: "audit",
    title: "Audit",
    group: "Course repository",
    summary: "Compare a course repository with what is live in Canvas.",
    available: false,
  },
  {
    id: "outline",
    title: "Outline",
    group: "Course repository",
    summary: "The modules a push will build from the course repository, item by item.",
    available: true,
  },
  {
    id: "dates",
    title: "Dates",
    group: "Course repository",
    summary: "The semester's schedule computed from canvas.toml, with any problems. Read only.",
    available: true,
  },
  {
    id: "edit",
    title: "Edit object",
    group: "Canvas",
    summary: "Create, update, publish or delete a single page, assignment, discussion, quiz or module.",
    available: true,
  },
  {
    id: "settings",
    title: "Settings",
    group: "Tools",
    summary: "Canvas sites and access tokens.",
    available: true,
  },
];

export function isScreenId(value: unknown): value is ScreenId {
  return SCREENS.some((s) => s.id === value);
}

import type { CourseChoice, CurrentCourse } from "../../../shared/ipc";
import type { ScreenId } from "../../../shared/screens";

/** What every screen receives from the window around it. */
export interface ScreenProps {
  /** Replace the text in the status bar at the bottom of the window. */
  readonly setStatus: (text: string) => void;
  readonly navigate: (screen: ScreenId) => void;
  /** The course chosen on the Courses screen, or null when there is none. */
  readonly course: CurrentCourse | null;
  /** Make a course the current one. Rejects with a message the screen can show. */
  readonly openCourse: (course: CourseChoice) => Promise<void>;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** "1 page", "3 pages". */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** "CS 471 Software Engineering", or whichever part the course has. */
export function courseLabel(course: CourseChoice): string {
  return [course.code, course.name].filter((part) => part.trim()).join(" ") || `Course ${course.id}`;
}

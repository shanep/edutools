/**
 * Interactive course and assignment selection, for when an id is left off.
 *
 * The list and the prompt go to stderr, so `edutools students --json` with no
 * course id still leaves nothing but JSON on stdout.
 */

import type { Payload } from "@edutools/core/types";
import { type Cli, CliExit } from "./cli";
import { str } from "./format";

async function choose(cli: Cli, items: Payload[], empty: string, question: string): Promise<string> {
  const { e } = cli;
  if (items.length === 0) {
    cli.note(e.yellow(empty));
    throw new CliExit(0);
  }
  cli.note();
  items.forEach((item, i) => {
    cli.note(`  ${e.cyan(String(i + 1))}. ${str(item.name)} ${e.dim(`(ID: ${str(item.id)})`)}`);
  });
  cli.note();

  const choice = await cli.askInt(question);
  const picked = items[choice - 1];
  if (choice < 1 || picked === undefined) throw cli.fail("Invalid selection.");
  return str(picked.id);
}

/** Fetch Canvas courses and prompt the user to select one. */
export async function selectCourse(cli: Cli): Promise<string> {
  const canvas = await cli.canvas();
  const courses = await cli.status("Fetching courses from Canvas...", () => canvas.getCourses());
  return choose(cli, courses, "No courses found.", "Select a course");
}

/** Fetch assignments for a course and prompt the user to select one. */
export async function selectAssignment(cli: Cli, courseId: string): Promise<string> {
  const canvas = await cli.canvas();
  const assignments = await cli.status("Fetching assignments from Canvas...", () =>
    canvas.getAssignments(courseId),
  );
  return choose(cli, assignments, "No assignments found.", "Select an assignment");
}

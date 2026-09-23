import type { Register } from "../cli";
import { printTable, str } from "../format";
import { selectCourse } from "../select";

export const register: Register = (program, cli) => {
  program
    .command("assignments")
    .description("List all assignments for a course.")
    .argument("[course_id]", "Canvas course ID (prompted if omitted)")
    .option("--json", "Emit raw JSON instead of a table")
    .action(async (courseArg: string | undefined, options: { json?: boolean }) => {
      const courseId = courseArg ?? (await selectCourse(cli));
      const canvas = await cli.canvas();
      const assignments = await cli.status(`Fetching assignments for course ${courseId}...`, () =>
        canvas.getAssignments(courseId),
      );

      if (options.json) {
        cli.json(assignments);
        return;
      }
      if (assignments.length === 0) {
        cli.print(cli.c.yellow("No assignments found."));
        return;
      }

      printTable(
        cli,
        `Assignments for Course ${courseId}`,
        [
          { name: "ID", align: "right", style: cli.c.cyan },
          { name: "Assignment Name", style: cli.c.green },
        ],
        assignments.map((a) => [str(a.id), str(a.name)]),
      );
      cli.print(cli.c.dim(`\nTotal: ${assignments.length} assignments`));
    });
};

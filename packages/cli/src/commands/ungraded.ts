import type { Register } from "../cli";
import { printTable, str } from "../format";
import { selectCourse } from "../select";

export const register: Register = (program, cli) => {
  program
    .command("ungraded")
    .description("Show all submissions with no grade set (displayed as '-' in Canvas).")
    .argument("[course_id]", "Canvas course ID (prompted if omitted)")
    .option("--json", "Emit raw JSON instead of a table")
    .action(async (courseArg: string | undefined, options: { json?: boolean }) => {
      const courseId = courseArg ?? (await selectCourse(cli));
      const canvas = await cli.canvas();
      const assignments = await cli.status("Fetching assignments...", () => canvas.getAssignments(courseId));
      const names = new Map(assignments.map((a) => [str(a.id), str(a.name)]));
      const ungraded = await cli.status("Fetching submissions...", () =>
        canvas.getUngradedSubmissions(courseId),
      );

      if (options.json) {
        cli.json(ungraded);
        return;
      }
      if (ungraded.length === 0) {
        cli.print(cli.c.green("All submissions have been graded."));
        return;
      }

      const { c } = cli;
      printTable(
        cli,
        `Ungraded Submissions - Course ${courseId}`,
        [
          { name: "Assignment ID", align: "right", style: c.cyan },
          { name: "Assignment Name", style: c.green },
          { name: "User ID", align: "right", style: c.cyan },
        ],
        ungraded.map((sub) => {
          const id = str(sub.assignment_id);
          return [id, names.get(id) ?? "", str(sub.user_id)];
        }),
      );
      cli.print(c.dim(`\nTotal ungraded: ${ungraded.length}`));
    });
};

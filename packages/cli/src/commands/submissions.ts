import type { Register } from "../cli";
import { printTable, str } from "../format";
import { selectAssignment, selectCourse } from "../select";

export const register: Register = (program, cli) => {
  program
    .command("submissions")
    .description("List all submissions for an assignment.")
    .argument("[course_id]", "Canvas course ID (prompted if omitted)")
    .argument("[assignment_id]", "Assignment ID (prompted if omitted)")
    .option("--json", "Emit raw JSON instead of a table")
    .action(
      async (
        courseArg: string | undefined,
        assignmentArg: string | undefined,
        options: { json?: boolean },
      ) => {
        const courseId = courseArg ?? (await selectCourse(cli));
        const assignmentId = assignmentArg ?? (await selectAssignment(cli, courseId));
        const canvas = await cli.canvas();
        const submissions = await cli.status("Fetching submissions...", () =>
          canvas.getSubmissions(courseId, assignmentId),
        );

        if (options.json) {
          cli.json(submissions);
          return;
        }
        if (submissions.length === 0) {
          cli.print(cli.c.yellow("No submissions found."));
          return;
        }

        const { c } = cli;
        printTable(
          cli,
          `Submissions for Assignment ${assignmentId}`,
          [
            { name: "User ID", align: "right", style: c.cyan },
            { name: "Grade", style: c.green },
          ],
          submissions.map((sub) => [str(sub.user_id), sub.grade ? str(sub.grade) : c.dim("Not graded")]),
        );
        cli.print(c.dim(`\nTotal: ${submissions.length} submissions`));
      },
    );
};

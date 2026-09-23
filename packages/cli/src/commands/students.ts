import type { Register } from "../cli";
import { printTable, str } from "../format";
import { selectCourse } from "../select";

export const register: Register = (program, cli) => {
  program
    .command("students")
    .description("List all students in a course.")
    .argument("[course_id]", "Canvas course ID (prompted if omitted)")
    .option("--json", "Emit raw JSON instead of a table")
    .action(async (courseArg: string | undefined, options: { json?: boolean }) => {
      const courseId = courseArg ?? (await selectCourse(cli));
      const canvas = await cli.canvas();
      const students = await cli.status(`Fetching students for course ${courseId}...`, () =>
        canvas.getStudents(courseId),
      );

      if (options.json) {
        cli.json(students);
        return;
      }
      if (students.length === 0) {
        cli.print(cli.c.yellow("No students found."));
        return;
      }

      const { c } = cli;
      printTable(
        cli,
        `Students in Course ${courseId}`,
        [
          { name: "ID", align: "right", style: c.cyan },
          { name: "Email", style: c.green },
        ],
        students.map((s) => [str(s.id), s.email ? str(s.email) : c.dim("No email")]),
      );
      cli.print(c.dim(`\nTotal: ${students.length} students`));
    });
};

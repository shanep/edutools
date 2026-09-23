import type { Register } from "../cli";
import { printTable, str } from "../format";

interface Options {
  all?: boolean;
  json?: boolean;
}

export const register: Register = (program, cli) => {
  program
    .command("courses")
    .description("List courses where you are a teacher.")
    .option("-a, --all", "Show all courses, including past/completed ones")
    .option("--json", "Emit raw JSON instead of a table")
    .action(async (options: Options) => {
      const all = Boolean(options.all);
      const canvas = await cli.canvas();
      const courses = await cli.status(`Fetching ${all ? "all" : "active"} courses from Canvas...`, () =>
        canvas.getCourses({ includeAll: all }),
      );

      if (options.json) {
        cli.json(courses);
        return;
      }
      if (courses.length === 0) {
        cli.print(cli.c.yellow("No courses found."));
        return;
      }

      printTable(
        cli,
        all ? "All Canvas Courses" : "Active Canvas Courses",
        [
          { name: "ID", align: "right", style: cli.c.cyan },
          { name: "Course Name", style: cli.c.green },
        ],
        courses.map((course) => [str(course.id), str(course.name)]),
      );
      cli.print(cli.c.dim(`\nTotal: ${courses.length} courses`));
    });
};

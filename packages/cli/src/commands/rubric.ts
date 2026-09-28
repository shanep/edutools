import { readFileSync } from "node:fs";
import { formatG } from "@edutools/core/objects";
import { attachedRubric, parseRubricJson, RubricError, type RubricFile, rubricFields } from "@edutools/core/publish";
import type { Register } from "../cli";
import { expandHome, printTable, str } from "../format";
import { isFile } from "../options";
import { selectAssignment, selectCourse } from "../select";

interface Options {
  course?: string;
  assignment?: string;
  fromFile: string;
  title?: string;
  dryRun?: boolean;
  json?: boolean;
}

export const register: Register = (program, cli) => {
  program
    .command("rubric")
    .description(
      "Attach a rubric to one assignment, from a JSON file.\n\n" +
        "For an assignment a course repository does not manage; a repo's '## Rubric'\n" +
        "table goes through push instead. The file is {\"title\": ..., \"criteria\": [...]}\n" +
        "or a bare list of criteria:\n\n" +
        '    {"title": "Final draft", "criteria": [\n' +
        '      {"description": "Summary of changes", "points": 4,\n' +
        '       "long_description": "200 to 300 words, last section."},\n' +
        '      {"description": "Instructor feedback", "points": 6, "ratings": [\n' +
        '        {"description": "All fixed", "points": 6},\n' +
        '        {"description": "One missed", "points": 3},\n' +
        '        {"description": "Two or more missed", "points": 0}]}]}\n\n' +
        "A criterion without ratings is all or nothing. The rubric is used for\n" +
        "grading. An assignment that already has a rubric has it rewritten in\n" +
        "place rather than replaced, so grades given with it stay attached.",
    )
    .option("-c, --course <id>", "Canvas course ID (prompted if omitted)")
    .option("-a, --assignment <id>", "Assignment ID (prompted if omitted)")
    .requiredOption("--from-file <path>", "The rubric, as JSON")
    .option("--title <text>", "Rubric title (default: the file's title, else '<assignment> rubric')")
    .option("--dry-run", "Show the rubric and whether it would be created or rewritten, write nothing")
    .option("--json", "Emit the stored rubric as JSON")
    .action(async (options: Options) => {
      const courseId = options.course ?? (await selectCourse(cli));
      const assignmentId = options.assignment ?? (await selectAssignment(cli, courseId));
      const file = expandHome(options.fromFile);
      if (!isFile(file)) throw cli.fail(`No such file: ${file}`);
      let rubric: RubricFile;
      try {
        rubric = parseRubricJson(readFileSync(file, "utf-8"));
      } catch (error) {
        if (error instanceof RubricError) throw cli.fail(error.message);
        throw error;
      }

      const canvas = await cli.canvas();
      const assignment = await cli.status("Reading the assignment...", () =>
        canvas.getJson(`/api/v1/courses/${courseId}/assignments/${assignmentId}`),
      );
      const current = attachedRubric(assignment);
      const title = options.title ?? rubric.title ?? `${str(assignment.name)} rubric`;
      const total = rubric.criteria.reduce((sum, criterion) => sum + criterion.points, 0);

      const { c } = cli;
      if (!options.json) {
        printTable(
          cli,
          title,
          [
            { name: "#", align: "right", style: c.dim },
            { name: "Criterion", style: c.cyan },
            { name: "Ratings" },
            { name: "Points", align: "right", style: c.green },
          ],
          rubric.criteria.map((criterion, index) => [
            String(index + 1),
            criterion.description,
            (criterion.ratings ?? [
              { description: "Full marks", points: criterion.points },
              { description: "No marks", points: 0 },
            ])
              .map((rating) => `${formatG(rating.points)} ${rating.description}`)
              .join(", "),
            formatG(criterion.points),
          ]),
        );
        const possible = Number(assignment.points_possible);
        cli.print(`\nTotal ${formatG(total)} points; the assignment is worth ${str(assignment.points_possible)}.`);
        if (Number.isFinite(possible) && possible !== total) {
          cli.note(cli.e.yellow("The rubric total does not match the assignment's points."));
        }
      }

      const action = current === null ? "create" : `rewrite rubric ${current.id} in place`;
      if (options.dryRun) {
        cli.print(`${c.green("✓")} dry run: would ${action}, nothing written.`);
        return;
      }

      const fields = rubricFields(title, rubric.criteria, assignmentId);
      const stored = await cli.status(current === null ? "Creating the rubric..." : "Rewriting the rubric...", () =>
        current === null ? canvas.createRubric(courseId, fields) : canvas.updateRubric(courseId, current.id, fields),
      );
      if (options.json) {
        cli.json(stored);
        return;
      }
      cli.print(`${c.green("✓")} ${current === null ? "created" : "rewrote"} the rubric on assignment ${assignmentId}`);
    });
};

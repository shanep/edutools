import {
  defaultName,
  EXPORT_TYPES,
  ExportError,
  type ExportResult,
  exportCourse,
  exportFields,
} from "@edutools/core/export";
import type { Register } from "../cli";
import { expandHome, messageOf } from "../format";
import { collect } from "../options";
import { selectCourse } from "../select";

interface Options {
  type: string;
  quiz?: string[];
  out?: string;
  json?: boolean;
}

export const register: Register = (program, cli) => {
  program
    .command("export")
    .description(
      "Download a course export, the package Settings -> Export Course Content builds.\n\n" +
        "A quiz built from linked question banks pulls with no questions at all.\n" +
        "Only a whole-course common_cartridge export carries the banks themselves;\n" +
        "a qti export, or one narrowed with --quiz, names the banks and leaves the\n" +
        "questions out.\n\n" +
        "Canvas builds the package in the background; this waits for it, then saves\n" +
        "it. Nothing in the course changes, and Canvas sends no email about it.",
    )
    .argument("[course_id]", "Canvas course ID (prompted if omitted)")
    .option("-t, --type <type>", `What to export: ${EXPORT_TYPES.join(", ")}`, "qti")
    .option("--quiz <id>", "Export only this quiz (repeatable; qti or common_cartridge)", collect)
    .option("-o, --out <file>", "Where to save it (default: ./canvas-<course_id>-<type>.zip)")
    .option("--json", "Emit the path, the size, and the content export as JSON")
    .action(async (courseArg: string | undefined, options: Options) => {
      const quizzes = options.quiz ?? [];
      // Check the request before asking for a course or a token, so a typo is a
      // usage error rather than an export of the wrong thing.
      try {
        exportFields(options.type, quizzes);
      } catch (error) {
        if (error instanceof ExportError) throw cli.fail(error.message, 2);
        throw error;
      }

      const courseId = courseArg ?? (await selectCourse(cli));
      const dest = expandHome(options.out ?? defaultName(courseId, options.type));
      const canvas = await cli.canvas();

      let result: ExportResult;
      try {
        result = await cli.status("Starting the export", (update) =>
          exportCourse(canvas, courseId, dest, { type: options.type, quizzes, report: update }),
        );
      } catch (error) {
        throw cli.fail(`could not export course ${courseId}: ${messageOf(error)}`);
      }

      if (options.json) {
        cli.json({ path: result.path, bytes: result.bytes, export: result.export });
        return;
      }
      const { c } = cli;
      const kb = Math.max(1, Math.round(result.bytes / 1024));
      cli.print(`${c.green("✓")} ${options.type} export of course ${courseId} saved to ${c.cyan(result.path)} (${kb} KB)`);
    });
};

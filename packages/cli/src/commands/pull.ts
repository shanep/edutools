import { PullError, Puller } from "@edutools/core/pull";
import type { Payload } from "@edutools/core/types";
import { CliExit, type Register } from "../cli";
import { expandHome, messageOf, str } from "../format";
import { collect } from "../options";
import { selectCourse } from "../select";

interface Options {
  out?: string;
  only?: string[];
  json?: boolean;
}

export const register: Register = (program, cli) => {
  program
    .command("pull")
    .description(
      "Snapshot a whole course to disk, exactly as Canvas stores it.\n\n" +
        "Every object is written as its raw JSON, its body as the HTML Canvas holds,\n" +
        "and every course file as its bytes. Nothing is converted to markdown, so the\n" +
        "snapshot is lossless but is not a repo that push can read.\n\n" +
        "Pulling again into the same directory refreshes it: files already current\n" +
        "are not downloaded twice, and anything an earlier pull wrote for an object\n" +
        "Canvas no longer has is removed. Nothing else in the directory is touched.",
    )
    .argument("[course_id]", "Canvas course ID (prompted if omitted)")
    .option("-o, --out <dir>", "Directory to write into (default: ./canvas-<course_id>)")
    .option(
      "--only <kind>",
      "Limit to: syllabus, pages, assignments, discussions, announcements, quizzes, modules, groups, rubrics, files (repeatable)",
      collect,
    )
    .option("--json", "Emit the snapshot index as JSON")
    .action(async (courseArg: string | undefined, options: Options) => {
      const courseId = courseArg ?? (await selectCourse(cli));
      const root = expandHome(options.out ?? `canvas-${courseId}`);
      const canvas = await cli.canvas();

      // The Puller takes its reporter when it is built, before the spinner that
      // shows its progress exists, so the reporter forwards to whatever is current.
      let report: (message: string) => void = () => {};
      let puller: Puller;
      try {
        puller = new Puller(canvas, courseId, root, {
          kinds: options.only ?? [],
          report: (message) => report(message),
        });
      } catch (error) {
        if (error instanceof PullError) throw cli.fail(error.message, 2);
        throw error;
      }

      let index: Payload;
      try {
        index = await cli.status("Reading course", (update) => {
          report = update;
          return puller.run();
        });
      } catch (error) {
        // Only the course itself is fatal; everything past it is reported per object.
        throw cli.fail(`could not read course ${courseId}: ${messageOf(error)}`);
      }

      const result = puller.result;
      if (options.json) {
        cli.json(index);
        if (result.errors.length > 0) throw new CliExit(1);
        return;
      }

      const { c } = cli;
      const counts = new Map<string, number>();
      for (const entry of result.entries) {
        if (entry.ident && entry.kind !== "course") counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
      }
      const summary = [...counts].map(([kind, n]) => `${n} ${kind}`).join(", ") || "no objects";
      cli.print(`${c.green("✓")} ${str(index.course_name)} pulled to ${c.cyan(root)}: ${summary}`);
      if (result.downloaded || result.unchanged) {
        cli.print(c.dim(`  files: ${result.downloaded} downloaded, ${result.unchanged} already current`));
      }
      if (result.removed.length > 0) {
        cli.print(c.dim(`  removed ${result.removed.length} path(s) for objects Canvas no longer has`));
      }
      if (result.errors.length > 0) {
        cli.error(`\n${result.errors.length} problem(s); the previous copy of each was kept:`);
        for (const problem of result.errors.slice(0, 20)) cli.note(`  ${cli.e.red("•")} ${problem}`);
        throw new CliExit(1);
      }
    });
};

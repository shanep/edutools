import type { Register } from "../cli";
import { describe } from "../format";
import {
  build,
  collect,
  KIND_HELP,
  loadBody,
  overrides,
  parseFloatOption,
  parseIntOption,
} from "../options";

interface Options {
  course: string;
  title?: string;
  body?: string;
  bodyFile?: string;
  points?: number;
  due?: string;
  unlock?: string;
  lock?: string;
  position?: number;
  publish?: boolean;
  set?: string[];
  json?: boolean;
}

export const register: Register = (program, cli) => {
  program
    .command("create")
    .description(
      "Create one Canvas object.\n\nCreated UNPUBLISHED unless --publish is given, matching 'edutools push'.",
    )
    .argument("<kind>", KIND_HELP)
    .requiredOption("-c, --course <id>", "Canvas course ID")
    .option("-t, --title <title>", "Object title (defaults to the H1 of a markdown --body-file)")
    .option("--body <html>", "Body as literal HTML")
    .option("-f, --body-file <path>", "Body from a file; .md is rendered like 'push' does")
    .option("-p, --points <n>", "Points possible (assignments and graded discussions)", parseFloatOption)
    .option("--due <date>", "Due date, ISO 8601 (2026-09-15T23:59:00-06:00)")
    .option("--unlock <date>", "Available-from date, ISO 8601")
    .option("--lock <date>", "Available-until date, ISO 8601")
    .option("--position <n>", "Module position, 1-based", parseIntOption)
    .option("--publish", "Make it student-visible (default: unpublished)")
    .option("--no-publish", "Leave it unpublished (the default)")
    .option(
      "--set <key=value>",
      "Any other Canvas field, e.g. --set 'assignment[submission_types][]=online_upload'",
      collect,
    )
    .option("--json", "Emit the created object as JSON")
    .action(async (kind: string, options: Options) => {
      const published = options.publish ?? false;
      const body = await loadBody(cli, options.body, options.bodyFile);
      const title = options.title || body.title;
      if (!title) throw cli.fail("A new object needs --title (or a markdown --body-file with an H1).");

      const fields = build(cli, kind, {
        title,
        body: body.html,
        points: options.points,
        due: options.due,
        unlock: options.unlock,
        lock: options.lock,
        published,
        position: options.position,
        overrides: overrides(cli, options.set),
      });

      const canvas = await cli.canvas();
      const stored = await cli.status(`Creating ${kind}...`, () =>
        canvas.createObject(kind, options.course, fields),
      );

      if (options.json) {
        cli.json(stored);
        return;
      }
      cli.print(`${cli.c.green("✓")} created ${describe(cli, kind, stored)}`);
      if (!published) cli.print(cli.c.dim("Unpublished. Run 'edutools publish' when it is ready."));
    });
};

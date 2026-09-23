import { CliExit, type Register } from "../cli";
import { describe } from "../format";
import {
  build,
  collect,
  KIND_HELP,
  loadBody,
  OBJECT_ID_HELP,
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
  unpublish?: boolean;
  set?: string[];
  json?: boolean;
}

export const register: Register = (program, cli) => {
  program
    .command("update")
    .description(
      "Change one Canvas object.\n\n" +
        "Only the fields you pass are sent, so an update never clears something you\n" +
        "did not mention.",
    )
    .argument("<kind>", KIND_HELP)
    .argument("<object_id>", OBJECT_ID_HELP)
    .requiredOption("-c, --course <id>", "Canvas course ID")
    .option("-t, --title <title>", "New title")
    .option("--body <html>", "Body as literal HTML")
    .option("-f, --body-file <path>", "Body from a file; .md is rendered like 'push' does")
    .option("-p, --points <n>", "Points possible", parseFloatOption)
    .option("--due <date>", "Due date, ISO 8601")
    .option("--unlock <date>", "Available-from date, ISO 8601")
    .option("--lock <date>", "Available-until date, ISO 8601")
    .option("--position <n>", "Module position, 1-based", parseIntOption)
    .option("--publish", "Make it student-visible")
    .option("--unpublish", "Hide it from students")
    .option("--set <key=value>", "Any other Canvas field, repeatable", collect)
    .option("--json", "Emit the updated object as JSON")
    .action(async (kind: string, objectId: string, options: Options) => {
      // click's --publish/--unpublish was one tri-state flag; here they are two,
      // and naming both is a contradiction rather than "the last one wins".
      if (options.publish && options.unpublish) throw cli.fail("Pass --publish or --unpublish, not both.");
      const published = options.publish ? true : options.unpublish ? false : null;

      const body = await loadBody(cli, options.body, options.bodyFile);
      const fields = build(cli, kind, {
        title: options.title || body.title,
        body: body.html,
        points: options.points,
        due: options.due,
        unlock: options.unlock,
        lock: options.lock,
        published,
        position: options.position,
        overrides: overrides(cli, options.set),
      });
      if (Object.keys(fields).length === 0) {
        cli.note(cli.e.yellow("Nothing to update; pass at least one field."));
        throw new CliExit(1);
      }

      const canvas = await cli.canvas();
      const stored = await cli.status(`Updating ${kind} ${objectId}...`, () =>
        canvas.updateObject(kind, options.course, objectId, fields),
      );

      if (options.json) {
        cli.json(stored);
        return;
      }
      const changed = Object.keys(fields).sort().join(", ");
      cli.print(`${cli.c.green("✓")} updated ${describe(cli, kind, stored)} ${cli.c.dim(`(${changed})`)}`);
    });
};

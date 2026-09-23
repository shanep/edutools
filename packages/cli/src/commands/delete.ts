import type { Payload } from "@edutools/core/types";
import { CliExit, type Register } from "../cli";
import { describe, messageOf } from "../format";
import { OBJECT_ID_HELP } from "../options";

// A course file is not one of the object kinds create and update handle: it
// lives outside the course namespace, so only delete takes it.
const DELETE_KIND_HELP = "page, assignment, discussion, quiz, module, or file";

interface Options {
  course: string;
  yes?: boolean;
  json?: boolean;
}

export const register: Register = (program, cli) => {
  program
    .command("delete")
    .description(
      "Delete one Canvas object.\n\n" +
        "Prints what is about to go and asks first. Deleting an assignment or a\n" +
        "graded discussion takes its submissions and grades with it. A file is\n" +
        "addressed by its id and read through the course first.",
    )
    .argument("<kind>", DELETE_KIND_HELP)
    .argument("<object_id>", OBJECT_ID_HELP)
    .requiredOption("-c, --course <id>", "Canvas course ID")
    .option("-y, --yes", "Skip the confirmation prompt")
    .option("--json", "Emit the deleted object as JSON")
    .action(async (kind: string, objectId: string, options: Options) => {
      const canvas = await cli.canvas();
      let target: Payload;
      try {
        target =
          kind === "file"
            ? await canvas.getCourseFile(options.course, objectId)
            : await canvas.getObject(kind, options.course, objectId);
      } catch (error) {
        // Never delete what could not be read first: the prompt has to name it.
        throw cli.fail(`Cannot read ${kind} ${objectId}: ${messageOf(error)}`);
      }

      if (!options.yes) {
        // On stderr with the prompt, so --json output stays parseable.
        cli.note(`About to delete ${describe(cli, kind, target, cli.e)} from course ${options.course}.`);
        if (["assignment", "discussion", "quiz"].includes(kind)) {
          cli.note(cli.e.yellow("Any submissions and grades on it go too."));
        }
        if (kind === "file") {
          cli.note(cli.e.yellow("Any page that links to it or shows it breaks until it is relinked."));
        }
        if (!(await cli.confirm("Delete it?"))) {
          cli.note(cli.e.dim("Left alone."));
          throw new CliExit(0);
        }
      }

      const stored = await cli.status(`Deleting ${kind} ${objectId}...`, () =>
        kind === "file" ? canvas.deleteFile(objectId) : canvas.deleteObject(kind, options.course, objectId),
      );

      if (options.json) {
        cli.json(stored);
        return;
      }
      cli.print(`${cli.c.green("✓")} deleted ${describe(cli, kind, target)}`);
    });
};

import type { Payload } from "@edutools/core/types";
import { CliExit, type Register } from "../cli";
import { describe, messageOf } from "../format";
import { OBJECT_ID_HELP } from "../options";

// A course file and an assignment group are not object kinds create and update
// handle: a file lives outside the course namespace and a group is managed by
// `push` from canvas.toml, so only delete takes them.
const DELETE_KIND_HELP = "page, assignment, discussion, quiz, module, file, or group";

interface Options {
  course: string;
  moveTo?: string;
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
        "addressed by its id and read through the course first. A group that\n" +
        "still holds assignments is refused unless --move-to names a group to\n" +
        "move them into, because Canvas deletes them with it otherwise.",
    )
    .argument("<kind>", DELETE_KIND_HELP)
    .argument("<object_id>", OBJECT_ID_HELP)
    .requiredOption("-c, --course <id>", "Canvas course ID")
    .option("--move-to <group_id>", "Group only: move its assignments here before deleting it")
    .option("-y, --yes", "Skip the confirmation prompt")
    .option("--json", "Emit the deleted object as JSON")
    .action(async (kind: string, objectId: string, options: Options) => {
      if (options.moveTo !== undefined && kind !== "group") {
        throw cli.fail("--move-to only applies to deleting a group", 2);
      }
      const canvas = await cli.canvas();
      let target: Payload;
      try {
        target =
          kind === "file"
            ? await canvas.getCourseFile(options.course, objectId)
            : kind === "group"
              ? await canvas.getAssignmentGroup(options.course, objectId)
              : await canvas.getObject(kind, options.course, objectId);
      } catch (error) {
        // Never delete what could not be read first: the prompt has to name it.
        throw cli.fail(`Cannot read ${kind} ${objectId}: ${messageOf(error)}`);
      }

      // Refused even with --yes: Canvas deletes every assignment still in the
      // group, and their grades, as part of deleting the group.
      const held = kind === "group" && Array.isArray(target.assignments) ? target.assignments.length : 0;
      if (held > 0 && options.moveTo === undefined) {
        throw cli.fail(
          `${describe(cli, kind, target, cli.e)} still holds ${held} assignment(s). Deleting it deletes ` +
            "them and their grades too; pass --move-to <group_id> to keep them.",
        );
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
        if (held > 0) {
          cli.note(cli.e.yellow(`Its ${held} assignment(s) move to group ${options.moveTo} first.`));
        }
        if (!(await cli.confirm("Delete it?"))) {
          cli.note(cli.e.dim("Left alone."));
          throw new CliExit(0);
        }
      }

      const stored = await cli.status(`Deleting ${kind} ${objectId}...`, () =>
        kind === "file"
          ? canvas.deleteFile(objectId)
          : kind === "group"
            ? canvas.deleteAssignmentGroup(options.course, objectId, options.moveTo)
            : canvas.deleteObject(kind, options.course, objectId),
      );

      if (options.json) {
        cli.json(stored);
        return;
      }
      cli.print(`${cli.c.green("✓")} deleted ${describe(cli, kind, target)}`);
    });
};

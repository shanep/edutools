/**
 * `publish`: one field, `<kind>[published]`, on one object. `unpublish` shares
 * setPublished.
 */

import type { Cli, Register } from "../cli";
import { describe } from "../format";
import { build, KIND_HELP, OBJECT_ID_HELP } from "../options";

export interface PublishOptions {
  course: string;
  json?: boolean;
}

export async function setPublished(
  cli: Cli,
  kind: string,
  objectId: string,
  options: PublishOptions,
  state: boolean,
): Promise<void> {
  const fields = build(cli, kind, { published: state });
  const canvas = await cli.canvas();
  const verb = state ? "Publishing" : "Unpublishing";
  const stored = await cli.status(`${verb} ${kind} ${objectId}...`, () =>
    canvas.updateObject(kind, options.course, objectId, fields),
  );

  if (options.json) {
    cli.json(stored);
    return;
  }
  cli.print(`${cli.c.green("✓")} ${state ? "published" : "unpublished"} ${describe(cli, kind, stored)}`);
}

export const register: Register = (program, cli) => {
  program
    .command("publish")
    .description(
      "Make one object visible to students.\n\n" +
        "A module publishes everything inside it. To publish a whole repository, use\n" +
        "'edutools push --publish' instead.",
    )
    .argument("<kind>", KIND_HELP)
    .argument("<object_id>", OBJECT_ID_HELP)
    .requiredOption("-c, --course <id>", "Canvas course ID")
    .option("--json", "Emit the updated object as JSON")
    .action((kind: string, objectId: string, options: PublishOptions) =>
      setPublished(cli, kind, objectId, options, true),
    );
};

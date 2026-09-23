import type { Register } from "../cli";
import { KIND_HELP, OBJECT_ID_HELP } from "../options";
import { type PublishOptions, setPublished } from "./publish";

export const register: Register = (program, cli) => {
  program
    .command("unpublish")
    .description("Hide one object from students.\n\nCanvas refuses to unpublish anything with student submissions.")
    .argument("<kind>", KIND_HELP)
    .argument("<object_id>", OBJECT_ID_HELP)
    .requiredOption("-c, --course <id>", "Canvas course ID")
    .option("--json", "Emit the updated object as JSON")
    .action((kind: string, objectId: string, options: PublishOptions) =>
      setPublished(cli, kind, objectId, options, false),
    );
};

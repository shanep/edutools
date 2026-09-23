import type { ResolvedCredentials } from "@edutools/core/credentials";
import type { Payload } from "@edutools/core/types";
import { CliExit, type Register } from "../cli";
import { messageOf, printPanel } from "../format";

/** Where the token came from, in words. */
export function sourceOf(credentials: ResolvedCredentials): string {
  if (credentials.source === "env") return "CANVAS_TOKEN from the environment";
  return credentials.site
    ? `keychain, site '${credentials.site}'`
    : `keychain, the token saved for ${credentials.endpoint}`;
}

export const register: Register = (program, cli) => {
  program
    .command("check")
    .description("Test the configured Canvas credentials.")
    .option("--json", "Emit the result as JSON")
    .action(async (options: { json?: boolean }) => {
      const { c } = cli;
      // credentials() prints the not-configured status itself and exits 1.
      const credentials = await cli.credentials();
      const canvas = await cli.canvas();

      let courses: Payload[];
      try {
        courses = await cli.status("Testing Canvas...", () => canvas.getCourses());
      } catch (error) {
        cli.note(`${cli.e.red("✗")} ${cli.e.bold("Canvas LMS")} - ${credentials.endpoint}`);
        cli.note(`  ${cli.e.red("Error:")} ${messageOf(error)}`);
        cli.note(`  Credentials: ${sourceOf(credentials)}`);
        throw new CliExit(1);
      }

      if (options.json) {
        cli.json({
          endpoint: credentials.endpoint,
          source: credentials.source,
          site: credentials.site,
          courses: courses.length,
        });
        return;
      }
      printPanel(cli, "Credential Check", [
        `${c.green("✓")} ${c.bold("Canvas LMS")} - ${credentials.endpoint} (${courses.length} courses)`,
        `  Credentials: ${sourceOf(credentials)}`,
      ]);
    });
};

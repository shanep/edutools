/**
 * `site`: manage Canvas sites and their keychain tokens without the desktop app.
 *
 * A token is never taken as a flag, so it never lands in shell history or a
 * process listing: `site add` and `site token` read it from a hidden prompt, or
 * from stdin when piped (`pbpaste | edutools site add bsu --endpoint https://...`).
 */

import {
  addSite,
  CredentialsError,
  configPath,
  listSites,
  loadSites,
  maskToken,
  removeSite,
  setDefaultSite,
  setToken,
} from "@edutools/core/credentials";
import type { Cli, Register } from "../cli";
import { printTable } from "../format";

/** Run a credentials call, turning its CredentialsError into a clean exit 1. */
async function guarded<T>(cli: Cli, work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof CredentialsError) throw cli.fail(error.message);
    throw error;
  }
}

export const register: Register = (program, cli) => {
  const site = program
    .command("site")
    .description("Manage Canvas sites and the tokens saved for them in the OS keychain.");

  site
    .command("list")
    .description("List the Canvas sites, which is the default, and a hint of each token.")
    .option("--json", "Emit raw JSON instead of a table")
    .action(async (options: { json?: boolean }) => {
      const opts = cli.deps.credentials;
      const sites = await guarded(cli, () => listSites(opts));
      if (options.json) {
        cli.json(sites);
        return;
      }
      const { c } = cli;
      if (sites.length === 0) {
        cli.print(c.yellow("No Canvas sites yet. Add one with 'edutools site add <name> --endpoint <url>'."));
      } else {
        printTable(
          cli,
          "Canvas sites",
          [
            { name: "Name", style: c.green },
            { name: "Endpoint", style: c.cyan },
            { name: "Token" },
            { name: "Default" },
          ],
          sites.map((s) => [s.name, s.endpoint, s.tokenHint ?? c.red("none saved"), s.isDefault ? "yes" : ""]),
        );
      }
      cli.print(c.dim(`Site list: ${configPath(opts)}`));
      if (cli.env.CANVAS_TOKEN?.trim()) {
        cli.print(c.yellow("CANVAS_TOKEN is set in the environment and overrides every site."));
      }
    });

  site
    .command("add")
    .description(
      "Add a Canvas site and save its token in the OS keychain.\n\n" +
        "The token is read from a hidden prompt, or from the first line of stdin when\n" +
        "piped, never from a flag. Generate one at Canvas -> Account -> Settings ->\n" +
        "Approved Integrations -> + New Access Token. The first site becomes the default.",
    )
    .argument("<name>", "A short name for the site, e.g. bsu")
    .requiredOption("--endpoint <url>", "The Canvas address, e.g. https://boisestatecanvas.instructure.com")
    .action(async (name: string, options: { endpoint: string }) => {
      const token = (await cli.secret(`Canvas token for ${name}: `))?.trim();
      if (!token) throw cli.fail("No token given; nothing was saved.");
      const added = await guarded(cli, () =>
        addSite({ name, endpoint: options.endpoint, token }, cli.deps.credentials),
      );
      const { c } = cli;
      cli.print(`${c.green("✓")} added site ${c.bold(added.name)} (${added.endpoint}), token ${maskToken(token)}`);
      cli.print(c.dim("Run 'edutools check' to verify the token works."));
    });

  site
    .command("token")
    .description(
      "Replace the token saved for a Canvas site, e.g. after it expires or is revoked.\n\n" +
        "The token is read from a hidden prompt, or from the first line of stdin when\n" +
        "piped, never from a flag. The site's name and endpoint are unchanged.",
    )
    .argument("<name>", "The site whose token to replace")
    .action(async (name: string) => {
      const opts = cli.deps.credentials;
      // Checked before the prompt, so a typo is not discovered after pasting a token.
      const known = await guarded(cli, () => loadSites(opts).sites.some((s) => s.name === name));
      if (!known) throw cli.fail(`No Canvas site named '${name}'.`);
      const token = (await cli.secret(`New Canvas token for ${name}: `))?.trim();
      if (!token) throw cli.fail("No token given; nothing was changed.");
      await guarded(cli, () => setToken(name, token, opts));
      const { c } = cli;
      cli.print(`${c.green("✓")} replaced the token of site ${c.bold(name)}, now ${maskToken(token)}`);
      cli.print(c.dim("Run 'edutools check' to verify the token works."));
    });

  site
    .command("remove")
    .description("Remove a Canvas site and delete its token from the keychain.")
    .argument("<name>", "The site to remove")
    .action(async (name: string) => {
      await guarded(cli, () => removeSite(name, cli.deps.credentials));
      cli.print(`${cli.c.green("✓")} removed site ${cli.c.bold(name)}`);
    });

  site
    .command("default")
    .description("Make a site the one commands use when --site is not given.")
    .argument("<name>", "The site to use by default")
    .action(async (name: string) => {
      await guarded(cli, () => setDefaultSite(name, cli.deps.credentials));
      cli.print(`${cli.c.green("✓")} ${cli.c.bold(name)} is now the default site`);
    });
};

/**
 * `init`: move a legacy config.toml's plain-text token into the keychain, then say
 * what is set up and what to do next.
 */

import { DEFAULT_ENDPOINT } from "@edutools/core/canvas";
import {
  CredentialsError,
  configPath,
  importLegacyConfig,
  legacyConfigPath,
  listSites,
} from "@edutools/core/credentials";
import type { Cli, Register } from "../cli";
import { messageOf, printPanel } from "../format";

async function importLegacy(cli: Cli): Promise<void> {
  const { c } = cli;
  try {
    const imported = await importLegacyConfig(cli.deps.credentials);
    if (imported === null) return;
    const verb = imported.created ? "added site" : "replaced the token of site";
    cli.print(
      `${c.green("✓")} imported the token from ${c.cyan(imported.path)}: ${verb} ${c.bold(imported.site.name)}`,
    );
    // Left in place on purpose: deleting a credential is for the user to decide.
    cli.print(c.dim(`  ${imported.path} still holds the token in plain text; delete it when nothing needs it.`));
  } catch (error) {
    if (!(error instanceof CredentialsError)) throw error;
    cli.error(`Could not import ${legacyConfigPath(cli.deps.credentials)}: ${messageOf(error)}`);
  }
}

/** The setup status panel: every site, the environment override, and next steps. */
async function setupStatus(cli: Cli): Promise<void> {
  const { c } = cli;
  const opts = cli.deps.credentials;
  const lines = [`Site list: ${c.cyan(configPath(opts))}`, ""];
  const sites = await listSites(opts);
  const envToken = Boolean(cli.env.CANVAS_TOKEN?.trim());

  for (const site of sites) {
    const mark = site.tokenHint ? c.green("✓") : c.red("✗");
    const token = site.tokenHint ? `token ${site.tokenHint}` : c.red("no token saved");
    lines.push(`${mark} ${c.bold(site.name)} - ${site.endpoint} (${token})${site.isDefault ? " [default]" : ""}`);
  }
  if (envToken) {
    lines.push(`${c.green("✓")} CANVAS_TOKEN is set in the environment and overrides every site`);
  }

  const ready = envToken || sites.some((s) => s.tokenHint !== null);
  if (ready) {
    lines.push("", `${c.green("✓")} ${c.bold(c.magenta("Canvas LMS"))} - configured`);
  } else {
    lines.push(
      `${c.red("✗")} ${c.bold(c.magenta("Canvas LMS"))} - not configured`,
      "  1. Generate a token: Canvas -> Account -> Settings",
      "     -> Approved Integrations -> + New Access Token",
      "  2. Save it in the keychain (you are asked for the token, it is never a flag):",
      `     ${c.yellow(`edutools site add <name> --endpoint ${DEFAULT_ENDPOINT}`)}`,
    );
  }
  lines.push("", c.dim("Run 'edutools check' to verify credentials work."));
  printPanel(cli, "Setup Status", lines);
}

export const register: Register = (program, cli) => {
  program
    .command("init")
    .description(
      "Import a legacy ~/.config/edutools/config.toml token into the keychain and show setup status.",
    )
    .action(async () => {
      await importLegacy(cli);
      await setupStatus(cli);
    });
};

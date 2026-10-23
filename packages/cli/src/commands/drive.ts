import { readFileSync } from "node:fs";
import { CourseError, writePreview } from "@edutools/core/course";
import { DateConfigError } from "@edutools/core/dates";
import { DriveApiError, GoogleAuthError } from "@edutools/core/drive";
import {
  DRIVE_NEEDS_ATTENTION,
  type DriveAction,
  type DrivePushResult,
  type DriveState,
  type DriveStatusResult,
  drivePush,
  driveStatus,
} from "@edutools/core/drive-push";
import {
  forgetGoogle,
  loadGoogleClient,
  parseClientJson,
  saveGoogleClient,
  saveRefreshToken,
} from "@edutools/core/google-auth";
import { pyRepr } from "@edutools/core/objects";
import type { Command } from "commander";
import { type Cli, CliExit, type Register } from "../cli";
import { expandHome, printTable, progressLine } from "../format";

/** The errors a drive command reports in one line and exits 1 on. */
function known(cli: Cli, error: unknown): never {
  if (
    error instanceof CourseError ||
    error instanceof DateConfigError ||
    error instanceof GoogleAuthError ||
    error instanceof DriveApiError
  ) {
    throw cli.fail(error.message);
  }
  throw error;
}

const ACTION_ORDER: readonly DriveAction[] = [
  "conflict",
  "create",
  "recreate",
  "update",
  "move",
  "trash",
  "orphan",
  "unchanged",
];

function counts<T extends string>(values: readonly T[], order: readonly T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of order) {
    const n = values.filter((v) => v === value).length;
    if (n > 0) out[value] = n;
  }
  return out;
}

function printPush(cli: Cli, result: DrivePushResult, all: boolean): void {
  const { c } = cli;
  const style = (action: DriveAction, text: string): string =>
    action === "conflict" ? c.red(text) : action === "orphan" || action === "trash" ? c.yellow(text) : action === "unchanged" ? c.dim(text) : c.green(text);
  const shown = result.changes
    .filter((change) => all || change.action !== "unchanged")
    .sort((a, b) => ACTION_ORDER.indexOf(a.action) - ACTION_ORDER.indexOf(b.action));
  if (shown.length > 0) {
    printTable(
      cli,
      result.dryRun ? "Would change in Google Drive" : "Google Drive",
      [{ name: "Action" }, { name: "Kind", style: c.cyan }, { name: "Item" }, { name: "Detail", style: c.dim }],
      shown.map((change) => [style(change.action, change.action), change.kind, change.key || change.name, change.detail]),
    );
  }
  cli.print(`\n${pyRepr(counts(result.changes.map((change) => change.action), ACTION_ORDER))}`);
  for (const [key, links] of Object.entries(result.unresolved)) {
    cli.note(c.yellow(`⚠ ${key}: links to nothing in the Drive copy: ${links.join(", ")}`));
  }
  if (result.root) cli.print(`${result.dryRun ? "" : `${c.green("✓")} `}${result.root.url}`);
  if (result.dryRun) cli.print(c.dim("dry run: nothing was written to Google Drive"));
}

const STATE_ORDER: readonly DriveState[] = ["conflict", "drive", "missing", "repo", "new", "orphan", "in-sync"];

const ADVICE: Readonly<Partial<Record<DriveState, string>>> = {
  conflict: "changed in the repo and edited in Drive: copy the Drive edit into the repo, then push --force",
  drive: "edited in Drive: copy the edit into the repo, or push --force to overwrite it",
  missing: "deleted or trashed in Drive: the next push recreates it",
  repo: "changed in the repo: the next push updates it",
  new: "never pushed: the next push creates it",
  orphan: "no longer in the repo: push --prune trashes it",
};

function printStatus(cli: Cli, result: DriveStatusResult, all: boolean): void {
  const { c } = cli;
  const style = (state: DriveState, text: string): string =>
    state === "conflict" || state === "missing"
      ? c.red(text)
      : state === "drive"
        ? c.yellow(text)
        : state === "repo" || state === "new"
          ? c.green(text)
          : text;
  const shown = result.items
    .filter((item) => all || item.state !== "in-sync")
    .sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state));
  if (shown.length === 0) {
    cli.print(c.green(`✓ the repo and Google Drive are in sync: ${result.items.length} items`));
  } else {
    printTable(
      cli,
      "Repo vs Google Drive",
      [{ name: "State" }, { name: "Kind", style: c.cyan }, { name: "Item" }, { name: "URL", style: c.dim }],
      shown.map((item) => [style(item.state, item.state), item.kind, item.key, item.url]),
    );
    cli.print(`\n${pyRepr(counts(result.items.map((item) => item.state), STATE_ORDER))}`);
    for (const state of STATE_ORDER) {
      const advice = ADVICE[state];
      if (advice && shown.some((item) => item.state === state)) cli.print(`  ${style(state, state)}: ${advice}`);
    }
  }
  if (result.root) cli.print(result.root.url);
}

function registerLogin(drive: Command, cli: Cli): void {
  drive
    .command("login")
    .description(
      "Sign in to Google Drive in the browser, once per machine.\n\n" +
        "edutools signs in as your own OAuth client: in Google Cloud Console, enable the\n" +
        "Google Drive API, set up the consent screen (Internal, for a university\n" +
        "account), create an OAuth client of type 'Desktop app' and download its JSON.\n" +
        "Pass that file with --client the first time; it is kept in the OS keychain.\n\n" +
        "The sign-in asks only for the drive.file scope: edutools can reach the files\n" +
        "and folders it created, and nothing else in the account.",
    )
    .option("--client <file>", "The OAuth client JSON downloaded from Google Cloud Console")
    .action(async (options: { client?: string }) => {
      const { c } = cli;
      const secrets = cli.secrets();
      try {
        if (options.client !== undefined) {
          const client = parseClientJson(readFileSync(expandHome(options.client), "utf8"));
          await saveGoogleClient(client, secrets);
          cli.note(`${c.green("✓")} saved the OAuth client in the keychain`);
        }
        const client = await loadGoogleClient(secrets, cli.env);
        if (client === null) {
          throw cli.fail(
            "No Google OAuth client is set up. Create a 'Desktop app' client in Google Cloud Console, " +
              "then run 'edutools drive login --client <downloaded.json>'.",
          );
        }
        cli.note("Opening the Google sign-in in your browser. If it does not open, go to:");
        const refreshToken = await cli.deps.googleSignIn(client, (url) => {
          cli.note(url);
          cli.deps.openUrl(url);
        });
        await saveRefreshToken(refreshToken, secrets);
        const account = await cli.deps.makeDrive({ ...client, refreshToken }).about();
        cli.print(`${c.green("✓")} signed in to Google Drive as ${account.email || account.name || "an unnamed account"}`);
      } catch (error) {
        if (error instanceof CliExit) throw error;
        known(cli, error);
      }
    });

  drive
    .command("logout")
    .description("Forget the Google Drive sign-in, and with --client the OAuth client too.")
    .option("--client", "Also forget the OAuth client")
    .action(async (options: { client?: boolean }) => {
      const deleted = await forgetGoogle(cli.secrets(), { client: options.client ?? false });
      cli.print(deleted ? `${cli.c.green("✓")} signed out of Google Drive` : "was not signed in to Google Drive");
    });
}

interface PushOptions {
  dryRun?: boolean;
  force?: boolean;
  prune?: boolean;
  name?: string;
  preview?: string;
  all?: boolean;
  json?: boolean;
}

export const register: Register = (program, cli) => {
  const drive = program
    .command("drive")
    .description(
      "Copy a course repository to Google Drive as Google Docs, for colleagues.\n\n" +
        "The syllabus sits at the top of a course folder, each [[module]] is a folder in\n" +
        "order, every page, assignment, discussion and quiz is a Google Doc, and every\n" +
        "course file is stored as it is. Instructor-only sections and never_publish\n" +
        "modules are kept: this copy is for instructors, not students. Sharing the\n" +
        "folder is left to you, in Drive.",
    );
  registerLogin(drive, cli);

  drive
    .command("push")
    .description(
      "Create or update the course's Google Drive folder.\n\n" +
        "The first push makes the folder at the top of My Drive; move it anywhere\n" +
        "afterwards, and later pushes still find it. Every later push updates the\n" +
        "same Docs in place, at the same URLs, and sends only what changed.\n" +
        "<repo>/.drive/manifest.json records the ids: commit it.\n\n" +
        "A Doc edited in Drive since the last push is a conflict and is left alone;\n" +
        "--force overwrites it. Replacing a Doc's text can detach comments anchored to\n" +
        "text that changed. Exits 1 when anything was a conflict.",
    )
    .argument("<repo>", "Course repository containing canvas.toml")
    .option("--dry-run", "Render everything and compare with the manifest; write nothing")
    .option("--force", "Overwrite Docs and files edited in Drive")
    .option("--prune", "Trash Docs, files and folders the repo no longer has")
    .option("--name <name>", "Name the course folder (default: the repo directory's name in capitals)")
    .option("--preview <dir>", "Also write each Doc's HTML to a directory")
    .option("--all", "List unchanged items too")
    .option("--json", "Emit {root, dryRun, changes: [{key, kind, name, action, detail}], unresolved} as JSON")
    .action(async (repoArg: string, options: PushOptions) => {
      const repo = expandHome(repoArg);
      const client = options.dryRun ? null : await cli.drive();
      let result: DrivePushResult;
      try {
        result = await cli.status(options.dryRun ? "Rendering" : "Writing to Google Drive", (update) =>
          drivePush(client, {
            repo,
            dryRun: options.dryRun ?? false,
            force: options.force ?? false,
            prune: options.prune ?? false,
            ...(options.name !== undefined ? { name: options.name } : {}),
            progress: (p) => update(progressLine(p)),
          }),
        );
      } catch (error) {
        known(cli, error);
      }
      if (options.preview !== undefined) {
        const dir = expandHome(options.preview);
        const written = writePreview(result.rendered, dir);
        cli.note(`${cli.c.green("✓")} wrote ${written} preview pages to ${dir}`);
      }
      if (options.json) {
        cli.json({ root: result.root, dryRun: result.dryRun, changes: result.changes, unresolved: result.unresolved });
      } else {
        printPush(cli, result, options.all ?? false);
      }
      if (result.changes.some((change) => change.action === "conflict")) throw new CliExit(1);
    });

  drive
    .command("status")
    .description(
      "Show which side changed since the last push to Google Drive.\n\n" +
        "repo: the next push sends a change. drive: someone edited it in Drive, and a\n" +
        "push leaves it alone without --force. Reads Drive, never writes it. Exits 1\n" +
        "when anything was edited in Drive, conflicts, or went missing.",
    )
    .argument("<repo>", "Course repository containing canvas.toml")
    .option("--all", "List items that are in sync too")
    .option("--json", "Emit {root, items: [{key, kind, name, state, url}]} as JSON")
    .action(async (repoArg: string, options: { all?: boolean; json?: boolean }) => {
      const client = await cli.drive();
      let result: DriveStatusResult;
      try {
        result = await cli.status("Reading Google Drive", (update) =>
          driveStatus(client, { repo: expandHome(repoArg), progress: (p) => update(progressLine(p)) }),
        );
      } catch (error) {
        known(cli, error);
      }
      if (options.json) cli.json(result);
      else printStatus(cli, result, options.all ?? false);
      if (result.items.some((item) => DRIVE_NEEDS_ATTENTION.has(item.state))) throw new CliExit(1);
    });
};

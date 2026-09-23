/**
 * The edutools command: Canvas LMS from the command line.
 *
 * Every command lives in its own file under commands/ and exports `register`.
 * Adding one is a new file plus one line in COMMANDS below; no other command
 * changes. `run` is what the tests drive, with buffers for the streams, an
 * in-memory keychain and a fake Canvas client; the bottom of the file runs it
 * against the real process when this is the entry point.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { VERSION } from "@edutools/core/version";
import { Command, CommanderError } from "commander";
import { Cli, type CliDeps, CliExit, canvasClient, type Register } from "./cli";
import { register as assignments } from "./commands/assignments";
import { register as audit } from "./commands/audit";
import { register as check } from "./commands/check";
import { register as courses } from "./commands/courses";
import { register as create } from "./commands/create";
import { register as dates } from "./commands/dates";
import { register as deleteCommand } from "./commands/delete";
import { register as download } from "./commands/download";
import { register as grade } from "./commands/grade";
import { register as groups } from "./commands/groups";
import { register as init } from "./commands/init";
import { register as modules } from "./commands/modules";
import { register as outline } from "./commands/outline";
import { register as publish } from "./commands/publish";
import { register as pull } from "./commands/pull";
import { register as push } from "./commands/push";
import { register as site } from "./commands/site";
import { register as students } from "./commands/students";
import { register as submission } from "./commands/submission";
import { register as submissions } from "./commands/submissions";
import { register as ungraded } from "./commands/ungraded";
import { register as unpublish } from "./commands/unpublish";
import { register as update } from "./commands/update";
import { register as verify } from "./commands/verify";
import { messageOf } from "./format";

/** Every command, in the order `--help` lists them. */
const COMMANDS: readonly Register[] = [
  // setup and credentials
  init,
  check,
  site,
  // reading
  courses,
  assignments,
  modules,
  groups,
  students,
  submissions,
  ungraded,
  pull,
  // course repositories
  push,
  verify,
  audit,
  outline,
  dates,
  // one object at a time
  create,
  update,
  deleteCommand,
  publish,
  unpublish,
  // grading
  submission,
  download,
  grade,
];

export function createProgram(cli: Cli): Command {
  const program = new Command("edutools");
  // Set before any subcommand exists: commander copies these settings into
  // each command as it is created, so every level exits and writes the same way.
  program
    .description(
      "Edu Tools - Canvas LMS from the command line\n\n" +
        "Query courses, students, assignments, and submissions, and publish a course\n" +
        "repository into Canvas.\n\n" +
        "Use --help with any command for more information.",
    )
    .exitOverride()
    .configureOutput({
      writeOut: (text) => cli.deps.stdout.write(text),
      writeErr: (text) => cli.deps.stderr.write(text),
    })
    .version(`edutools ${cli.deps.version}`, "-V, --version", "Show the edutools version and exit.")
    .option("--site <name>", "The Canvas site to use (default: the default site)")
    .hook("preAction", () => {
      cli.site = program.opts<{ site?: string }>().site;
    });
  for (const register of COMMANDS) register(program, cli);
  summarise(program);
  return program;
}

/**
 * List each command by the first line of its description, as click does, and
 * keep the rest for that command's own --help.
 */
function summarise(command: Command): void {
  for (const sub of command.commands) {
    if (!sub.summary()) sub.summary(sub.description().split("\n")[0] ?? "");
    summarise(sub);
  }
}

function defaults(): CliDeps {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    env: process.env,
    credentials: {},
    makeClient: canvasClient,
    version: VERSION,
  };
}

/** Run one command line and resolve to its exit code. */
export async function run(argv: readonly string[], deps: Partial<CliDeps> = {}): Promise<number> {
  const cli = new Cli({ ...defaults(), ...deps });
  const program = createProgram(cli);
  try {
    if (argv.length === 0) {
      // typer's no_args_is_help.
      program.outputHelp();
      return 0;
    }
    await program.parseAsync([...argv], { from: "user" });
    return 0;
  } catch (error) {
    if (error instanceof CliExit) return error.code;
    // --help and --version arrive as a CommanderError with exit code 0. Anything
    // else commander raises is a usage error, which click exits with 2.
    if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : 2;
    cli.error(`Error: ${messageOf(error)}`);
    return 1;
  } finally {
    cli.close();
  }
}

/** True when this module is the script node was asked to run, not an import. */
function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  run(process.argv.slice(2)).then((code) => {
    // exitCode rather than exit(): a large --json payload on a pipe is written
    // asynchronously, and exit() would cut it off.
    process.exitCode = code;
  });
}

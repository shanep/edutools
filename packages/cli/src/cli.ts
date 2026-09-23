/**
 * What every command runs against: where output goes, where input comes from,
 * how credentials resolve, and how a Canvas client is built.
 *
 * Commands never touch process.stdout, process.env or `new CanvasLMS` directly.
 * They go through a `Cli`, which main.ts builds from the real process and the
 * tests build from buffers, an in-memory keychain and a fake client. That is what
 * lets a test drive the real commander program and assert on the form body a
 * command sent, the same way the Python tests did through typer's CliRunner.
 *
 * Output discipline: stdout carries the result (a table, or with --json the raw
 * payload and nothing else). Prompts, spinners, warnings and errors go to stderr,
 * so `edutools courses --json | jq` always receives parseable JSON.
 */

import { createInterface, type Interface } from "node:readline";
import { Writable } from "node:stream";
import { CanvasLMS } from "@edutools/core/canvas";
import {
  type CredentialOptions,
  CredentialsError,
  type ResolvedCredentials,
  resolveCredentials,
} from "@edutools/core/credentials";
import type { CourseCanvas } from "@edutools/core/course";
import type { PullCanvas } from "@edutools/core/pull";
import type { Command } from "commander";
import pc from "picocolors";

/** The client methods the commands call, so a test can hand in a plain object. */
export type CanvasClient = PullCanvas &
  CourseCanvas &
  Pick<
    CanvasLMS,
    | "getCourses"
    | "getCourse"
    | "getAssignments"
    | "getStudents"
    | "getSubmissions"
    | "getUngradedSubmissions"
    | "createObject"
    | "getObject"
    | "updateObject"
    | "deleteObject"
    | "getCourseFile"
    | "deleteFile"
    | "getSubmission"
    | "gradeSubmission"
  >;

/** Somewhere text is written: process.stdout, or a buffer in a test. */
export interface Output {
  write(chunk: string): unknown;
  readonly isTTY?: boolean;
}

/** Somewhere lines are read from: process.stdin, or a Readable in a test. */
export type Input = NodeJS.ReadableStream & {
  readonly isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
};

export interface CliDeps {
  readonly stdout: Output;
  readonly stderr: Output;
  readonly stdin: Input;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Where sites and tokens live; tests pass a temp dir and memoryStore(). */
  readonly credentials: CredentialOptions;
  readonly makeClient: (credentials: ResolvedCredentials) => CanvasClient;
  readonly version: string;
}

/** Leave the command with this exit code; whatever needed saying is already said. */
export class CliExit extends Error {
  readonly code: number;

  constructor(code: number) {
    super(`exit ${code}`);
    this.name = "CliExit";
    this.code = code;
  }
}

/** The real client, built from resolved credentials. */
export function canvasClient(credentials: ResolvedCredentials): CanvasClient {
  return new CanvasLMS({ token: credentials.token, endpoint: credentials.endpoint });
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/**
 * Lines from stdin, read through one readline interface for the whole run.
 *
 * A second interface on the same stream would lose whatever the first had
 * already buffered, so a course prompt followed by an assignment prompt fed
 * from a pipe would see the second answer vanish.
 */
class LineReader {
  private readonly lines: string[] = [];
  private readonly waiting: Array<(line: string | null) => void> = [];
  private closed = false;
  private readonly rl: Interface;

  constructor(input: Input) {
    this.rl = createInterface({ input, terminal: false });
    this.rl.on("line", (line) => {
      const next = this.waiting.shift();
      if (next) next(line);
      else this.lines.push(line);
    });
    this.rl.on("close", () => {
      this.closed = true;
      for (const next of this.waiting.splice(0)) next(null);
    });
  }

  /** The next line, or null at the end of input. */
  next(): Promise<string | null> {
    const line = this.lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  /** Everything left, joined back together. */
  async rest(): Promise<string> {
    const all: string[] = [];
    for (let line = await this.next(); line !== null; line = await this.next()) all.push(line);
    return all.join("\n");
  }

  close(): void {
    this.rl.close();
  }
}

export class Cli {
  readonly deps: CliDeps;
  /** Colours for stdout, off when it is not a terminal or NO_COLOR is set. */
  readonly c: ReturnType<typeof pc.createColors>;
  /** Colours for stderr. */
  readonly e: ReturnType<typeof pc.createColors>;
  /** The global --site option, set before any command runs. */
  site: string | undefined;
  private reader: LineReader | undefined;
  private client: CanvasClient | undefined;
  private resolved: ResolvedCredentials | undefined;

  constructor(deps: CliDeps) {
    this.deps = deps;
    this.c = pc.createColors(this.colour(deps.stdout));
    this.e = pc.createColors(this.colour(deps.stderr));
  }

  private colour(stream: Output): boolean {
    const env = this.deps.env;
    if (env.NO_COLOR) return false;
    if (env.FORCE_COLOR) return true;
    return Boolean(stream.isTTY);
  }

  get env(): Readonly<Record<string, string | undefined>> {
    return this.deps.env;
  }

  /** A line of result on stdout. */
  print(line = ""): void {
    this.deps.stdout.write(`${line}\n`);
  }

  /** A line of commentary on stderr: prompts, warnings, errors. */
  note(line = ""): void {
    this.deps.stderr.write(`${line}\n`);
  }

  /** An error on stderr, in red. */
  error(message: string): void {
    this.note(this.e.red(message));
  }

  /** Print the raw payload so a caller can parse it instead of a table. */
  json(payload: unknown): void {
    this.deps.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  }

  /** Print an error and hand back the exit to throw: `throw cli.fail("...")`. */
  fail(message: string, code = 1): CliExit {
    this.error(message);
    return new CliExit(code);
  }

  /** The credentials for this run, resolved once. */
  async credentials(): Promise<ResolvedCredentials> {
    const resolved = await this.tryCredentials();
    if (resolved instanceof CredentialsError) {
      this.notConfigured(resolved.message);
      throw new CliExit(1);
    }
    return resolved;
  }

  /**
   * The credentials, or the reason there are none, printing nothing. For a
   * command such as `check --json` that has to report the failure on stdout.
   */
  async tryCredentials(): Promise<ResolvedCredentials | CredentialsError> {
    if (this.resolved) return this.resolved;
    try {
      this.resolved = await resolveCredentials(this.site, {
        ...this.deps.credentials,
        env: this.deps.env,
      });
    } catch (error) {
      if (!(error instanceof CredentialsError)) throw error;
      return error;
    }
    return this.resolved;
  }

  /** What a command prints when there is no token to use. */
  notConfigured(message: string): void {
    this.note(`${this.e.red("✗")} ${this.e.bold(this.e.magenta("Canvas LMS"))} - not configured`);
    this.note(`  ${message}`);
    this.note(this.e.dim("  'edutools init' shows the setup status and imports an old config.toml; CANVAS_TOKEN also works."));
  }

  /** The Canvas client, built on first use so a command that fails validation never needs one. */
  async canvas(): Promise<CanvasClient> {
    if (!this.client) this.client = this.deps.makeClient(await this.credentials());
    return this.client;
  }

  /**
   * Run `work` behind a spinner on stderr. The spinner only draws on a terminal,
   * so piped output and tests see nothing but the result.
   */
  async status<T>(text: string, work: (update: (text: string) => void) => Promise<T>): Promise<T> {
    const stream = this.deps.stderr;
    if (!stream.isTTY) return work(() => {});
    let label = text;
    let frame = 0;
    const draw = () => {
      stream.write(`\r${this.e.green(SPINNER[frame % SPINNER.length] ?? "")} ${label}\x1b[K`);
      frame += 1;
    };
    draw();
    const timer = setInterval(draw, 80);
    try {
      return await work((next) => {
        label = next;
      });
    } finally {
      clearInterval(timer);
      stream.write("\r\x1b[K");
    }
  }

  private lines(): LineReader {
    if (!this.reader) this.reader = new LineReader(this.deps.stdin);
    return this.reader;
  }

  /** Ask on stderr and read one line; null at the end of input. */
  async ask(question: string): Promise<string | null> {
    this.deps.stderr.write(question);
    return this.lines().next();
  }

  /** click.confirm: y or yes proceeds, anything else (or nothing) does not. */
  async confirm(question: string): Promise<boolean> {
    const answer = await this.ask(`${question} [y/N]: `);
    return answer !== null && ["y", "yes"].includes(answer.trim().toLowerCase());
  }

  /** click.prompt(type=int): re-ask until the answer is a whole number. End of input aborts. */
  async askInt(question: string): Promise<number> {
    for (;;) {
      const answer = await this.ask(`${question}: `);
      if (answer === null) {
        this.note("Aborted!");
        throw new CliExit(1);
      }
      const trimmed = answer.trim();
      if (/^[+-]?\d+$/.test(trimmed)) return Number(trimmed);
      this.error(`Error: '${trimmed}' is not a valid integer.`);
    }
  }

  /** All of stdin, for `--from-file -`. */
  async readStdin(): Promise<string> {
    return this.lines().rest();
  }

  /**
   * A secret, never echoed. On a terminal it is typed at a hidden prompt; from a
   * pipe it is the first line, so `pbpaste | edutools site add ...` works and the
   * token never lands in shell history.
   */
  async secret(question: string): Promise<string | null> {
    const input = this.deps.stdin;
    if (!input.isTTY) return this.lines().next();
    this.deps.stderr.write(question);
    // A readline whose echo goes nowhere: the terminal still handles editing
    // keys, but nothing typed is written back to the screen.
    const muted = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });
    const rl = createInterface({ input, output: muted, terminal: true });
    try {
      return await new Promise<string | null>((resolve) => {
        rl.once("line", resolve);
        rl.once("close", () => resolve(null));
        // In terminal mode readline swallows Ctrl+C and merely pauses unless
        // someone listens, which would leave the prompt hanging.
        rl.once("SIGINT", () => rl.close());
      });
    } finally {
      rl.close();
      this.deps.stderr.write("\n");
    }
  }

  /** Release stdin so the process can exit. */
  close(): void {
    this.reader?.close();
  }
}

/** Each command file exports one of these; main.ts calls them in order. */
export type Register = (program: Command, cli: Cli) => void;

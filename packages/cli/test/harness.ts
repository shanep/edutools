/**
 * Drive the real commander program the way a shell would, and stop at the Canvas
 * client, so a test covers the wiring between a flag and the form body Canvas
 * would receive. This is typer's CliRunner from the Python tests.
 */

import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { CanvasLMS } from "@edutools/core/canvas";
import { type CredentialOptions, memoryStore, type ResolvedCredentials } from "@edutools/core/credentials";
import { type Mock, vi } from "vitest";
import type { CanvasClient } from "../src/cli";
import { run } from "../src/main";

export type FakeClient = { [K in keyof CanvasClient]: Mock<CanvasClient[K]> };

// A record rather than a list, so the compiler insists every client method is here.
const METHODS: Readonly<Record<keyof CanvasClient, true>> = {
  getCourses: true,
  getCourse: true,
  getAssignments: true,
  getStudents: true,
  getSubmissions: true,
  getUngradedSubmissions: true,
  createObject: true,
  getObject: true,
  updateObject: true,
  deleteObject: true,
  getSubmission: true,
  gradeSubmission: true,
  getCourseWithSyllabus: true,
  listPages: true,
  getPage: true,
  listAssignments: true,
  listDiscussions: true,
  listAnnouncements: true,
  listQuizzes: true,
  listQuizQuestions: true,
  listModules: true,
  listModuleItems: true,
  listAssignmentGroups: true,
  listRubrics: true,
  listFolders: true,
  listFiles: true,
  downloadAttachment: true,
  getJson: true,
  exists: true,
  updateSyllabus: true,
  createAssignmentGroup: true,
  updateAssignmentGroup: true,
  setGroupWeighting: true,
  createPage: true,
  updatePage: true,
  createAssignment: true,
  updateAssignment: true,
  createDiscussion: true,
  updateDiscussion: true,
  createQuiz: true,
  updateQuiz: true,
  createQuizQuestion: true,
  deleteQuizQuestion: true,
  uploadFile: true,
  createModule: true,
  updateModule: true,
  createModuleItem: true,
  deleteModuleItem: true,
  createRubric: true,
  getAssignmentFull: true,
  getDiscussion: true,
  getQuiz: true,
  getFile: true,
  listJson: true,
};

/** A client whose every method is a mock that fails loudly unless a test stubs it. */
export function fakeClient(): FakeClient {
  const client: Partial<Record<keyof CanvasClient, Mock>> = {};
  // Object.keys widens to string[]; METHODS is keyed by exactly the client's methods.
  for (const name of Object.keys(METHODS) as Array<keyof CanvasClient>) {
    client[name] = vi.fn(() => {
      throw new Error(`unexpected call to ${name}`);
    });
  }
  // Every method named in CanvasClient was filled in just above.
  return client as FakeClient;
}

export function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "edutools-"));
}

export interface Invocation {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** stdout and stderr together, which is what CliRunner's result.output held. */
  readonly output: string;
}

export interface InvokeOptions {
  readonly client?: CanvasClient;
  readonly makeClient?: (credentials: ResolvedCredentials) => CanvasClient;
  /** What is typed at the prompts, or piped in. */
  readonly input?: string;
  readonly env?: Record<string, string | undefined>;
  readonly credentials?: CredentialOptions;
}

/**
 * Run `edutools <argv>`. By default CANVAS_TOKEN is set, as the Python tests'
 * fixture did, and the keychain is an empty in-memory store in a temp dir, so a
 * test never reads the developer's own sites or tokens.
 */
export async function invoke(argv: readonly string[], options: InvokeOptions = {}): Promise<Invocation> {
  let stdout = "";
  let stderr = "";
  let output = "";
  const dir = tmpDir();
  const code = await run(argv, {
    stdout: {
      write: (chunk: string) => {
        stdout += chunk;
        output += chunk;
      },
    },
    stderr: {
      write: (chunk: string) => {
        stderr += chunk;
        output += chunk;
      },
    },
    stdin: Readable.from(options.input === undefined ? [] : [options.input]),
    env: options.env ?? { CANVAS_TOKEN: "tok" },
    credentials: options.credentials ?? {
      dir,
      secrets: memoryStore(),
      legacyPath: path.join(dir, "config.toml"),
    },
    makeClient:
      options.makeClient ??
      (() => {
        if (!options.client) throw new Error("this test gave no Canvas client");
        return options.client;
      }),
    version: "1.0.1",
  });
  return { code, stdout, stderr, output };
}

export interface Recorded {
  readonly method: string;
  readonly url: string;
  readonly body: URLSearchParams;
}

/**
 * A real CanvasLMS over a fake fetch, for asserting on the exact form body a
 * command put on the wire. Every request answers with `reply`.
 */
export function recordingClient(reply: unknown): {
  requests: Recorded[];
  makeClient: (credentials: ResolvedCredentials) => CanvasClient;
} {
  const requests: Recorded[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    requests.push({
      method: init?.method ?? "GET",
      url: String(input),
      body: new URLSearchParams(typeof init?.body === "string" ? init.body : ""),
    });
    return new Response(JSON.stringify(reply), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return {
    requests,
    makeClient: (credentials) => new CanvasLMS({ token: credentials.token, endpoint: credentials.endpoint, fetch }),
  };
}

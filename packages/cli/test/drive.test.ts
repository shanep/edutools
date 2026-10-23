/**
 * `edutools drive`: the sign-in, a push and a status, with a fake Google
 * sign-in and an in-memory Drive. No browser and no network.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { memoryStore, type SecretStore } from "@edutools/core/credentials";
import type { DriveFile, GoogleAuth, GoogleClient } from "@edutools/core/drive";
import { GOOGLE_CLIENT_ACCOUNT, GOOGLE_REFRESH_ACCOUNT } from "@edutools/core/google-auth";
import { describe, expect, it } from "vitest";
import type { DriveCommandClient } from "../src/cli";
import { invoke, tmpDir } from "./harness";

const TOML = `[term]
timezone = "America/Boise"
first_monday = 2026-08-24
weeks = 15
last_day_of_instruction = 2026-12-11
finals_start = 2026-12-14
finals_end = 2026-12-18
total_points = 0

[term.policy.project]
due = "tue 23:59"

[layout]
syllabus = "index.md"
pages = ["pages/*.md"]
files = []

[[module]]
title = "Week 1"
items = ["pages/welcome.md"]
`;

function makeRepo(): string {
  const repo = tmpDir();
  mkdirSync(path.join(repo, "pages"));
  writeFileSync(path.join(repo, "canvas.toml"), TOML);
  writeFileSync(path.join(repo, "index.md"), "# Syllabus\n\nRead [the welcome](pages/welcome.md).\n");
  writeFileSync(path.join(repo, "pages", "welcome.md"), "# Welcome\n\nHello.\n");
  return repo;
}

/** Just enough Drive for a push: files in a map, a clock that moves on every write. */
function fakeDrive(): DriveCommandClient & { files: Map<string, DriveFile> } {
  const files = new Map<string, DriveFile>();
  let next = 0;
  const stamp = () => new Date(Date.UTC(2026, 9, 1) + ++next * 1000).toISOString();
  const make = (name: string, mimeType: string, parent: string | null): DriveFile => {
    const id = `id${next + 1}`;
    const file = { id, name, mimeType, modifiedTime: stamp(), trashed: false, parents: [parent ?? "my-drive"], webViewLink: "" };
    files.set(id, file);
    return file;
  };
  const touch = (id: string, change: Partial<DriveFile> = {}): DriveFile => {
    const file = { ...(files.get(id) as DriveFile), ...change, modifiedTime: stamp() };
    files.set(id, file);
    return file;
  };
  return {
    files,
    about: async () => ({ email: "me@example.edu", name: "Me" }),
    getFile: async (id) => files.get(id) ?? null,
    createFolder: async (name, parent) => make(name, "folder", parent),
    createDoc: async (name, parent) => make(name, "doc", parent),
    uploadFile: async (name, parent, _bytes, type) => make(name, type, parent),
    replaceContent: async (id) => touch(id),
    updateMetadata: async (id, change) => touch(id, change.name === undefined ? {} : { name: change.name }),
    trash: async (id) => {
      touch(id, { trashed: true });
    },
  };
}

function credentials(secrets: SecretStore = memoryStore()) {
  const dir = tmpDir();
  return { dir, secrets, legacyPath: path.join(dir, "config.toml") };
}

async function signedIn(): Promise<SecretStore> {
  const secrets = memoryStore();
  await secrets.set(GOOGLE_CLIENT_ACCOUNT, JSON.stringify({ clientId: "cid", clientSecret: "cs" }));
  await secrets.set(GOOGLE_REFRESH_ACCOUNT, "rtok");
  return secrets;
}

describe("drive login", () => {
  it("imports the client, signs in and names the account", async () => {
    const secrets = memoryStore();
    const clientFile = path.join(tmpDir(), "client.json");
    writeFileSync(clientFile, JSON.stringify({ installed: { client_id: "cid", client_secret: "cs" } }));
    const opened: string[] = [];
    let auth: GoogleAuth | null = null;
    const result = await invoke(["drive", "login", "--client", clientFile], {
      credentials: credentials(secrets),
      googleSignIn: async (client: GoogleClient, open) => {
        expect(client).toEqual({ clientId: "cid", clientSecret: "cs" });
        open("https://accounts.example/consent");
        return "fresh";
      },
      openUrl: (url) => opened.push(url),
      makeDrive: (given) => {
        auth = given;
        return fakeDrive();
      },
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("signed in to Google Drive as me@example.edu");
    expect(result.stderr).toContain("https://accounts.example/consent");
    expect(opened).toEqual(["https://accounts.example/consent"]);
    expect(auth).toEqual({ clientId: "cid", clientSecret: "cs", refreshToken: "fresh" });
    expect(await secrets.get(GOOGLE_REFRESH_ACCOUNT)).toBe("fresh");
  });

  it("says how to set up a client when there is none", async () => {
    const result = await invoke(["drive", "login"], { credentials: credentials() });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("drive login --client");
  });

  it("reports a bad client file in one line", async () => {
    const clientFile = path.join(tmpDir(), "client.json");
    writeFileSync(clientFile, "{}");
    const result = await invoke(["drive", "login", "--client", clientFile], { credentials: credentials() });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Desktop app");
  });
});

describe("drive logout", () => {
  it("forgets the sign-in and keeps the client unless asked", async () => {
    const secrets = await signedIn();
    expect((await invoke(["drive", "logout"], { credentials: credentials(secrets) })).stdout).toContain("signed out");
    expect(await secrets.get(GOOGLE_REFRESH_ACCOUNT)).toBeNull();
    expect(await secrets.get(GOOGLE_CLIENT_ACCOUNT)).not.toBeNull();
    await invoke(["drive", "logout", "--client"], { credentials: credentials(secrets) });
    expect(await secrets.get(GOOGLE_CLIENT_ACCOUNT)).toBeNull();
  });
});

describe("drive push", () => {
  it("dry-runs with no sign-in and writes previews", async () => {
    const repo = makeRepo();
    const preview = tmpDir();
    const result = await invoke(["drive", "push", repo, "--dry-run", "--preview", preview], { credentials: credentials() });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Would change in Google Drive");
    expect(result.stdout).toContain("pages/welcome.md");
    expect(result.stdout).toContain("dry run");
    expect(result.stderr).toContain("preview pages");
  });

  it("fails in one line when not signed in", async () => {
    const result = await invoke(["drive", "push", makeRepo()], { credentials: credentials() });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("No Google OAuth client");
  });

  it("pushes, then finds nothing to send, then reports a Drive edit", async () => {
    const repo = makeRepo();
    const drive = fakeDrive();
    const options = { credentials: credentials(await signedIn()), makeDrive: () => drive };
    const first = await invoke(["drive", "push", repo, "--name", "CS999", "--json"], options);
    expect(first.code).toBe(0);
    const payload = JSON.parse(first.stdout);
    expect(payload.dryRun).toBe(false);
    expect(payload.root.url).toMatch(/^https:\/\/drive\.google\.com\/drive\/folders\//);
    expect(payload.changes.map((c: { action: string }) => c.action)).toContain("create");

    const status = await invoke(["drive", "status", repo], options);
    expect(status.code).toBe(0);
    expect(status.stdout).toContain("in sync");

    const welcome = [...drive.files.values()].find((f) => f.name === "01 Welcome");
    drive.files.set(welcome?.id ?? "", { ...(welcome as DriveFile), modifiedTime: "2027-01-01T00:00:00.000Z" });
    const edited = await invoke(["drive", "status", repo, "--json"], options);
    expect(edited.code).toBe(1);
    const items = JSON.parse(edited.stdout).items as { key: string; state: string }[];
    expect(items.find((item) => item.key === "pages/welcome.md")?.state).toBe("drive");

    writeFileSync(path.join(repo, "pages", "welcome.md"), "# Welcome\n\nHello again.\n");
    const conflict = await invoke(["drive", "push", repo], options);
    expect(conflict.code).toBe(1);
    expect(conflict.stdout).toContain("conflict");
    expect((await invoke(["drive", "push", repo, "--force"], options)).code).toBe(0);
  });
});

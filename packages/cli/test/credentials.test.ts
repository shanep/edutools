/**
 * Credentials: the site commands, init's import of the old config.toml, check,
 * and how --site and the environment pick the client a command gets.
 */

import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  addSite,
  type CredentialOptions,
  loadSites,
  memoryStore,
  type ResolvedCredentials,
} from "@edutools/core/credentials";
import { beforeEach, describe, expect, it } from "vitest";
import type { CanvasClient } from "../src/cli";
import { type FakeClient, fakeClient, invoke, tmpDir } from "./harness";

const BSU = "https://boisestatecanvas.instructure.com";
const OTHER = "https://canvas.example.edu";
const TOKEN = "1234~abcdefghijklmnop";

let dir: string;
let secrets: ReturnType<typeof memoryStore>;
let credentials: CredentialOptions;
let canvas: FakeClient;
let built: ResolvedCredentials[];

beforeEach(() => {
  dir = tmpDir();
  secrets = memoryStore();
  credentials = { dir, secrets, legacyPath: path.join(dir, "config.toml") };
  canvas = fakeClient();
  built = [];
});

/** Run with no environment token, so the keychain is the only source. */
function keychainOnly(argv: readonly string[], input?: string) {
  return invoke(argv, {
    env: {},
    credentials,
    input,
    makeClient: (resolved): CanvasClient => {
      built.push(resolved);
      return canvas;
    },
  });
}

describe("site add", () => {
  it("reads the token from stdin and saves it in the keychain", async () => {
    const result = await keychainOnly(["site", "add", "bsu", "--endpoint", `${BSU}/`], `${TOKEN}\n`);

    expect(result.code, result.output).toBe(0);
    expect(secrets.entries.get(BSU)).toBe(TOKEN);
    expect(loadSites(credentials)).toEqual({ defaultSite: "bsu", sites: [{ name: "bsu", endpoint: BSU }] });
    // Only the hint is ever printed.
    expect(result.output).not.toContain(TOKEN);
    expect(result.stdout).toContain("****mnop");
  });

  it("an empty stdin saves nothing", async () => {
    const result = await keychainOnly(["site", "add", "bsu", "--endpoint", BSU]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("No token given");
    expect(loadSites(credentials).sites).toEqual([]);
  });

  it("the token is never a flag", async () => {
    const result = await keychainOnly(["site", "add", "bsu", "--endpoint", BSU, "--token", TOKEN]);

    expect(result.code).toBe(2);
    expect(secrets.entries.size).toBe(0);
  });

  it("a duplicate name is refused cleanly", async () => {
    await addSite({ name: "bsu", endpoint: BSU, token: TOKEN }, credentials);
    const result = await keychainOnly(["site", "add", "bsu", "--endpoint", OTHER], "other-token\n");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("already exists");
  });
});

describe("site list, default and remove", () => {
  it("list --json gives token hints, never tokens", async () => {
    await addSite({ name: "bsu", endpoint: BSU, token: TOKEN }, credentials);
    await addSite({ name: "other", endpoint: OTHER }, credentials);
    const result = await keychainOnly(["site", "list", "--json"]);

    expect(result.code, result.output).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      { name: "bsu", endpoint: BSU, isDefault: true, tokenHint: "****mnop" },
      { name: "other", endpoint: OTHER, isDefault: false, tokenHint: null },
    ]);
    expect(result.output).not.toContain(TOKEN);
  });

  it("default switches the site commands use", async () => {
    await addSite({ name: "bsu", endpoint: BSU, token: TOKEN }, credentials);
    await addSite({ name: "other", endpoint: OTHER, token: "other-token-xyz" }, credentials);
    const result = await keychainOnly(["site", "default", "other"]);

    expect(result.code, result.output).toBe(0);
    expect(loadSites(credentials).defaultSite).toBe("other");
  });

  it("remove deletes the site and its token", async () => {
    await addSite({ name: "bsu", endpoint: BSU, token: TOKEN }, credentials);
    const result = await keychainOnly(["site", "remove", "bsu"]);

    expect(result.code, result.output).toBe(0);
    expect(loadSites(credentials).sites).toEqual([]);
    expect(secrets.entries.has(BSU)).toBe(false);
  });

  it("an unknown site is an error, not a crash", async () => {
    const result = await keychainOnly(["site", "default", "nowhere"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("No Canvas site named 'nowhere'");
  });
});

describe("resolving the client", () => {
  it("the default site's keychain token builds the client", async () => {
    await addSite({ name: "bsu", endpoint: BSU, token: TOKEN }, credentials);
    canvas.getCourses.mockResolvedValue([]);
    const result = await keychainOnly(["courses", "--json"]);

    expect(result.code, result.output).toBe(0);
    expect(built).toEqual([{ endpoint: BSU, token: TOKEN, source: "keychain", site: "bsu" }]);
  });

  it("--site picks another site, before or after the command", async () => {
    await addSite({ name: "bsu", endpoint: BSU, token: TOKEN }, credentials);
    await addSite({ name: "other", endpoint: OTHER, token: "other-token-xyz" }, credentials);
    canvas.getCourses.mockResolvedValue([]);

    await keychainOnly(["--site", "other", "courses"]);
    await keychainOnly(["courses", "--site", "other"]);

    expect(built.map((b) => b.endpoint)).toEqual([OTHER, OTHER]);
  });

  it("CANVAS_TOKEN in the environment wins", async () => {
    await addSite({ name: "bsu", endpoint: BSU, token: TOKEN }, credentials);
    canvas.getCourses.mockResolvedValue([]);
    await invoke(["courses"], {
      env: { CANVAS_TOKEN: "env-token" },
      credentials,
      makeClient: (resolved) => {
        built.push(resolved);
        return canvas;
      },
    });

    expect(built).toEqual([{ endpoint: BSU, token: "env-token", source: "env", site: null }]);
  });

  it("no token still reaches the command", async () => {
    // A missing token prints setup help; it must not crash before that.
    const result = await keychainOnly(["publish", "assignment", "42", "-c", "123"]);

    expect(result.code).toBe(1);
    expect(result.output).toContain("not configured");
    expect(result.output).toContain("edutools init");
    expect(canvas.updateObject).not.toHaveBeenCalled();
  });
});

describe("check", () => {
  it("reports the endpoint, the keychain site and the course count", async () => {
    await addSite({ name: "bsu", endpoint: BSU, token: TOKEN }, credentials);
    canvas.getCourses.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    const result = await keychainOnly(["check"]);

    expect(result.code, result.output).toBe(0);
    expect(result.stdout).toContain(`${BSU} (2 courses)`);
    expect(result.stdout).toContain("keychain, site 'bsu'");
  });

  it("json reports the same, and only that", async () => {
    canvas.getCourses.mockResolvedValue([{ id: 1 }]);
    const result = await invoke(["check", "--json"], { client: canvas });

    expect(JSON.parse(result.stdout)).toEqual({ endpoint: BSU, source: "env", site: null, courses: 1 });
  });

  it("a rejected token exits 1 with the error", async () => {
    canvas.getCourses.mockRejectedValue(new Error("Canvas API error 401: Invalid access token."));
    const result = await invoke(["check"], { client: canvas });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Invalid access token.");
    expect(result.stderr).toContain("CANVAS_TOKEN from the environment");
  });

  it("nothing set up exits 1 and says how", async () => {
    const result = await keychainOnly(["check"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not configured");
  });
});

describe("init", () => {
  it("imports the legacy config.toml token into the keychain", async () => {
    writeFileSync(
      path.join(dir, "config.toml"),
      `[canvas]\ntoken = "${TOKEN}"\nendpoint = "${OTHER}"\n`,
      "utf-8",
    );
    const result = await keychainOnly(["init"]);

    expect(result.code, result.output).toBe(0);
    expect(secrets.entries.get(OTHER)).toBe(TOKEN);
    expect(result.stdout).toContain("imported the token");
    expect(result.stdout).toContain("canvas.example.edu");
    expect(result.stdout).toContain("configured");
    expect(result.output).not.toContain(TOKEN);
  });

  it("with nothing to import it says how to add a site", async () => {
    const result = await keychainOnly(["init"]);

    expect(result.code, result.output).toBe(0);
    expect(result.stdout).toContain("not configured");
    expect(result.stdout).toContain("edutools site add");
    expect(result.stdout).toContain("Approved Integrations");
  });

  it("a legacy file with an empty token imports nothing", async () => {
    writeFileSync(path.join(dir, "config.toml"), '[canvas]\ntoken = ""\n', "utf-8");
    const result = await keychainOnly(["init"]);

    expect(result.code, result.output).toBe(0);
    expect(secrets.entries.size).toBe(0);
    expect(result.stdout).not.toContain("imported");
  });
});

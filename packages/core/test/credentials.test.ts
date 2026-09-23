import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  addSite,
  type CredentialOptions,
  CredentialsError,
  configDir,
  configPath,
  defaultSite,
  importLegacyConfig,
  listSites,
  loadSites,
  maskToken,
  memoryStore,
  normalizeEndpoint,
  removeSite,
  resolveCredentials,
  setDefaultSite,
  setToken,
} from "@edutools/core/credentials";
import { beforeEach, describe, expect, it } from "vitest";

const BSU = "https://boisestatecanvas.instructure.com";
const OTHER = "https://canvas.example.edu";

let dir: string;
let secrets: ReturnType<typeof memoryStore>;
let opts: CredentialOptions;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "edutools-"));
  secrets = memoryStore();
  // An empty environment so a developer's own CANVAS_TOKEN never leaks into a test.
  opts = { dir, secrets, env: {}, legacyPath: path.join(dir, "config.toml") };
});

describe("configDir", () => {
  it("uses Application Support on macOS", () => {
    expect(configDir({ platform: "darwin", home: "/Users/a", env: {} })).toBe(
      path.join("/Users/a", "Library", "Application Support", "edutools"),
    );
  });

  it("uses APPDATA on Windows", () => {
    expect(configDir({ platform: "win32", home: "C:\\Users\\a", env: { APPDATA: "D:\\roaming" } })).toBe(
      path.join("D:\\roaming", "edutools"),
    );
  });

  it("uses XDG_CONFIG_HOME on Linux, else ~/.config", () => {
    expect(configDir({ platform: "linux", home: "/home/a", env: { XDG_CONFIG_HOME: "/xdg" } })).toBe(
      path.join("/xdg", "edutools"),
    );
    expect(configDir({ platform: "linux", home: "/home/a", env: {} })).toBe(path.join("/home/a", ".config", "edutools"));
  });
});

describe("sites", () => {
  it("starts empty when there is no config file", async () => {
    expect(loadSites(opts)).toEqual({ defaultSite: null, sites: [] });
    expect(await listSites(opts)).toEqual([]);
    expect(defaultSite(opts)).toBeNull();
  });

  it("keeps the token in the secret store, never in the config file", async () => {
    await addSite({ name: "BSU", endpoint: `${BSU}/`, token: "secret-token-1234" }, opts);
    const onDisk = readFileSync(configPath(opts), "utf8");
    expect(onDisk).not.toContain("secret-token");
    expect(JSON.parse(onDisk).sites).toEqual([{ name: "BSU", endpoint: BSU }]);
    expect(secrets.entries.get(BSU)).toBe("secret-token-1234");
  });

  it("makes the first site the default and lists a masked hint only", async () => {
    await addSite({ name: "BSU", endpoint: BSU, token: "secret-token-1234" }, opts);
    await addSite({ name: "Other", endpoint: OTHER }, opts);
    expect(await listSites(opts)).toEqual([
      { name: "BSU", endpoint: BSU, isDefault: true, tokenHint: "****1234" },
      { name: "Other", endpoint: OTHER, isDefault: false, tokenHint: null },
    ]);
  });

  it("refuses a duplicate name or a second site on the same endpoint", async () => {
    await addSite({ name: "BSU", endpoint: BSU }, opts);
    await expect(addSite({ name: "BSU", endpoint: OTHER }, opts)).rejects.toThrow(CredentialsError);
    await expect(addSite({ name: "Again", endpoint: `${BSU}/` }, opts)).rejects.toThrow(/already uses/);
  });

  it("rejects an endpoint that is not a web address", async () => {
    await expect(addSite({ name: "Bad", endpoint: "canvas" }, opts)).rejects.toThrow(/Not a valid URL/);
    expect(() => normalizeEndpoint("ftp://canvas.example.edu")).toThrow(/https/);
  });

  it("sets the default, and hands it to the next site when the default is removed", async () => {
    await addSite({ name: "BSU", endpoint: BSU, token: "t1" }, opts);
    await addSite({ name: "Other", endpoint: OTHER, token: "t2" }, opts);
    setDefaultSite("Other", opts);
    expect(defaultSite(opts)?.name).toBe("Other");

    await removeSite("Other", opts);
    expect(secrets.entries.has(OTHER)).toBe(false);
    expect(defaultSite(opts)?.name).toBe("BSU");

    await removeSite("BSU", opts);
    expect(loadSites(opts)).toEqual({ defaultSite: null, sites: [] });
  });

  it("names the missing site when asked for one that does not exist", async () => {
    expect(() => setDefaultSite("Nope", opts)).toThrow("No Canvas site named 'Nope'.");
    await expect(removeSite("Nope", opts)).rejects.toThrow(CredentialsError);
  });

  it("replaces a token", async () => {
    await addSite({ name: "BSU", endpoint: BSU, token: "old" }, opts);
    await setToken("BSU", " new-token-9999 ", opts);
    expect(secrets.entries.get(BSU)).toBe("new-token-9999");
  });

  it("masks short tokens completely", () => {
    expect(maskToken("abc")).toBe("****");
    expect(maskToken("1234~abcdefghwxyz")).toBe("****wxyz");
  });
});

describe("resolveCredentials", () => {
  it("uses the default site's keychain token", async () => {
    await addSite({ name: "BSU", endpoint: BSU, token: "t-bsu" }, opts);
    await addSite({ name: "Other", endpoint: OTHER, token: "t-other" }, opts);
    expect(await resolveCredentials(undefined, opts)).toEqual({
      endpoint: BSU,
      token: "t-bsu",
      source: "keychain",
      site: "BSU",
    });
  });

  it("uses a named site over the default", async () => {
    await addSite({ name: "BSU", endpoint: BSU, token: "t-bsu" }, opts);
    await addSite({ name: "Other", endpoint: OTHER, token: "t-other" }, opts);
    const resolved = await resolveCredentials("Other", opts);
    expect(resolved.endpoint).toBe(OTHER);
    expect(resolved.token).toBe("t-other");
  });

  it("lets CANVAS_TOKEN override the keychain, with CANVAS_ENDPOINT", async () => {
    await addSite({ name: "BSU", endpoint: BSU, token: "t-bsu" }, opts);
    const env = { CANVAS_TOKEN: "env-token", CANVAS_ENDPOINT: "https://env.example.edu/" };
    expect(await resolveCredentials(undefined, { ...opts, env })).toEqual({
      endpoint: "https://env.example.edu",
      token: "env-token",
      source: "env",
      site: null,
    });
  });

  it("pairs CANVAS_TOKEN alone with the chosen site's endpoint, else the default endpoint", async () => {
    const env = { CANVAS_TOKEN: "env-token" };
    expect((await resolveCredentials(undefined, { ...opts, env })).endpoint).toBe(BSU);
    await addSite({ name: "Other", endpoint: OTHER }, opts);
    expect((await resolveCredentials(undefined, { ...opts, env })).endpoint).toBe(OTHER);
  });

  it("uses CANVAS_ENDPOINT alone to pick the keychain token for that endpoint", async () => {
    await addSite({ name: "BSU", endpoint: BSU, token: "t-bsu" }, opts);
    await addSite({ name: "Other", endpoint: OTHER, token: "t-other" }, opts);
    const resolved = await resolveCredentials(undefined, { ...opts, env: { CANVAS_ENDPOINT: OTHER } });
    expect(resolved).toEqual({ endpoint: OTHER, token: "t-other", source: "keychain", site: "Other" });
    await expect(
      resolveCredentials(undefined, { ...opts, env: { CANVAS_ENDPOINT: "https://none.example.edu" } }),
    ).rejects.toThrow(/no token is saved/);
  });

  it("explains what to do when nothing is configured", async () => {
    await expect(resolveCredentials(undefined, opts)).rejects.toThrow(/Add one in Settings or run 'edutools init'/);
  });

  it("says which site is missing its token", async () => {
    await addSite({ name: "BSU", endpoint: BSU }, opts);
    await expect(resolveCredentials(undefined, opts)).rejects.toThrow("No token is saved for the site 'BSU'.");
  });
});

describe("importLegacyConfig", () => {
  const legacy = (body: string) => writeFileSync(path.join(dir, "config.toml"), body, "utf8");

  it("returns null when there is no old config file", async () => {
    expect(await importLegacyConfig(opts)).toBeNull();
  });

  it("returns null when the old file has no token, as edutools init left it", async () => {
    legacy('[canvas]\n# API access token (required)\ntoken = ""\n');
    expect(await importLegacyConfig(opts)).toBeNull();
    expect(loadSites(opts).sites).toEqual([]);
  });

  it("moves the token into the keychain and adds a site named after the host", async () => {
    legacy('[canvas]\ntoken = "legacy-token-5678"\n');
    const result = await importLegacyConfig(opts);
    expect(result).toEqual({
      site: { name: "boisestatecanvas.instructure.com", endpoint: BSU },
      created: true,
      path: path.join(dir, "config.toml"),
    });
    expect(secrets.entries.get(BSU)).toBe("legacy-token-5678");
    expect(defaultSite(opts)?.endpoint).toBe(BSU);
    expect(readFileSync(configPath(opts), "utf8")).not.toContain("legacy-token");
  });

  it("honours the old endpoint and updates an existing site on it", async () => {
    await addSite({ name: "Mine", endpoint: OTHER, token: "stale" }, opts);
    legacy(`[canvas]\ntoken = "fresh"\nendpoint = "${OTHER}/"\n`);
    const result = await importLegacyConfig(opts);
    expect(result?.created).toBe(false);
    expect(result?.site.name).toBe("Mine");
    expect(secrets.entries.get(OTHER)).toBe("fresh");
    expect(loadSites(opts).sites).toHaveLength(1);
  });

  it("reports a malformed file", async () => {
    legacy("[canvas\ntoken = ");
    await expect(importLegacyConfig(opts)).rejects.toThrow(/Could not read/);
  });
});

/**
 * Canvas sites and their tokens, shared by the desktop app and the CLI.
 *
 * A site is a name and an endpoint URL. The list of sites, and which one is the
 * default, lives in a small JSON file in the platform config directory. The token
 * for a site never touches that file: it lives in the OS keychain (macOS Keychain,
 * Windows Credential Manager, the Secret Service on Linux) under the service
 * `edutools` with the site's endpoint as the account name. Keying the token by
 * endpoint rather than by site name means renaming a site never orphans its token.
 *
 * `CANVAS_TOKEN` and `CANVAS_ENDPOINT` still override everything, because CI and
 * scripted use of the CLI have no keychain to read.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { DEFAULT_ENDPOINT } from "./canvas";

/** The keychain service every edutools token is stored under. */
export const KEYCHAIN_SERVICE = "edutools";

/** The name of the site list inside the config directory. */
export const CONFIG_FILENAME = "sites.json";

export class CredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialsError";
  }
}

export interface Site {
  readonly name: string;
  readonly endpoint: string;
}

/** The site list as it sits on disk. */
export interface SiteConfig {
  readonly defaultSite: string | null;
  readonly sites: readonly Site[];
}

/** A site as the app shows it: never the token, only whether one is saved and a hint. */
export interface SiteStatus extends Site {
  readonly isDefault: boolean;
  /** A masked hint such as `****abcd`, or null when no token is saved. */
  readonly tokenHint: string | null;
}

export interface ResolvedCredentials {
  readonly endpoint: string;
  readonly token: string;
  /** Where the token came from, so `check` can say which one it tested. */
  readonly source: "env" | "keychain";
  /** The site the credentials belong to, or null when they came from the environment alone. */
  readonly site: string | null;
}

/**
 * Where tokens are kept. The real one is the OS keychain; tests pass an in-memory
 * map so they never read or write a developer's actual keychain.
 */
export interface SecretStore {
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  /** Resolves true when something was deleted. */
  delete(account: string): Promise<boolean>;
}

export interface CredentialOptions {
  /** Overrides the platform config directory. */
  readonly dir?: string;
  /** Defaults to the OS keychain. */
  readonly secrets?: SecretStore;
  /** Defaults to process.env. The app passes `{}` so Settings is the only source. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Defaults to os.homedir(). */
  readonly home?: string;
  /** Defaults to process.platform. */
  readonly platform?: NodeJS.Platform;
  /** Overrides where importLegacyConfig looks for the old config.toml. */
  readonly legacyPath?: string;
}

// ============================================================================
// Locations
// ============================================================================

/**
 * The platform config directory: `~/Library/Application Support/edutools` on
 * macOS, `%APPDATA%\edutools` on Windows, and `$XDG_CONFIG_HOME/edutools` (or
 * `~/.config/edutools`) elsewhere.
 */
export function configDir(options: CredentialOptions = {}): string {
  if (options.dir) {
    return options.dir;
  }
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const platform = options.platform ?? process.platform;
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "edutools");
  }
  if (platform === "win32") {
    return path.join(env.APPDATA || path.join(home, "AppData", "Roaming"), "edutools");
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(home, ".config"), "edutools");
}

export function configPath(options: CredentialOptions = {}): string {
  return path.join(configDir(options), CONFIG_FILENAME);
}

/** The Python CLI's config file, which held the token in plain text. */
export function legacyConfigPath(options: CredentialOptions = {}): string {
  return options.legacyPath ?? path.join(options.home ?? os.homedir(), ".config", "edutools", "config.toml");
}

// ============================================================================
// Keychain
// ============================================================================

/**
 * The OS keychain via @napi-rs/keyring. The native module is loaded on first use,
 * not at import, so code paths and tests that never touch a token never load it.
 */
export function keychainStore(service: string = KEYCHAIN_SERVICE): SecretStore {
  const entry = async (account: string) => {
    const { AsyncEntry } = await import("@napi-rs/keyring");
    return new AsyncEntry(service, account);
  };
  return {
    async get(account) {
      return (await (await entry(account)).getPassword()) ?? null;
    },
    async set(account, secret) {
      await (await entry(account)).setPassword(secret);
    },
    async delete(account) {
      return (await entry(account)).deletePassword();
    },
  };
}

/** A SecretStore backed by a Map, for tests. */
export function memoryStore(initial: Record<string, string> = {}): SecretStore & { readonly entries: Map<string, string> } {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    async get(account) {
      return entries.get(account) ?? null;
    },
    async set(account, secret) {
      entries.set(account, secret);
    },
    async delete(account) {
      return entries.delete(account);
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function secretsOf(options: CredentialOptions): SecretStore {
  return options.secrets ?? keychainStore();
}

// ============================================================================
// Pure helpers
// ============================================================================

/**
 * Normalize an endpoint to `scheme://host[:port][/path]` with no trailing slash, so
 * the same Canvas typed two ways maps to one keychain entry.
 */
export function normalizeEndpoint(raw: string): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new CredentialsError(`Not a valid URL: '${trimmed}'. It should look like ${DEFAULT_ENDPOINT}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new CredentialsError(`The Canvas address must start with https:// (got '${trimmed}').`);
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${url.host}${pathname}`;
}

/** A token reduced to its last four characters, which is all the app ever shows. */
export function maskToken(token: string): string {
  const tail = token.length > 8 ? token.slice(-4) : "";
  return `****${tail}`;
}

/** A default site name for an endpoint: its host name. */
export function siteNameFor(endpoint: string): string {
  return new URL(endpoint).hostname;
}

// ============================================================================
// The site list
// ============================================================================

function isSite(value: unknown): value is Site {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  // A narrowed object from JSON.parse: reading two named fields off it to check them.
  const candidate = value as Record<string, unknown>;
  return typeof candidate.name === "string" && typeof candidate.endpoint === "string";
}

/** Read the site list. A missing file is an empty list. */
export function loadSites(options: CredentialOptions = {}): SiteConfig {
  const file = configPath(options);
  if (!existsSync(file)) {
    return { defaultSite: null, sites: [] };
  }
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new CredentialsError(`Could not read ${file}: ${messageOf(error)}`);
  }
  if (typeof data !== "object" || data === null) {
    throw new CredentialsError(`${file} is not a site list.`);
  }
  // Checked to be a non-null object just above; reading its fields to validate them.
  const record = data as Record<string, unknown>;
  const rawSites = Array.isArray(record.sites) ? record.sites : [];
  const sites = rawSites.filter(isSite).map((s) => ({ name: s.name, endpoint: s.endpoint }));
  const named = typeof record.defaultSite === "string" ? record.defaultSite : null;
  const defaultSite = sites.some((s) => s.name === named) ? named : (sites[0]?.name ?? null);
  return { defaultSite, sites };
}

/** Write the site list, through a temporary file so a crash never leaves half a file. */
export function saveSites(config: SiteConfig, options: CredentialOptions = {}): void {
  const file = configPath(options);
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  const body = { version: 1, defaultSite: config.defaultSite, sites: config.sites };
  writeFileSync(temp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  renameSync(temp, file);
}

function findSite(config: SiteConfig, name: string): Site {
  const site = config.sites.find((s) => s.name === name);
  if (!site) {
    throw new CredentialsError(`No Canvas site named '${name}'.`);
  }
  return site;
}

/** Every site with whether it is the default and a masked hint of its token. */
export async function listSites(options: CredentialOptions = {}): Promise<SiteStatus[]> {
  const config = loadSites(options);
  const secrets = secretsOf(options);
  const result: SiteStatus[] = [];
  // Sequential: the keychain may prompt the user, and one prompt at a time is enough.
  for (const site of config.sites) {
    const token = await secrets.get(site.endpoint);
    result.push({
      ...site,
      isDefault: site.name === config.defaultSite,
      tokenHint: token ? maskToken(token) : null,
    });
  }
  return result;
}

export interface NewSite {
  readonly name: string;
  readonly endpoint: string;
  /** Omitted to add a site whose token is set later. */
  readonly token?: string;
}

/**
 * Add a site and save its token in the keychain. The first site becomes the
 * default. Names and endpoints are unique: two sites on one endpoint would share
 * one keychain entry, so the second would silently replace the first's token.
 */
export async function addSite(input: NewSite, options: CredentialOptions = {}): Promise<Site> {
  const name = input.name.trim();
  if (!name) {
    throw new CredentialsError("A site needs a name.");
  }
  const endpoint = normalizeEndpoint(input.endpoint);
  const config = loadSites(options);
  if (config.sites.some((s) => s.name === name)) {
    throw new CredentialsError(`A site named '${name}' already exists.`);
  }
  const clash = config.sites.find((s) => s.endpoint === endpoint);
  if (clash) {
    throw new CredentialsError(`The site '${clash.name}' already uses ${endpoint}.`);
  }
  const token = input.token?.trim();
  if (token) {
    await secretsOf(options).set(endpoint, token);
  }
  const site: Site = { name, endpoint };
  saveSites({ defaultSite: config.defaultSite ?? name, sites: [...config.sites, site] }, options);
  return site;
}

/** Replace a site's token in the keychain. */
export async function setToken(name: string, token: string, options: CredentialOptions = {}): Promise<void> {
  const site = findSite(loadSites(options), name);
  const trimmed = token.trim();
  if (!trimmed) {
    throw new CredentialsError("The token is empty.");
  }
  await secretsOf(options).set(site.endpoint, trimmed);
}

/** Remove a site and its keychain entry. When it was the default, the next site takes over. */
export async function removeSite(name: string, options: CredentialOptions = {}): Promise<void> {
  const config = loadSites(options);
  const site = findSite(config, name);
  await secretsOf(options).delete(site.endpoint);
  const sites = config.sites.filter((s) => s.name !== name);
  const defaultSite = config.defaultSite === name ? (sites[0]?.name ?? null) : config.defaultSite;
  saveSites({ defaultSite, sites }, options);
}

export function setDefaultSite(name: string, options: CredentialOptions = {}): void {
  const config = loadSites(options);
  findSite(config, name);
  saveSites({ ...config, defaultSite: name }, options);
}

/** The default site, or null when none is configured. */
export function defaultSite(options: CredentialOptions = {}): Site | null {
  const config = loadSites(options);
  return config.sites.find((s) => s.name === config.defaultSite) ?? null;
}

// ============================================================================
// Resolution
// ============================================================================

const NOT_CONFIGURED = "No Canvas site is set up. Add one in Settings or run 'edutools init'.";

/**
 * The endpoint and token to build a CanvasLMS with.
 *
 * In order:
 * 1. `CANVAS_TOKEN` in the environment wins, with `CANVAS_ENDPOINT`, else the
 *    chosen site's endpoint, else the Boise State default.
 * 2. `CANVAS_ENDPOINT` alone picks the keychain token saved for that endpoint.
 * 3. The named site, or the default site, with its keychain token.
 */
export async function resolveCredentials(
  site?: string,
  options: CredentialOptions = {},
): Promise<ResolvedCredentials> {
  const env = options.env ?? process.env;
  const config = loadSites(options);
  const chosen = site ? findSite(config, site) : (config.sites.find((s) => s.name === config.defaultSite) ?? null);

  const envToken = env.CANVAS_TOKEN?.trim();
  const envEndpoint = env.CANVAS_ENDPOINT?.trim();
  if (envToken) {
    const endpoint = normalizeEndpoint(envEndpoint || chosen?.endpoint || DEFAULT_ENDPOINT);
    return { endpoint, token: envToken, source: "env", site: null };
  }

  const secrets = secretsOf(options);
  if (envEndpoint && !site) {
    const endpoint = normalizeEndpoint(envEndpoint);
    const token = await secrets.get(endpoint);
    if (!token) {
      throw new CredentialsError(`CANVAS_ENDPOINT is ${endpoint} but no token is saved for it. Set CANVAS_TOKEN too.`);
    }
    const owner = config.sites.find((s) => s.endpoint === endpoint);
    return { endpoint, token, source: "keychain", site: owner?.name ?? null };
  }

  if (!chosen) {
    throw new CredentialsError(NOT_CONFIGURED);
  }
  const token = await secrets.get(chosen.endpoint);
  if (!token) {
    throw new CredentialsError(`No token is saved for the site '${chosen.name}'. Add one in Settings.`);
  }
  return { endpoint: chosen.endpoint, token, source: "keychain", site: chosen.name };
}

// ============================================================================
// Moving off the old config.toml
// ============================================================================

export interface LegacyImport {
  readonly site: Site;
  /** True when a new site was added; false when an existing site's token was replaced. */
  readonly created: boolean;
  readonly path: string;
}

/**
 * Read the Python CLI's `~/.config/edutools/config.toml` `[canvas]` table and move
 * its token into the keychain. The endpoint defaults as it did there. When a site
 * already uses that endpoint its token is replaced; otherwise a site named after
 * the host is added. Returns null when there is no file or no token in it.
 *
 * The old file is left alone: the Python CLI still reads it until the port lands,
 * and deleting a plain-text token is for the user to decide.
 */
export async function importLegacyConfig(options: CredentialOptions = {}): Promise<LegacyImport | null> {
  const file = legacyConfigPath(options);
  if (!existsSync(file)) {
    return null;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(readFileSync(file, "utf8"));
  } catch (error) {
    throw new CredentialsError(`Could not read ${file}: ${messageOf(error)}`);
  }
  const canvas = parsed.canvas;
  if (typeof canvas !== "object" || canvas === null || Array.isArray(canvas)) {
    return null;
  }
  // A TOML table, checked just above to be a plain object.
  const table = canvas as Record<string, unknown>;
  const token = typeof table.token === "string" ? table.token.trim() : "";
  if (!token) {
    return null;
  }
  const endpoint = normalizeEndpoint(
    typeof table.endpoint === "string" && table.endpoint.trim() ? table.endpoint : DEFAULT_ENDPOINT,
  );

  const config = loadSites(options);
  const existing = config.sites.find((s) => s.endpoint === endpoint);
  if (existing) {
    await secretsOf(options).set(endpoint, token);
    return { site: existing, created: false, path: file };
  }
  let name = siteNameFor(endpoint);
  for (let n = 2; config.sites.some((s) => s.name === name); n++) {
    name = `${siteNameFor(endpoint)} (${n})`;
  }
  const site = await addSite({ name, endpoint, token }, options);
  return { site, created: true, path: file };
}

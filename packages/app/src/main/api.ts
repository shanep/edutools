/**
 * The main-process side of EdutoolsApi. Everything that touches the keychain or
 * Canvas happens here, never in the renderer.
 *
 * This module does not import electron, so tests build it with an in-memory secret
 * store and a fake Canvas client.
 */

import { CanvasLMS, DEFAULT_ENDPOINT } from "@edutools/core/canvas";
import {
  addSite,
  type CredentialOptions,
  configPath,
  importLegacyConfig,
  legacyConfigPath,
  listSites,
  normalizeEndpoint,
  removeSite,
  resolveCredentials,
  setDefaultSite,
  setToken,
} from "@edutools/core/credentials";
import type { Payload } from "@edutools/core/types";
import { toCourseRow } from "../shared/courses";
import type { EdutoolsApi, SiteView, TestResult } from "../shared/ipc";

/** The part of CanvasLMS the app uses so far. */
export interface CanvasClient {
  getCourses(options?: { includeAll?: boolean }): Promise<Payload[]>;
}

export interface ApiDeps {
  readonly version: string;
  readonly credentials: CredentialOptions;
  readonly canvas?: (endpoint: string, token: string) => CanvasClient;
  readonly openExternal: (url: string) => Promise<void>;
}

/** Arguments come from the renderer, so they are checked rather than trusted. */
function requireText(value: unknown, what: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${what} is required.`);
  }
  return value.trim();
}

export function createApi(deps: ApiDeps): EdutoolsApi {
  // The app ignores CANVAS_TOKEN and CANVAS_ENDPOINT: Settings is the one place a
  // designer manages credentials, and a stray variable in a launch environment
  // would make the Courses screen disagree with what Settings shows.
  const options: CredentialOptions = { env: {}, ...deps.credentials };
  const canvas = deps.canvas ?? ((endpoint, token) => new CanvasLMS({ endpoint, token }));

  const sites = async (): Promise<SiteView[]> => listSites(options);

  const test = async (endpoint: string, token: string): Promise<TestResult> => {
    const courses = await canvas(endpoint, token).getCourses();
    return { endpoint, courseCount: courses.length };
  };

  return {
    async appInfo() {
      return {
        version: deps.version,
        configPath: configPath(options),
        legacyPath: legacyConfigPath(options),
        defaultEndpoint: DEFAULT_ENDPOINT,
        platform: options.platform ?? process.platform,
      };
    },

    listSites: sites,

    async addSite(input) {
      const endpoint = normalizeEndpoint(requireText(input?.endpoint, "The Canvas address"));
      const token = requireText(input?.token, "The access token");
      const name = typeof input?.name === "string" && input.name.trim() ? input.name : new URL(endpoint).hostname;
      await addSite({ name, endpoint, token }, options);
      return sites();
    },

    async removeSite(name) {
      await removeSite(requireText(name, "The site name"), options);
      return sites();
    },

    async setDefaultSite(name) {
      setDefaultSite(requireText(name, "The site name"), options);
      return sites();
    },

    async setToken(name, token) {
      await setToken(requireText(name, "The site name"), requireText(token, "The access token"), options);
      return sites();
    },

    async testSite(name) {
      const resolved = await resolveCredentials(requireText(name, "The site name"), options);
      return test(resolved.endpoint, resolved.token);
    },

    async testConnection(input) {
      const endpoint = normalizeEndpoint(requireText(input?.endpoint, "The Canvas address"));
      return test(endpoint, requireText(input?.token, "The access token"));
    },

    async importLegacyConfig() {
      const result = await importLegacyConfig(options);
      if (!result) {
        return { imported: false, created: false, siteName: null, path: legacyConfigPath(options) };
      }
      return { imported: true, created: result.created, siteName: result.site.name, path: result.path };
    },

    async listCourses(request) {
      const resolved = await resolveCredentials(undefined, options);
      const courses = await canvas(resolved.endpoint, resolved.token).getCourses({
        includeAll: request?.includeAll === true,
      });
      return { site: resolved.site, endpoint: resolved.endpoint, courses: courses.map(toCourseRow) };
    },

    async openExternal(url) {
      // Only web links: a file: or custom-scheme URL from the renderer could launch
      // a local program.
      const parsed = new URL(requireText(url, "The link"));
      if (parsed.protocol !== "https:") {
        throw new Error(`Refusing to open ${parsed.protocol} links.`);
      }
      await deps.openExternal(parsed.toString());
    },
  };
}

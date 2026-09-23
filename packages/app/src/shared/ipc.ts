/**
 * The contract between the renderer and the main process.
 *
 * `EdutoolsApi` is the whole surface the renderer can reach, exposed on
 * `window.edutools` by the preload script. The main process implements the same
 * interface, so a method added here fails to type-check until both sides have it.
 * Every call crosses one `ipcRenderer.invoke` channel named after the method.
 *
 * This file is shared by main, preload and renderer, so it imports nothing from
 * node or from core: the renderer must type-check without node's types.
 */

import type { ScreenId } from "./screens";

/** A Canvas site as the renderer sees it. The token itself never crosses IPC. */
export interface SiteView {
  readonly name: string;
  readonly endpoint: string;
  readonly isDefault: boolean;
  /** `****abcd`, or null when no token is saved for the site. */
  readonly tokenHint: string | null;
}

export interface NewSiteInput {
  readonly name: string;
  readonly endpoint: string;
  readonly token: string;
}

export interface ConnectionInput {
  readonly endpoint: string;
  readonly token: string;
}

export interface TestResult {
  readonly endpoint: string;
  readonly courseCount: number;
}

export interface ImportResult {
  /** False when there was no old config file, or it had no token. */
  readonly imported: boolean;
  readonly created: boolean;
  readonly siteName: string | null;
  readonly path: string;
}

export interface CourseRow {
  readonly id: string;
  readonly name: string;
  readonly code: string;
  readonly term: string;
  readonly state: string;
}

export interface CourseList {
  readonly site: string | null;
  readonly endpoint: string;
  readonly courses: readonly CourseRow[];
}

export interface AppInfo {
  readonly version: string;
  readonly configPath: string;
  readonly legacyPath: string;
  readonly defaultEndpoint: string;
  readonly platform: string;
}

/** Invoked methods: each one is a request and a promised reply. */
export interface EdutoolsApi {
  appInfo(): Promise<AppInfo>;
  listSites(): Promise<SiteView[]>;
  addSite(input: NewSiteInput): Promise<SiteView[]>;
  removeSite(name: string): Promise<SiteView[]>;
  setDefaultSite(name: string): Promise<SiteView[]>;
  setToken(name: string, token: string): Promise<SiteView[]>;
  /** Tests a saved site's token by listing its courses. */
  testSite(name: string): Promise<TestResult>;
  /** Tests an endpoint and token before they are saved. */
  testConnection(input: ConnectionInput): Promise<TestResult>;
  importLegacyConfig(): Promise<ImportResult>;
  listCourses(options: { includeAll: boolean }): Promise<CourseList>;
  openExternal(url: string): Promise<void>;
}

export type ApiMethod = keyof EdutoolsApi;

/**
 * Every method name, checked for completeness by the `satisfies` clause: adding a
 * method to EdutoolsApi without listing it here is a type error, so the preload
 * can never silently lack a channel.
 */
const METHODS = {
  appInfo: true,
  listSites: true,
  addSite: true,
  removeSite: true,
  setDefaultSite: true,
  setToken: true,
  testSite: true,
  testConnection: true,
  importLegacyConfig: true,
  listCourses: true,
  openExternal: true,
} as const satisfies Record<ApiMethod, true>;

// Object.keys widens to string[]; the satisfies clause above guarantees every key is an ApiMethod.
export const API_METHODS = Object.keys(METHODS) as ApiMethod[];

export function channelOf(method: ApiMethod): string {
  return `edutools:${method}`;
}

/** Main to renderer: the application menu asked for a screen. */
export const NAVIGATE_CHANNEL = "edutools:navigate";

/**
 * What an invoke resolves to on the wire. Errors are carried as a message rather
 * than thrown, because Electron wraps a thrown error's message in
 * "Error invoking remote method ..." noise the user should not have to read.
 */
export type Reply<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

/** What the preload adds on top of the invoked methods. */
export interface EdutoolsBridge extends EdutoolsApi {
  /** Subscribe to menu navigation; returns the unsubscribe function. */
  onNavigate(listener: (screen: ScreenId) => void): () => void;
}

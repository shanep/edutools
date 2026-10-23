/**
 * The only module that talks HTTP to Google: the Drive API, and the OAuth token
 * endpoint it signs in through. It is to Google what canvas.ts is to Canvas;
 * everything else in the core stays pure, and a new Drive endpoint is a method
 * here.
 *
 * edutools asks for the `drive.file` scope, which reaches only the files and
 * folders edutools itself created. That is enough to build and update a course
 * folder, needs no Google app verification, and cannot touch anything else in
 * the account.
 */

import type { Payload } from "./types";

export const DRIVE_API = "https://www.googleapis.com/drive/v3";
export const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";

export const DOC_MIME = "application/vnd.google-apps.document";
export const FOLDER_MIME = "application/vnd.google-apps.folder";

/** The OAuth client edutools signs in as: a "Desktop app" client from Google Cloud. */
export interface GoogleClient {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** A client plus the refresh token one sign-in produced. */
export interface GoogleAuth extends GoogleClient {
  readonly refreshToken: string;
}

/** The fields of a Drive file edutools reads. */
export interface DriveFile {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  /** RFC 3339, as Drive reports it. Moves forward on any edit, in Drive or by a push. */
  readonly modifiedTime: string;
  readonly trashed: boolean;
  readonly parents: readonly string[];
  readonly webViewLink: string;
}

export interface DriveAccount {
  readonly email: string;
  readonly name: string;
}

const FILE_FIELDS = "id,name,mimeType,modifiedTime,trashed,parents,webViewLink";

const TIMEOUT_MS = 60_000;
const UPLOAD_TIMEOUT_MS = 300_000;
const RETRY_STATUS: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 5;
// Refresh a little before Google says the access token expires.
const EXPIRY_MARGIN_MS = 60_000;

/** An HTTP error from Google, with its status so a caller can tell a 404 from a failure. */
export class DriveApiError extends Error {
  readonly status: number;

  constructor(status: number, body: string) {
    super(`Google Drive API error ${status}: ${body}`);
    this.name = "DriveApiError";
    this.status = status;
  }
}

/** The sign-in is missing, revoked or expired; `edutools drive login` fixes it. */
export class GoogleAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

function jitter(): number {
  return Math.random() * 0.5;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** A Drive file payload, checked field by field. */
export function parseFile(payload: Payload): DriveFile {
  const id = text(payload.id);
  if (!id) throw new Error(`Google Drive returned a file with no id: ${JSON.stringify(payload).slice(0, 200)}`);
  return {
    id,
    name: text(payload.name),
    mimeType: text(payload.mimeType),
    modifiedTime: text(payload.modifiedTime),
    trashed: payload.trashed === true,
    parents: Array.isArray(payload.parents) ? payload.parents.filter((p): p is string => typeof p === "string") : [],
    webViewLink: text(payload.webViewLink),
  };
}

/** Drive's 403 for a quota is a throttle, the same as a 429. */
function isRateLimit(status: number, body: string): boolean {
  return status === 403 && /rateLimitExceeded|userRateLimitExceeded/.test(body);
}

async function tokenRequest(fetchImpl: typeof fetch, form: Record<string, string>): Promise<Payload> {
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await response.text();
  if (!response.ok) {
    if (body.includes("invalid_grant")) {
      throw new GoogleAuthError("The Google sign-in has expired or was revoked. Run 'edutools drive login' again.");
    }
    if (body.includes("invalid_client")) {
      throw new GoogleAuthError("Google does not recognise the OAuth client. Run 'edutools drive login --client <file>'.");
    }
    throw new DriveApiError(response.status, body);
  }
  // The token endpoint answers with a JSON object.
  return JSON.parse(body) as Payload;
}

/**
 * Trade the code from the consent page for a refresh token, the end of a
 * sign-in. Google returns a refresh token only on a consent the user just gave,
 * which is why the login URL asks for `prompt=consent`.
 */
export async function exchangeCode(
  client: GoogleClient,
  code: string,
  verifier: string,
  redirectUri: string,
  fetchImpl: typeof fetch = (input, init) => fetch(input, init),
): Promise<string> {
  const payload = await tokenRequest(fetchImpl, {
    client_id: client.clientId,
    client_secret: client.clientSecret,
    code,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });
  const refresh = text(payload.refresh_token);
  if (!refresh) throw new GoogleAuthError("Google returned no refresh token. Run 'edutools drive login' again.");
  return refresh;
}

export interface DriveOptions {
  readonly auth: GoogleAuth;
  /** Injected in tests; defaults to the global fetch. */
  readonly fetch?: typeof fetch;
  /** Injected in tests so retry backoff does not really wait. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Injected in tests; defaults to Date.now. */
  readonly now?: () => number;
}

interface RequestOptions {
  readonly json?: unknown;
  readonly body?: Uint8Array<ArrayBuffer>;
  readonly contentType?: string;
  readonly headers?: Record<string, string>;
  readonly timeoutMs?: number;
}

export class GoogleDrive {
  private readonly auth: GoogleAuth;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private accessToken = "";
  private expiresAt = 0;

  constructor(options: DriveOptions) {
    this.auth = options.auth;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.sleepImpl = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => Date.now());
  }

  /** A live access token, refreshed from the refresh token when it runs out. */
  private async token(): Promise<string> {
    if (this.accessToken && this.now() < this.expiresAt) return this.accessToken;
    const payload = await tokenRequest(this.fetchImpl, {
      client_id: this.auth.clientId,
      client_secret: this.auth.clientSecret,
      refresh_token: this.auth.refreshToken,
      grant_type: "refresh_token",
    });
    this.accessToken = text(payload.access_token);
    if (!this.accessToken) throw new GoogleAuthError("Google returned no access token. Run 'edutools drive login' again.");
    const seconds = typeof payload.expires_in === "number" ? payload.expires_in : 3600;
    this.expiresAt = this.now() + seconds * 1000 - EXPIRY_MARGIN_MS;
    return this.accessToken;
  }

  /**
   * One call with retries: backoff on a throttle or a server error, and one
   * fresh access token on a 401. Any other error status is thrown.
   */
  private async request(method: string, url: string, options: RequestOptions = {}): Promise<Response> {
    let lastError = "";
    let refreshed = false;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const headers: Record<string, string> = { Authorization: `Bearer ${await this.token()}`, ...options.headers };
      const init: RequestInit = { method, headers };
      if (options.json !== undefined) {
        headers["Content-Type"] = "application/json; charset=UTF-8";
        init.body = JSON.stringify(options.json);
      } else if (options.body !== undefined) {
        headers["Content-Type"] = options.contentType ?? "application/octet-stream";
        init.body = options.body;
      }
      let response: Response;
      try {
        response = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS) });
      } catch (error) {
        lastError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        if (attempt === MAX_ATTEMPTS) break;
        await this.sleepImpl((Math.min(2 ** attempt, 30) + jitter()) * 1000);
        continue;
      }
      if (response.ok) return response;

      const body = await response.text();
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        this.accessToken = "";
        continue;
      }
      if (!RETRY_STATUS.has(response.status) && !isRateLimit(response.status, body)) {
        throw new DriveApiError(response.status, body.slice(0, 500));
      }
      lastError = `HTTP ${response.status}: ${body.slice(0, 200)}`;
      if (attempt === MAX_ATTEMPTS) break;
      await this.sleepImpl((Math.min(2 ** attempt, 30) + jitter()) * 1000);
    }
    throw new Error(`Google Drive API error after ${MAX_ATTEMPTS} attempts (${method} ${url}): ${lastError}`);
  }

  private async file(method: string, url: string, options: RequestOptions = {}): Promise<DriveFile> {
    const response = await this.request(method, url, options);
    // A Drive file resource is a JSON object.
    return parseFile((await response.json()) as Payload);
  }

  /**
   * Send `content` in a resumable upload: one call with the metadata that
   * returns an upload URL, then the bytes. Unlike a simple or multipart upload
   * it has no 5 MB ceiling, and a course carries a 21 MB textbook PDF.
   */
  private async upload(
    method: "POST" | "PATCH",
    url: string,
    metadata: Payload,
    content: Uint8Array<ArrayBuffer>,
    contentType: string,
  ): Promise<DriveFile> {
    const start = await this.request(method, `${url}?uploadType=resumable&fields=${FILE_FIELDS}`, {
      json: metadata,
      headers: { "X-Upload-Content-Type": contentType, "X-Upload-Content-Length": String(content.byteLength) },
    });
    const location = start.headers.get("Location");
    if (!location) throw new Error(`Google Drive gave no upload URL (${method} ${url})`);
    return this.file("PUT", location, { body: content, contentType, timeoutMs: UPLOAD_TIMEOUT_MS });
  }

  /** Who the sign-in belongs to, for `drive login` to confirm. */
  async about(): Promise<DriveAccount> {
    const response = await this.request("GET", `${DRIVE_API}/about?fields=user(emailAddress,displayName)`);
    // The about resource is a JSON object; `user` is checked below.
    const payload = (await response.json()) as Payload;
    const user = typeof payload.user === "object" && payload.user !== null ? (payload.user as Payload) : {};
    return { email: text(user.emailAddress), name: text(user.displayName) };
  }

  /** A file's metadata, or null when it is gone or edutools can no longer reach it. */
  async getFile(id: string): Promise<DriveFile | null> {
    try {
      return await this.file("GET", `${DRIVE_API}/files/${encodeURIComponent(id)}?fields=${FILE_FIELDS}`);
    } catch (error) {
      if (error instanceof DriveApiError && error.status === 404) return null;
      throw error;
    }
  }

  /** A new folder, in `parent` or at the top of My Drive. */
  async createFolder(name: string, parent: string | null): Promise<DriveFile> {
    return this.file("POST", `${DRIVE_API}/files?fields=${FILE_FIELDS}`, {
      json: { name, mimeType: FOLDER_MIME, ...(parent ? { parents: [parent] } : {}) },
    });
  }

  /** A new, empty Google Doc. Its content comes later, from replaceContent. */
  async createDoc(name: string, parent: string): Promise<DriveFile> {
    return this.file("POST", `${DRIVE_API}/files?fields=${FILE_FIELDS}`, {
      json: { name, mimeType: DOC_MIME, parents: [parent] },
    });
  }

  /** A new plain file (a PDF, an image, a data file), stored as it is. */
  async uploadFile(
    name: string,
    parent: string,
    content: Uint8Array<ArrayBuffer>,
    contentType: string,
  ): Promise<DriveFile> {
    return this.upload("POST", `${DRIVE_UPLOAD_API}/files`, { name, parents: [parent] }, content, contentType);
  }

  /**
   * Replace a file's content, keeping its id and URL. HTML sent to a Google
   * Doc is converted, so the Doc's body becomes the page.
   */
  async replaceContent(id: string, content: Uint8Array<ArrayBuffer>, contentType: string): Promise<DriveFile> {
    return this.upload("PATCH", `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(id)}`, {}, content, contentType);
  }

  /** Rename a file, or move it to another folder, or both. */
  async updateMetadata(
    id: string,
    change: { readonly name?: string; readonly addParent?: string; readonly removeParents?: readonly string[] },
  ): Promise<DriveFile> {
    const params = new URLSearchParams({ fields: FILE_FIELDS });
    if (change.addParent) params.set("addParents", change.addParent);
    if (change.removeParents && change.removeParents.length > 0) params.set("removeParents", change.removeParents.join(","));
    return this.file("PATCH", `${DRIVE_API}/files/${encodeURIComponent(id)}?${params}`, {
      json: change.name === undefined ? {} : { name: change.name },
    });
  }

  /** Move a file to the trash, where it can still be restored for 30 days. */
  async trash(id: string): Promise<void> {
    await this.request("PATCH", `${DRIVE_API}/files/${encodeURIComponent(id)}?fields=id`, { json: { trashed: true } });
  }
}

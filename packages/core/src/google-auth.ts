/**
 * Signing in to Google Drive, once per machine.
 *
 * edutools signs in as an OAuth "Desktop app" client that the user creates once
 * in Google Cloud Console and hands over as the JSON file the console offers.
 * The sign-in is the installed-app flow: a one-shot server on 127.0.0.1 catches
 * the redirect from the consent page, and PKCE ties the code to this process.
 *
 * The client and the refresh token live in the OS keychain beside the Canvas
 * tokens, under their own account names. GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
 * and GOOGLE_REFRESH_TOKEN override them, for scripted use with no keychain.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { SecretStore } from "./credentials";
import { DRIVE_SCOPE, exchangeCode, type GoogleAuth, GoogleAuthError, type GoogleClient } from "./drive";

export const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";

/** Keychain account names, under the same `edutools` service as the Canvas tokens. */
export const GOOGLE_CLIENT_ACCOUNT = "google:client";
export const GOOGLE_REFRESH_ACCOUNT = "google:refresh";

// Long enough to read a consent page; short enough that a forgotten login ends.
const SIGN_IN_TIMEOUT_MS = 300_000;

/**
 * The client id and secret out of the JSON Google Cloud Console downloads for
 * an OAuth client: `{"installed": {"client_id", "client_secret", ...}}`.
 */
export function parseClientJson(raw: string): GoogleClient {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new GoogleAuthError("The OAuth client file is not JSON. Download it again from Google Cloud Console.");
  }
  if (typeof data !== "object" || data === null) throw new GoogleAuthError("The OAuth client file is not an object.");
  // Checked to be an object just above; reading its two possible wrappers.
  const record = data as Record<string, unknown>;
  const inner = record.installed ?? record.web;
  if (typeof inner !== "object" || inner === null) {
    throw new GoogleAuthError("The OAuth client file has no 'installed' section. Create a 'Desktop app' client.");
  }
  // Checked to be an object just above; reading its two string fields.
  const fields = inner as Record<string, unknown>;
  const clientId = typeof fields.client_id === "string" ? fields.client_id : "";
  const clientSecret = typeof fields.client_secret === "string" ? fields.client_secret : "";
  if (!clientId || !clientSecret) throw new GoogleAuthError("The OAuth client file has no client_id or client_secret.");
  return { clientId, clientSecret };
}

/** A PKCE verifier and its S256 challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** The consent page URL. `prompt=consent` makes Google return a refresh token every time. */
export function authUrl(client: GoogleClient, redirectUri: string, challenge: string, state: string): string {
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: DRIVE_SCOPE,
    access_type: "offline",
    prompt: "consent",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  return `${AUTH_URL}?${params}`;
}

// ============================================================================
// Keychain
// ============================================================================

export async function saveGoogleClient(client: GoogleClient, secrets: SecretStore): Promise<void> {
  await secrets.set(GOOGLE_CLIENT_ACCOUNT, JSON.stringify(client));
}

export async function saveRefreshToken(token: string, secrets: SecretStore): Promise<void> {
  await secrets.set(GOOGLE_REFRESH_ACCOUNT, token);
}

/** Forget the sign-in, and the client too with `client`. Resolves true when anything was deleted. */
export async function forgetGoogle(secrets: SecretStore, options: { client?: boolean } = {}): Promise<boolean> {
  let deleted = await secrets.delete(GOOGLE_REFRESH_ACCOUNT);
  if (options.client) deleted = (await secrets.delete(GOOGLE_CLIENT_ACCOUNT)) || deleted;
  return deleted;
}

/** The OAuth client, from the environment or the keychain, or null when there is none. */
export async function loadGoogleClient(
  secrets: SecretStore,
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<GoogleClient | null> {
  const id = env.GOOGLE_CLIENT_ID?.trim();
  const secret = env.GOOGLE_CLIENT_SECRET?.trim();
  if (id && secret) return { clientId: id, clientSecret: secret };
  const stored = await secrets.get(GOOGLE_CLIENT_ACCOUNT);
  if (!stored) return null;
  try {
    // Written by saveGoogleClient as exactly this shape.
    const parsed = JSON.parse(stored) as Partial<GoogleClient>;
    if (typeof parsed.clientId === "string" && typeof parsed.clientSecret === "string") {
      return { clientId: parsed.clientId, clientSecret: parsed.clientSecret };
    }
  } catch {
    // fall through: a damaged entry is the same as none
  }
  return null;
}

const NO_CLIENT =
  "No Google OAuth client is set up. Create a 'Desktop app' client in Google Cloud Console, " +
  "then run 'edutools drive login --client <downloaded.json>'.";

/** Everything a GoogleDrive needs, or a GoogleAuthError saying what is missing. */
export async function resolveGoogleAuth(
  secrets: SecretStore,
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<GoogleAuth> {
  const client = await loadGoogleClient(secrets, env);
  if (!client) throw new GoogleAuthError(NO_CLIENT);
  const refreshToken = env.GOOGLE_REFRESH_TOKEN?.trim() || (await secrets.get(GOOGLE_REFRESH_ACCOUNT));
  if (!refreshToken) throw new GoogleAuthError("Not signed in to Google Drive. Run 'edutools drive login'.");
  return { ...client, refreshToken };
}

// ============================================================================
// The sign-in
// ============================================================================

const DONE_PAGE =
  "<!doctype html><meta charset=utf-8><title>edutools</title>" +
  "<p style='font:1.2rem system-ui;margin:3rem'>Signed in to Google Drive. You can close this tab.</p>";

/**
 * A server on 127.0.0.1 that waits for the one redirect from the consent page.
 * `query` resolves with that redirect's query string.
 */
export async function startLoopback(timeoutMs = SIGN_IN_TIMEOUT_MS): Promise<{
  readonly redirectUri: string;
  readonly query: Promise<URLSearchParams>;
  close(): void;
}> {
  let settle: (query: URLSearchParams) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const query = new Promise<URLSearchParams>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (!url.searchParams.has("code") && !url.searchParams.has("error")) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(DONE_PAGE);
    settle(url.searchParams);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const timer = setTimeout(() => fail(new GoogleAuthError("Timed out waiting for the Google sign-in.")), timeoutMs);
  const close = () => {
    clearTimeout(timer);
    server.close();
    // A browser holds the connection open after the reply; let it go too.
    server.closeIdleConnections();
  };
  return { redirectUri: `http://127.0.0.1:${port}`, query, close };
}

/**
 * Run the whole sign-in and resolve to a refresh token. `open` is handed the
 * consent page URL; the CLI opens a browser with it and prints it as well.
 */
export async function googleSignIn(
  client: GoogleClient,
  open: (url: string) => void,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<string> {
  const loopback = await startLoopback(options.timeoutMs);
  try {
    const { verifier, challenge } = pkcePair();
    const state = randomBytes(16).toString("hex");
    open(authUrl(client, loopback.redirectUri, challenge, state));
    const query = await loopback.query;
    const error = query.get("error");
    if (error) throw new GoogleAuthError(`Google refused the sign-in: ${error}`);
    if (query.get("state") !== state) throw new GoogleAuthError("The sign-in reply did not match this request.");
    const code = query.get("code") ?? "";
    return await exchangeCode(client, code, verifier, loopback.redirectUri, options.fetch);
  } finally {
    loopback.close();
  }
}

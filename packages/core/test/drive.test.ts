/**
 * The Google Drive HTTP client over a fake fetch: token refresh, retries, the
 * resumable upload, and the 404 that means a file is gone. No network.
 */

import {
  DOC_MIME,
  DRIVE_API,
  DRIVE_UPLOAD_API,
  DriveApiError,
  exchangeCode,
  FOLDER_MIME,
  GoogleAuthError,
  GoogleDrive,
  parseFile,
  TOKEN_URL,
} from "@edutools/core/drive";
import { describe, expect, it } from "vitest";

const AUTH = { clientId: "cid", clientSecret: "csecret", refreshToken: "rtok" };

interface Call {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

type Reply = { status?: number; json?: unknown; text?: string; headers?: Record<string, string> };

function file(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, name: id, mimeType: DOC_MIME, modifiedTime: "2026-10-01T00:00:00.000Z", parents: ["p"], ...extra };
}

/**
 * A fetch that answers the token endpoint itself and every other call from
 * `replies`, in order, recording what it was sent.
 */
function fakeFetch(replies: Reply[], token: Reply = { json: { access_token: "atok", expires_in: 3600 } }) {
  const calls: Call[] = [];
  const tokenCalls: URLSearchParams[] = [];
  const respond = (reply: Reply): Response =>
    new Response(reply.text ?? JSON.stringify(reply.json ?? {}), {
      status: reply.status ?? 200,
      headers: { "Content-Type": "application/json", ...reply.headers },
    });
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const body = init?.body;
    const textBody =
      typeof body === "string" ? body : body instanceof Uint8Array ? new TextDecoder().decode(body) : "";
    if (url === TOKEN_URL) {
      tokenCalls.push(new URLSearchParams(textBody));
      return respond(token);
    }
    calls.push({ method: init?.method ?? "GET", url, headers: (init?.headers ?? {}) as Record<string, string>, body: textBody });
    const reply = replies.shift();
    if (reply === undefined) throw new Error(`unexpected call: ${init?.method} ${url}`);
    return respond(reply);
  };
  return { fetch, calls, tokenCalls };
}

function drive(fetch: typeof globalThis.fetch, now = () => 0): GoogleDrive {
  return new GoogleDrive({ auth: AUTH, fetch, sleep: async () => {}, now });
}

describe("parseFile", () => {
  it("reads the fields edutools uses and defaults the rest", () => {
    expect(parseFile({ id: "x", parents: ["a", 3] })).toEqual({
      id: "x",
      name: "",
      mimeType: "",
      modifiedTime: "",
      trashed: false,
      parents: ["a"],
      webViewLink: "",
    });
  });

  it("refuses a file with no id", () => {
    expect(() => parseFile({ name: "x" })).toThrow(/no id/);
  });
});

describe("tokens", () => {
  it("refreshes once and reuses the access token until it runs out", async () => {
    let clock = 0;
    const fake = fakeFetch([{ json: file("a") }, { json: file("a") }, { json: file("a") }]);
    const client = drive(fake.fetch, () => clock);
    await client.getFile("a");
    await client.getFile("a");
    expect(fake.tokenCalls).toHaveLength(1);
    expect(fake.tokenCalls[0]?.get("grant_type")).toBe("refresh_token");
    expect(fake.tokenCalls[0]?.get("refresh_token")).toBe("rtok");
    expect(fake.calls[0]?.headers.Authorization).toBe("Bearer atok");
    clock = 3600 * 1000;
    await client.getFile("a");
    expect(fake.tokenCalls).toHaveLength(2);
  });

  it("gets a fresh token once on a 401", async () => {
    const fake = fakeFetch([{ status: 401, text: "expired" }, { json: file("a") }]);
    expect((await drive(fake.fetch).getFile("a"))?.id).toBe("a");
    expect(fake.tokenCalls).toHaveLength(2);
  });

  it("turns a revoked refresh token into a sign-in error", async () => {
    const fake = fakeFetch([], { status: 400, text: '{"error": "invalid_grant"}' });
    await expect(drive(fake.fetch).getFile("a")).rejects.toThrow(GoogleAuthError);
  });
});

describe("requests", () => {
  it("retries a throttle and a server error", async () => {
    const fake = fakeFetch([
      { status: 429, text: "slow down" },
      { status: 403, text: '{"reason": "userRateLimitExceeded"}' },
      { status: 503, text: "busy" },
      { json: file("a") },
    ]);
    expect((await drive(fake.fetch).getFile("a"))?.id).toBe("a");
    expect(fake.calls).toHaveLength(4);
  });

  it("throws any other error with its status", async () => {
    const fake = fakeFetch([{ status: 403, text: "insufficientFilePermissions" }]);
    const error = await drive(fake.fetch)
      .createFolder("x", null)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DriveApiError);
    expect((error as DriveApiError).status).toBe(403);
  });

  it("reads a 404 as a file that is gone", async () => {
    const fake = fakeFetch([{ status: 404, text: "notFound" }]);
    expect(await drive(fake.fetch).getFile("gone")).toBeNull();
  });
});

describe("files", () => {
  it("creates a folder at the top of My Drive, or in a parent", async () => {
    const fake = fakeFetch([{ json: file("root") }, { json: file("sub") }]);
    const client = drive(fake.fetch);
    await client.createFolder("CS331", null);
    await client.createFolder("01 Week 1", "root");
    expect(fake.calls[0]?.url).toMatch(new RegExp(`^${DRIVE_API}/files\\?fields=`));
    expect(JSON.parse(fake.calls[0]?.body ?? "")).toEqual({ name: "CS331", mimeType: FOLDER_MIME });
    expect(JSON.parse(fake.calls[1]?.body ?? "")).toEqual({ name: "01 Week 1", mimeType: FOLDER_MIME, parents: ["root"] });
  });

  it("creates an empty Doc", async () => {
    const fake = fakeFetch([{ json: file("d") }]);
    await drive(fake.fetch).createDoc("00 Syllabus", "root");
    expect(JSON.parse(fake.calls[0]?.body ?? "")).toEqual({ name: "00 Syllabus", mimeType: DOC_MIME, parents: ["root"] });
  });

  it("uploads in two steps: metadata for an upload URL, then the bytes", async () => {
    const fake = fakeFetch([{ headers: { Location: "https://upload.example/session" } }, { json: file("f") }]);
    const bytes = new TextEncoder().encode("%PDF-1.7");
    await drive(fake.fetch).uploadFile("book.pdf", "files", bytes, "application/pdf");
    const [start, put] = fake.calls;
    expect(start?.method).toBe("POST");
    expect(start?.url).toMatch(new RegExp(`^${DRIVE_UPLOAD_API}/files\\?uploadType=resumable&fields=`));
    expect(start?.headers["X-Upload-Content-Type"]).toBe("application/pdf");
    expect(start?.headers["X-Upload-Content-Length"]).toBe(String(bytes.byteLength));
    expect(JSON.parse(start?.body ?? "")).toEqual({ name: "book.pdf", parents: ["files"] });
    expect(put?.method).toBe("PUT");
    expect(put?.url).toBe("https://upload.example/session");
    expect(put?.headers["Content-Type"]).toBe("application/pdf");
    expect(put?.body).toBe("%PDF-1.7");
  });

  it("replaces content on the same id", async () => {
    const fake = fakeFetch([{ headers: { Location: "https://upload.example/s2" } }, { json: file("d") }]);
    await drive(fake.fetch).replaceContent("d", new TextEncoder().encode("<p>hi</p>"), "text/html");
    expect(fake.calls[0]?.method).toBe("PATCH");
    expect(fake.calls[0]?.url).toMatch(new RegExp(`^${DRIVE_UPLOAD_API}/files/d\\?uploadType=resumable`));
    expect(fake.calls[1]?.headers["Content-Type"]).toBe("text/html");
  });

  it("moves and renames in one call", async () => {
    const fake = fakeFetch([{ json: file("d") }]);
    await drive(fake.fetch).updateMetadata("d", { name: "02 New", addParent: "b", removeParents: ["a", "c"] });
    const url = new URL(fake.calls[0]?.url ?? "");
    expect(url.searchParams.get("addParents")).toBe("b");
    expect(url.searchParams.get("removeParents")).toBe("a,c");
    expect(JSON.parse(fake.calls[0]?.body ?? "")).toEqual({ name: "02 New" });
  });

  it("trashes rather than deletes", async () => {
    const fake = fakeFetch([{ json: { id: "d" } }]);
    await drive(fake.fetch).trash("d");
    expect(JSON.parse(fake.calls[0]?.body ?? "")).toEqual({ trashed: true });
  });

  it("names the account", async () => {
    const fake = fakeFetch([{ json: { user: { emailAddress: "me@example.edu", displayName: "Me" } } }]);
    expect(await drive(fake.fetch).about()).toEqual({ email: "me@example.edu", name: "Me" });
  });
});

describe("exchangeCode", () => {
  it("sends the code and the PKCE verifier and returns the refresh token", async () => {
    const fake = fakeFetch([], { json: { access_token: "a", refresh_token: "r" } });
    const client = { clientId: "cid", clientSecret: "cs" };
    expect(await exchangeCode(client, "code", "verifier", "http://127.0.0.1:5", fake.fetch)).toBe("r");
    const form = fake.tokenCalls[0];
    expect(form?.get("grant_type")).toBe("authorization_code");
    expect(form?.get("code_verifier")).toBe("verifier");
    expect(form?.get("redirect_uri")).toBe("http://127.0.0.1:5");
  });

  it("refuses a reply with no refresh token", async () => {
    const fake = fakeFetch([], { json: { access_token: "a" } });
    await expect(exchangeCode({ clientId: "c", clientSecret: "s" }, "x", "v", "r", fake.fetch)).rejects.toThrow(
      GoogleAuthError,
    );
  });
});

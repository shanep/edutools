/**
 * Signing in to Google: the client file, the consent URL, the keychain entries
 * and the loopback server that catches the redirect.
 */

import { createHash } from "node:crypto";
import { memoryStore } from "@edutools/core/credentials";
import { DRIVE_SCOPE, GoogleAuthError } from "@edutools/core/drive";
import {
  AUTH_URL,
  authUrl,
  forgetGoogle,
  GOOGLE_CLIENT_ACCOUNT,
  googleSignIn,
  loadGoogleClient,
  parseClientJson,
  pkcePair,
  resolveGoogleAuth,
  saveGoogleClient,
  saveRefreshToken,
  startLoopback,
} from "@edutools/core/google-auth";
import { describe, expect, it } from "vitest";

const CLIENT = { clientId: "cid", clientSecret: "cs" };

describe("parseClientJson", () => {
  it("reads a Desktop app client", () => {
    expect(parseClientJson(JSON.stringify({ installed: { client_id: "a", client_secret: "b" } }))).toEqual({
      clientId: "a",
      clientSecret: "b",
    });
  });

  it.each([
    ["not json", "{"],
    ["no section", "{}"],
    ["no secret", JSON.stringify({ installed: { client_id: "a" } })],
  ])("refuses %s", (_, raw) => {
    expect(() => parseClientJson(raw)).toThrow(GoogleAuthError);
  });
});

describe("the consent URL", () => {
  it("asks for drive.file, offline, with a PKCE S256 challenge", () => {
    const { verifier, challenge } = pkcePair();
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    const url = new URL(authUrl(CLIENT, "http://127.0.0.1:9", challenge, "st"));
    expect(`${url.origin}${url.pathname}`).toBe(AUTH_URL);
    expect(url.searchParams.get("scope")).toBe(DRIVE_SCOPE);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("st");
  });
});

describe("the keychain", () => {
  it("saves, loads and forgets the client and the sign-in", async () => {
    const secrets = memoryStore();
    await expect(resolveGoogleAuth(secrets)).rejects.toThrow(/No Google OAuth client/);
    await saveGoogleClient(CLIENT, secrets);
    await expect(resolveGoogleAuth(secrets)).rejects.toThrow(/Not signed in/);
    await saveRefreshToken("r", secrets);
    expect(await resolveGoogleAuth(secrets)).toEqual({ ...CLIENT, refreshToken: "r" });
    expect(await forgetGoogle(secrets)).toBe(true);
    expect(await loadGoogleClient(secrets)).toEqual(CLIENT);
    expect(await forgetGoogle(secrets, { client: true })).toBe(true);
    expect(await loadGoogleClient(secrets)).toBeNull();
    expect(await forgetGoogle(secrets, { client: true })).toBe(false);
  });

  it("lets the environment override the keychain", async () => {
    const secrets = memoryStore();
    await saveGoogleClient(CLIENT, secrets);
    const env = { GOOGLE_CLIENT_ID: "eid", GOOGLE_CLIENT_SECRET: "es", GOOGLE_REFRESH_TOKEN: "er" };
    expect(await resolveGoogleAuth(secrets, env)).toEqual({ clientId: "eid", clientSecret: "es", refreshToken: "er" });
  });

  it("reads a damaged client entry as none", async () => {
    const secrets = memoryStore();
    await secrets.set(GOOGLE_CLIENT_ACCOUNT, "not json");
    expect(await loadGoogleClient(secrets)).toBeNull();
  });
});

describe("the sign-in", () => {
  it("catches the redirect on 127.0.0.1", async () => {
    const loopback = await startLoopback(5000);
    try {
      expect(loopback.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const response = await fetch(`${loopback.redirectUri}/?code=abc&state=s`);
      expect(response.status).toBe(200);
      expect((await loopback.query).get("code")).toBe("abc");
    } finally {
      loopback.close();
    }
  });

  it("exchanges the code when the state matches", async () => {
    const tokenFetch = async (): Promise<Response> => new Response(JSON.stringify({ refresh_token: "fresh" }));
    const token = await googleSignIn(
      CLIENT,
      (url) => {
        const params = new URL(url).searchParams;
        const back = new URL(params.get("redirect_uri") ?? "");
        back.searchParams.set("code", "c");
        back.searchParams.set("state", params.get("state") ?? "");
        void fetch(back);
      },
      { fetch: tokenFetch, timeoutMs: 5000 },
    );
    expect(token).toBe("fresh");
  });

  it("refuses a reply for another request", async () => {
    const sign = googleSignIn(
      CLIENT,
      (url) => {
        const back = new URL(new URL(url).searchParams.get("redirect_uri") ?? "");
        back.searchParams.set("code", "c");
        back.searchParams.set("state", "forged");
        void fetch(back);
      },
      { timeoutMs: 5000 },
    );
    await expect(sign).rejects.toThrow(/did not match/);
  });

  it("reports a refused consent", async () => {
    const sign = googleSignIn(
      CLIENT,
      (url) => {
        const back = new URL(new URL(url).searchParams.get("redirect_uri") ?? "");
        back.searchParams.set("error", "access_denied");
        void fetch(back);
      },
      { timeoutMs: 5000 },
    );
    await expect(sign).rejects.toThrow(/access_denied/);
  });
});

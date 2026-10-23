/**
 * Picking the Google Drive folder a course goes in.
 *
 * edutools signs in with the drive.file scope, so it cannot see a folder it did
 * not make. Google's folder picker is the way around that: the user picks a
 * folder in the browser, and Drive gives edutools access to that one folder.
 *
 * The picker is a script that runs in a web page, so a one-shot server on
 * 127.0.0.1 serves a page that opens it, then waits for the page to report the
 * pick. The page carries a live access token, so it sits at a random path that
 * only the URL handed to the browser knows.
 */

import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { FOLDER_MIME, GoogleAuthError } from "./drive";

export interface PickedFolder {
  readonly id: string;
  readonly name: string;
}

// Long enough to find a folder in a big Drive; short enough that a forgotten tab ends.
const PICK_TIMEOUT_MS = 300_000;

/**
 * The Cloud project number the picker wants as its app id. A Desktop client id
 * starts with it: `233981438443-8r77....apps.googleusercontent.com`.
 */
export function projectNumber(clientId: string): string {
  return clientId.split("-")[0] ?? "";
}

/** A JSON value safe to drop into a <script> element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

/** The page that opens the picker and reports the pick back to `base`. */
export function pickerPage(token: string, appId: string, base: string): string {
  const config = scriptJson({ token, appId, base, folder: FOLDER_MIME });
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>edutools: pick a Google Drive folder</title>
<style>body { font: 1.2rem/1.5 system-ui, sans-serif; margin: 3rem; max-width: 40rem; color: #111; }</style>
<h1>Pick a Google Drive folder</h1>
<p id="status" role="status">Opening the Google Drive folder picker.</p>
<script>
const config = ${config};
function finish(path, message) {
  fetch(config.base + path).finally(() => {
    document.getElementById("status").textContent = message;
  });
}
function show() {
  const view = new google.picker.DocsView(google.picker.ViewId.FOLDERS)
    .setIncludeFolders(true)
    .setSelectFolderEnabled(true)
    .setMimeTypes(config.folder);
  new google.picker.PickerBuilder()
    .addView(view)
    .enableFeature(google.picker.Feature.SUPPORT_DRIVES)
    .setOAuthToken(config.token)
    .setAppId(config.appId)
    .setTitle("Pick the folder the course folder goes in")
    .setCallback((data) => {
      if (data.action === google.picker.Action.PICKED) {
        const folder = data.docs[0];
        const query = new URLSearchParams({ id: folder.id, name: folder.name });
        finish("/picked?" + query, "Picked " + folder.name + ". You can close this tab.");
      } else if (data.action === google.picker.Action.CANCEL) {
        finish("/cancel", "No folder picked. You can close this tab.");
      }
    })
    .build()
    .setVisible(true);
}
</script>
<script src="https://apis.google.com/js/api.js" onload="gapi.load('picker', show)"></script>
</html>
`;
}

/**
 * Open the picker and resolve to the folder picked, or null when the user
 * cancels. `open` is handed the page URL; the CLI opens a browser with it and
 * prints it as well.
 */
export async function pickFolder(
  token: string,
  appId: string,
  open: (url: string) => void,
  options: { timeoutMs?: number } = {},
): Promise<PickedFolder | null> {
  const secret = `/${randomBytes(16).toString("hex")}`;
  let settle: (folder: PickedFolder | null) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const picked = new Promise<PickedFolder | null>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  let base = "";
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === secret) {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(pickerPage(token, appId, base));
      return;
    }
    const id = url.searchParams.get("id") ?? "";
    if (url.pathname === `${secret}/picked` && id) {
      response.writeHead(204).end();
      settle({ id, name: url.searchParams.get("name") ?? "" });
      return;
    }
    if (url.pathname === `${secret}/cancel`) {
      response.writeHead(204).end();
      settle(null);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  base = `http://127.0.0.1:${port}${secret}`;
  const timer = setTimeout(
    () => fail(new GoogleAuthError("Timed out waiting for a folder to be picked.")),
    options.timeoutMs ?? PICK_TIMEOUT_MS,
  );
  try {
    open(base);
    return await picked;
  } finally {
    clearTimeout(timer);
    server.close();
    // A browser holds the connection open after the reply; let it go too.
    server.closeIdleConnections();
  }
}

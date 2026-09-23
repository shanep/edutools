/**
 * EDUTOOLS_SCREENSHOTS=<dir> walks the screens the way the smoke test does, with
 * the same fake Canvas, throwaway config and in-memory token store, and saves a
 * PNG of each into <dir>. It is how the images in docs/designer-guide.md are made,
 * so they never show a real course or touch the owner's keychain.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { app, type BrowserWindow } from "electron";
import { click, has, waitFor } from "./smoke";

/** Wide enough to read, small enough for a README. */
const MAX_WIDTH = 1400;

async function settle(): Promise<void> {
  // One more paint after the last state change, so the capture is not a frame early.
  await new Promise((resolve) => setTimeout(resolve, 400));
}

async function scrollTo(window: BrowserWindow, selector: string): Promise<void> {
  await window.webContents.executeJavaScript(
    `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "start" })`,
  );
}

/** Type into a React-controlled input: its value setter, then the event React listens for. */
async function type(window: BrowserWindow, selector: string, text: string): Promise<void> {
  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(input, ${JSON.stringify(text)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
}

async function shoot(window: BrowserWindow, dir: string, name: string): Promise<void> {
  await settle();
  let image = await window.webContents.capturePage();
  const { width } = image.getSize();
  if (width > MAX_WIDTH) {
    image = image.resize({ width: MAX_WIDTH, quality: "best" });
  }
  writeFileSync(path.join(dir, `${name}.png`), image.toPNG());
  console.log(`wrote ${name}.png`);
}

async function screen(window: BrowserWindow, id: string): Promise<void> {
  await click(window, `.nav-item[data-screen="${id}"]`);
  await window.webContents.executeJavaScript(`document.querySelector(".content")?.scrollTo(0, 0)`);
}

export async function captureScreens(window: BrowserWindow, dir: string): Promise<void> {
  try {
    mkdirSync(dir, { recursive: true });
    await new Promise<void>((resolve) => window.webContents.once("did-finish-load", () => resolve()));
    window.setContentSize(1100, 760);
    await waitFor(window, "document.querySelector('.window .sidebar')", "the app to render");

    await screen(window, "settings");
    await waitFor(window, has(".grid td", "smoke-test.invalid"), "the site list");
    await click(window, 'input[name="site"]');
    await shoot(window, dir, "settings");

    await screen(window, "courses");
    await waitFor(window, has(".grid td", "Smoke Test Course"), "the course list");
    await shoot(window, dir, "courses");

    await screen(window, "overview");
    await waitFor(window, has("#panel-assignments td", "Smoke Assignment"), "the Assignments tab");
    await shoot(window, dir, "overview");

    await screen(window, "snapshot");
    await click(window, "button.start-snapshot");
    await waitFor(window, "document.querySelector('.snapshot-summary')", "the snapshot to finish");
    await shoot(window, dir, "snapshot");
    await scrollTo(window, ".snapshot-summary");
    await shoot(window, dir, "snapshot-result");

    await screen(window, "outline");
    await waitFor(window, has(".outline-table td", "Lab 1: Hello"), "the Outline screen");
    await shoot(window, dir, "outline");

    await screen(window, "dates");
    await waitFor(window, has(".dates-table td", "Lab 1: Hello"), "the Dates screen");
    await shoot(window, dir, "dates");
    await type(window, "#shift-days", "7");
    await click(window, 'form.toolbar button[type="submit"]');
    await waitFor(window, has(".message.warn", "shifted by +7 days"), "the shifted preview");
    await shoot(window, dir, "dates-shifted");

    await screen(window, "publish");
    await waitFor(window, "document.querySelector('button.preview-push')", "the Publish screen");
    await shoot(window, dir, "publish-options");
    await click(window, "button.preview-push");
    await waitFor(window, has(".preview-summary", "Preview finished"), "the preview result");
    await scrollTo(window, ".preview-summary");
    await shoot(window, dir, "publish-preview");

    await screen(window, "verify");
    await waitFor(window, "document.querySelector('button.run-verify')", "the Verify screen");
    await shoot(window, dir, "verify");

    await screen(window, "audit");
    await waitFor(window, "document.querySelector('button.run-audit')", "the Audit screen");
    await shoot(window, dir, "audit");

    await screen(window, "edit");
    await waitFor(window, has(".object-list td", "Smoke Page"), "the Edit object list");
    await click(window, ".object-list tbody tr");
    await waitFor(window, "document.querySelector('.visible-guard')", "the published guard");
    await shoot(window, dir, "edit-object");

    app.exit(0);
  } catch (error) {
    console.error(`SCREENSHOTS FAIL: ${error instanceof Error ? error.message : String(error)}`);
    app.exit(1);
  }
}

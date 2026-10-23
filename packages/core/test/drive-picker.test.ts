/**
 * Google's folder picker: the page on 127.0.0.1 that runs it, and the server
 * that waits for the pick. The browser is a plain fetch; Google is not called.
 */

import { pickerPage, pickFolder, projectNumber } from "@edutools/core/drive-picker";
import { describe, expect, it } from "vitest";

describe("the picker page", () => {
  it("takes the project number from the client id", () => {
    expect(projectNumber("233981438443-8r77.apps.googleusercontent.com")).toBe("233981438443");
  });

  it("carries the token and app id, safe inside a script", () => {
    const page = pickerPage("tok</script>", "1234", "http://127.0.0.1:1/x");
    expect(page).toContain('"appId":"1234"');
    expect(page).toContain("tok\\u003c/script>");
    expect(page).not.toContain("tok</script>");
    expect(page).toContain("setSelectFolderEnabled(true)");
  });
});

describe("pickFolder", () => {
  /** Run the picker with a "browser" that loads the page, then follows `then`. */
  async function pick(then: (base: string) => Promise<void>) {
    let page = "";
    const result = pickFolder(
      "tok",
      "1234",
      (base) => {
        void (async () => {
          page = await (await fetch(base)).text();
          await then(base);
        })();
      },
      { timeoutMs: 5000 },
    );
    return { folder: await result, page };
  }

  it("serves the page at a secret path and resolves to the folder picked", async () => {
    const { folder, page } = await pick(async (base) => {
      expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/);
      expect((await fetch(`${new URL(base).origin}/`)).status).toBe(404);
      expect((await fetch(`${base}/picked?id=f1&name=eCampus`)).status).toBe(204);
    });
    expect(folder).toEqual({ id: "f1", name: "eCampus" });
    expect(page).toContain('"token":"tok"');
  });

  it("resolves to null when the picker is cancelled", async () => {
    const { folder } = await pick(async (base) => {
      await fetch(`${base}/cancel`);
    });
    expect(folder).toBeNull();
  });

  it("gives up after the timeout", async () => {
    await expect(pickFolder("tok", "1234", () => {}, { timeoutMs: 20 })).rejects.toThrow(/Timed out/);
  });
});

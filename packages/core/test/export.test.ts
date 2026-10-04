/**
 * The content export: the fields that start one, the wait for Canvas to build
 * it, and the download. The client is a plain object of mocks and the clock is
 * fake, so nothing here waits or needs a token.
 */

import type { CanvasLMS } from "@edutools/core/canvas";
import { defaultName, ExportError, exportCourse, exportFields } from "@edutools/core/export";
import type { Payload } from "@edutools/core/types";
import { describe, expect, it, vi } from "vitest";

/** A client whose export reports each of `states` in turn, then finishes. */
function fakeCanvas(states: readonly Payload[]) {
  let polls = 0;
  return {
    startContentExport: vi.fn<CanvasLMS["startContentExport"]>(async () => ({ id: 5, workflow_state: "created" })),
    getContentExport: vi.fn<CanvasLMS["getContentExport"]>(async () => {
      const state = states[Math.min(polls, states.length - 1)] ?? {};
      polls += 1;
      return { id: 5, ...state };
    }),
    downloadAttachment: vi.fn<CanvasLMS["downloadAttachment"]>(async () => 2048),
  };
}

const READY: Payload = { workflow_state: "exported", attachment: { url: "https://c.test/files/9/download?verifier=v" } };
const noSleep = async (): Promise<void> => {};

describe("exportFields", () => {
  it("asks for the type without an email, and repeats the quiz selection", () => {
    expect(exportFields("qti", ["1", "2"])).toEqual([
      ["export_type", "qti"],
      ["skip_notifications", "true"],
      ["select[quizzes][]", "1"],
      ["select[quizzes][]", "2"],
    ]);
  });

  it("refuses a type Canvas does not build", () => {
    expect(() => exportFields("pdf")).toThrow(ExportError);
  });

  it("refuses quizzes in a zip export, which would export every file instead", () => {
    expect(() => exportFields("zip", ["1"])).toThrow(/only course files/);
    expect(exportFields("zip")).toEqual([
      ["export_type", "zip"],
      ["skip_notifications", "true"],
    ]);
  });
});

describe("defaultName", () => {
  it("uses the extension Canvas gives each package", () => {
    expect(defaultName("42", "qti")).toBe("canvas-42-qti.zip");
    expect(defaultName("42", "common_cartridge")).toBe("canvas-42-common_cartridge.imscc");
  });
});

describe("exportCourse", () => {
  it("waits until Canvas has built the package, then downloads it", async () => {
    const canvas = fakeCanvas([{ workflow_state: "exporting" }, READY]);
    const sleep = vi.fn(noSleep);
    const result = await exportCourse(canvas, "42", "/tmp/x.zip", { type: "qti", quizzes: ["7"], sleep });

    expect(canvas.startContentExport).toHaveBeenCalledWith("42", [
      ["export_type", "qti"],
      ["skip_notifications", "true"],
      ["select[quizzes][]", "7"],
    ]);
    expect(canvas.getContentExport).toHaveBeenCalledTimes(2);
    expect(canvas.getContentExport.mock.calls[0]).toEqual(["42", "5"]);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(canvas.downloadAttachment).toHaveBeenCalledWith("https://c.test/files/9/download?verifier=v", "/tmp/x.zip");
    expect(result).toEqual({ path: "/tmp/x.zip", bytes: 2048, export: { id: 5, ...READY } });
  });

  it("says so when Canvas fails to build it, and downloads nothing", async () => {
    const canvas = fakeCanvas([{ workflow_state: "failed" }]);
    await expect(exportCourse(canvas, "42", "/tmp/x.zip", { type: "qti", sleep: noSleep })).rejects.toThrow(
      /could not build export 5/,
    );
    expect(canvas.downloadAttachment).not.toHaveBeenCalled();
  });

  it("gives up when the wait runs out", async () => {
    const canvas = fakeCanvas([{ workflow_state: "exporting" }]);
    let clock = 0;
    const sleep = async (ms: number): Promise<void> => {
      clock += ms;
    };
    await expect(
      exportCourse(canvas, "42", "/tmp/x.zip", { type: "qti", sleep, now: () => clock, pollMs: 1000, timeoutMs: 5000 }),
    ).rejects.toThrow(/still exporting when the wait ran out/);
    expect(canvas.getContentExport).toHaveBeenCalledTimes(5);
  });

  it("refuses a finished export with no file", async () => {
    const canvas = fakeCanvas([{ workflow_state: "exported" }]);
    await expect(exportCourse(canvas, "42", "/tmp/x.zip", { type: "qti", sleep: noSleep })).rejects.toThrow(
      /no file to download/,
    );
  });

  it("checks the request before starting anything", async () => {
    const canvas = fakeCanvas([READY]);
    await expect(exportCourse(canvas, "42", "/tmp/x.zip", { type: "zip", quizzes: ["1"] })).rejects.toThrow(
      ExportError,
    );
    expect(canvas.startContentExport).not.toHaveBeenCalled();
  });
});

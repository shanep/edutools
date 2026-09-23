import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  EVENT_GUARDS,
  EVENT_NAMES,
  type EventSink,
  eventChannelOf,
  type SnapshotProgress,
  sendEvent,
  subscribe,
} from "../src/shared/ipc";
import type { ScreenId } from "../src/shared/screens";

/** ipcRenderer and webContents joined by an emitter, as Electron joins them across processes. */
function wire() {
  const emitter = new EventEmitter();
  const sink: EventSink = { send: (channel, payload) => void emitter.emit(channel, { sender: null }, payload) };
  return { emitter, sink };
}

describe("the event channel", () => {
  it("delivers a typed payload from main to a subscriber", () => {
    const { emitter, sink } = wire();
    const got: SnapshotProgress[] = [];
    subscribe(emitter, "snapshotProgress", (p) => got.push(p));
    sendEvent(sink, "snapshotProgress", { courseId: "20", message: "Reading pages" });
    expect(got).toEqual([{ courseId: "20", message: "Reading pages" }]);
  });

  it("keeps each event on its own channel", () => {
    const { emitter, sink } = wire();
    const screens: ScreenId[] = [];
    const progress: SnapshotProgress[] = [];
    subscribe(emitter, "navigate", (s) => screens.push(s));
    subscribe(emitter, "snapshotProgress", (p) => progress.push(p));
    sendEvent(sink, "navigate", "snapshot");
    expect(screens).toEqual(["snapshot"]);
    expect(progress).toEqual([]);
    expect(eventChannelOf("navigate")).not.toBe(eventChannelOf("snapshotProgress"));
  });

  it("drops a payload that fails its check", () => {
    const { emitter } = wire();
    const got: unknown[] = [];
    subscribe(emitter, "snapshotProgress", (p) => got.push(p));
    subscribe(emitter, "navigate", (p) => got.push(p));
    emitter.emit(eventChannelOf("snapshotProgress"), {}, { courseId: 20, message: "x" });
    emitter.emit(eventChannelOf("snapshotProgress"), {}, null);
    emitter.emit(eventChannelOf("navigate"), {}, "nowhere");
    expect(got).toEqual([]);
  });

  it("stops delivering once unsubscribed", () => {
    const { emitter, sink } = wire();
    const got: SnapshotProgress[] = [];
    const stop = subscribe(emitter, "snapshotProgress", (p) => got.push(p));
    stop();
    sendEvent(sink, "snapshotProgress", { courseId: "20", message: "late" });
    expect(got).toEqual([]);
    expect(emitter.listenerCount(eventChannelOf("snapshotProgress"))).toBe(0);
  });

  it("has a check for every event", () => {
    expect(new Set(EVENT_NAMES)).toEqual(new Set(["navigate", "snapshotProgress"]));
    for (const name of EVENT_NAMES) {
      expect(typeof EVENT_GUARDS[name]).toBe("function");
    }
  });
});

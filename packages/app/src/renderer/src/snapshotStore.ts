/**
 * The state of the snapshot run, kept outside any component. A pull can take
 * minutes, and the designer may look at another screen meanwhile: when they come
 * back, the Snapshot screen shows the same run, its log and its result, and
 * still knows Start must stay disabled.
 */

import { useSyncExternalStore } from "react";
import type { SnapshotRequest, SnapshotSummary } from "../../shared/ipc";

export interface SnapshotState {
  readonly running: boolean;
  readonly courseId: string | null;
  readonly log: readonly string[];
  readonly summary: SnapshotSummary | null;
  /** Set when the pull could not run at all, as opposed to problems within it. */
  readonly error: string | null;
}

// A course with thousands of files logs a line per file; the oldest go first.
const MAX_LOG = 2000;

let state: SnapshotState = { running: false, courseId: null, log: [], summary: null, error: null };
const listeners = new Set<() => void>();
let listening = false;

function update(change: Partial<SnapshotState>): void {
  state = { ...state, ...change };
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSnapshotState(): SnapshotState {
  return useSyncExternalStore(subscribe, () => state);
}

function listenForProgress(): void {
  if (listening) {
    return;
  }
  listening = true;
  // Progress events and the startSnapshot reply travel separately, and the reply
  // can arrive first. Matching on the run's course rather than on `running` keeps
  // the last lines of a finished run; the next run's start clears the log.
  window.edutools.on("snapshotProgress", (progress) => {
    if (progress.courseId === state.courseId) {
      update({ log: [...state.log, progress.message].slice(-MAX_LOG) });
    }
  });
}

/** Start a pull. The main process refuses a second one; this avoids asking. */
export async function startSnapshot(request: SnapshotRequest): Promise<void> {
  if (state.running) {
    return;
  }
  listenForProgress();
  update({ running: true, courseId: request.courseId, log: [], summary: null, error: null });
  try {
    update({ summary: await window.edutools.startSnapshot(request) });
  } catch (error) {
    update({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    update({ running: false });
  }
}

/**
 * Publish, Verify and Audit runs, kept outside any component so a designer can
 * look at another screen while a push runs and come back to its log and result.
 * The main process allows one Canvas job at a time; this store only mirrors
 * that so buttons can be disabled rather than refused.
 */

import { useSyncExternalStore } from "react";
import type { AuditSummary, CleanPlanView, CourseJob, PushSummary, VerifySummary } from "../../shared/ipc";

export interface JobResults {
  preview: PushSummary;
  push: PushSummary;
  cleanPlan: CleanPlanView;
  clean: PushSummary;
  verify: VerifySummary;
  audit: AuditSummary;
}

export type JobKey = keyof JobResults;

/** Which progress events belong to which run. */
const EVENT_JOB: Readonly<Record<JobKey, CourseJob>> = {
  preview: "push",
  push: "push",
  cleanPlan: "clean",
  clean: "clean",
  verify: "verify",
  audit: "audit",
};

export interface LogLine {
  readonly text: string;
  readonly dim: boolean;
}

export interface Stored<K extends JobKey> {
  readonly courseId: string;
  readonly value: JobResults[K];
  /** What the run was asked, so a later screen can tell whether it still applies. */
  readonly options: string;
}

export interface JobState {
  readonly running: JobKey | null;
  /** The job the log belongs to, kept after it finishes. */
  readonly last: JobKey | null;
  readonly courseId: string | null;
  readonly log: readonly LogLine[];
  /** The latest progress line, replaced as the run moves on. */
  readonly progress: string | null;
  readonly results: { readonly [K in JobKey]?: Stored<K> };
  readonly errors: { readonly [K in JobKey]?: { readonly courseId: string; readonly message: string } };
}

const MAX_LOG = 2000;

let state: JobState = { running: null, last: null, courseId: null, log: [], progress: null, results: {}, errors: {} };
const listeners = new Set<() => void>();
let listening = false;

function update(change: Partial<JobState>): void {
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

export function useJobs(): JobState {
  return useSyncExternalStore(subscribe, () => state);
}

function listen(): void {
  if (listening) {
    return;
  }
  listening = true;
  window.edutools.on("jobProgress", (event) => {
    if (state.running === null || EVENT_JOB[state.running] !== event.job || event.courseId !== state.courseId) {
      return;
    }
    if (event.kind === "report") {
      update({ log: [...state.log, { text: event.message, dim: event.dim }].slice(-MAX_LOG) });
    } else {
      const count = event.total !== null ? ` (${event.done ?? 0} of ${event.total})` : "";
      update({ progress: `${event.message}${count}` });
    }
  });
}

/** Forget a result, as when the options it was computed for have changed. */
export function clearResult(key: JobKey): void {
  const { [key]: _gone, ...results } = state.results;
  update({ results });
}

/**
 * Run one job and keep its result. Resolves true when it succeeded. Nothing
 * starts while another job from this store is running.
 */
export async function runJob<K extends JobKey>(
  key: K,
  courseId: string,
  options: string,
  call: () => Promise<JobResults[K]>,
): Promise<boolean> {
  if (state.running !== null) {
    return false;
  }
  listen();
  const { [key]: _oldError, ...errors } = state.errors;
  update({ running: key, last: key, courseId, log: [], progress: null, errors });
  try {
    const value = await call();
    const stored: Stored<K> = { courseId, value, options };
    update({ results: { ...state.results, [key]: stored } });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    update({ errors: { ...state.errors, [key]: { courseId, message } } });
    return false;
  } finally {
    update({ running: null, progress: null });
  }
}

/** A stored result for this course, or null. */
export function resultFor<K extends JobKey>(jobs: JobState, key: K, courseId: string): Stored<K> | null {
  // The mapped type loses the link between K and its entry; results[key] is Stored<K> by construction in runJob.
  const stored = jobs.results[key] as Stored<K> | undefined;
  return stored && stored.courseId === courseId ? stored : null;
}

export function errorFor(jobs: JobState, key: JobKey, courseId: string): string | null {
  const error = jobs.errors[key];
  return error && error.courseId === courseId ? error.message : null;
}

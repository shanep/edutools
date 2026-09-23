/**
 * SEED ONLY: the contract the rest of the port codes against. The canvas port
 * replaces this whole file with the full port of src/edutools/canvas.py, keeping
 * every signature here.
 */

import type { Payload } from "./types";

export const DEFAULT_ENDPOINT = "https://boisestatecanvas.instructure.com";

export interface CanvasOptions {
  /** Defaults to process.env.CANVAS_TOKEN; a missing token throws. */
  token?: string;
  /** Defaults to process.env.CANVAS_ENDPOINT, then DEFAULT_ENDPOINT. */
  endpoint?: string;
  /** Injected in tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Injected in tests so retry backoff does not really wait. */
  sleep?: (ms: number) => Promise<void>;
}

export class CanvasLMS {
  readonly endpoint: string;
  protected readonly token: string;

  constructor(options: CanvasOptions = {}) {
    const token = options.token ?? process.env.CANVAS_TOKEN;
    if (!token) {
      throw new Error("CANVAS_TOKEN not set. Add a Canvas token in Settings or run 'edutools init'.");
    }
    this.token = token;
    this.endpoint = options.endpoint ?? process.env.CANVAS_ENDPOINT ?? DEFAULT_ENDPOINT;
  }

  async getCourses(_options: { includeAll?: boolean } = {}): Promise<Payload[]> {
    throw new Error("not ported yet");
  }

  async getJson(_urlPath: string, _params?: Record<string, string | number>): Promise<Payload> {
    throw new Error("not ported yet");
  }
}

import type { EdutoolsBridge } from "../../shared/ipc";

declare global {
  interface Window {
    /** Exposed by the preload script; the page's only way to reach the main process. */
    readonly edutools: EdutoolsBridge;
  }
}

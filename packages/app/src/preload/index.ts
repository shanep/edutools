/**
 * The bridge between the sandboxed page and the main process. It exposes exactly
 * EdutoolsBridge on `window.edutools` and nothing of ipcRenderer itself, so the
 * page can call the listed methods, hear the listed events, and nothing else.
 */

import { contextBridge, ipcRenderer } from "electron";
import {
  API_METHODS,
  type ApiMethod,
  channelOf,
  type EdutoolsApi,
  type EdutoolsBridge,
  type Reply,
  subscribe,
} from "../shared/ipc";

async function invoke(method: ApiMethod, args: unknown[]): Promise<unknown> {
  // The main process registers every channel with a handler returning Reply (see
  // main/ipc.ts); invoke is typed as any, so this names what actually comes back.
  const reply = (await ipcRenderer.invoke(channelOf(method), ...args)) as Reply<unknown>;
  if (!reply.ok) {
    throw new Error(reply.error);
  }
  return reply.value;
}

const methods: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
for (const method of API_METHODS) {
  methods[method] = (...args: unknown[]) => invoke(method, args);
}

const bridge: EdutoolsBridge = {
  // API_METHODS lists every EdutoolsApi method (enforced in shared/ipc.ts), and
  // each entry forwards to the main-process method of the same name.
  ...(methods as unknown as EdutoolsApi),
  // subscribe checks each payload against EVENT_GUARDS, so the page only ever
  // receives what EdutoolsEvents says, and only on the event channels.
  on: (event, listener) => subscribe(ipcRenderer, event, listener),
};

contextBridge.exposeInMainWorld("edutools", bridge);

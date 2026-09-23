import { type IpcMainInvokeEvent, ipcMain } from "electron";
import { API_METHODS, channelOf, type EdutoolsApi, type Reply } from "../shared/ipc";

/**
 * Only our own page may call in. A navigation to anything else is already blocked
 * in index.ts; this is the second lock on the same door.
 */
function trusted(event: IpcMainInvokeEvent, allowedOrigins: readonly string[]): boolean {
  const url = event.senderFrame?.url ?? "";
  return url.startsWith("file://") || allowedOrigins.some((origin) => url.startsWith(origin));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Register one invoke handler per EdutoolsApi method. */
export function registerApi(api: EdutoolsApi, allowedOrigins: readonly string[] = []): void {
  for (const method of API_METHODS) {
    ipcMain.handle(channelOf(method), async (event, ...args: unknown[]): Promise<Reply<unknown>> => {
      if (!trusted(event, allowedOrigins)) {
        return { ok: false, error: "Blocked a call from an untrusted page." };
      }
      try {
        // The arguments arrive untyped over IPC. Each method checks what it uses
        // (see requireText in api.ts), so passing them through is safe; the cast
        // only restores the call signature that the method table lost.
        const call = api[method] as (...a: unknown[]) => Promise<unknown>;
        return { ok: true, value: await call(...args) };
      } catch (error) {
        return { ok: false, error: messageOf(error) };
      }
    });
  }
}

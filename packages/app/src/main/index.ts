import path from "node:path";
import { keychainStore } from "@edutools/core/credentials";
import { app, BrowserWindow, Menu, shell } from "electron";
import { createApi } from "./api";
import { registerApi } from "./ipc";
import { buildMenu } from "./menu";

// electron-vite sets this in `dev` so the renderer is served with hot reload.
const devServer = process.env.ELECTRON_RENDERER_URL;
const here = import.meta.dirname;

app.setName("edutools");
app.setAboutPanelOptions({ applicationName: "edutools", applicationVersion: app.getVersion() });
// Electron's own data (caches, local storage) lives in a subfolder, so the
// edutools config directory holds only our site list and stays readable.
app.setPath("userData", path.join(app.getPath("appData"), "edutools", "app-data"));

let mainWindow: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 760,
    minHeight: 480,
    title: "edutools",
    show: false,
    webPreferences: {
      preload: path.join(here, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  // The page is ours alone: links open in the user's browser, and the window
  // itself never navigates anywhere else.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!(devServer && url.startsWith(devServer))) {
      event.preventDefault();
    }
  });

  if (devServer) {
    void window.loadURL(devServer);
  } else {
    void window.loadFile(path.join(here, "../renderer/index.html"));
  }
  return window;
}

/**
 * EDUTOOLS_SMOKE_TEST=1 opens the window, checks that the bridge reached the page
 * and that the native keychain module loads, prints the outcome and quits. CI and
 * a packaged-build check run it; a user never sees it.
 */
async function smokeTest(window: BrowserWindow): Promise<void> {
  const timer = setTimeout(() => {
    console.error("SMOKE FAIL: timed out");
    app.exit(2);
  }, 30_000);
  try {
    await new Promise<void>((resolve) => window.webContents.once("did-finish-load", () => resolve()));
    const bridge: unknown = await window.webContents.executeJavaScript(
      "typeof window.edutools === 'object' && typeof window.edutools.listSites === 'function' && typeof require === 'undefined'",
    );
    if (bridge !== true) {
      throw new Error("the preload bridge is missing, or node leaked into the page");
    }
    let rendered = false;
    for (let attempt = 0; attempt < 50 && !rendered; attempt++) {
      rendered = (await window.webContents.executeJavaScript("!!document.querySelector('.window .sidebar')")) === true;
      if (!rendered) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (!rendered) {
      throw new Error("the page loaded but the app did not render");
    }
    // A read of an account that does not exist: loads the native module and asks
    // the keychain without writing anything.
    await keychainStore("edutools-smoke-test").get("https://smoke-test.invalid");
    console.log("SMOKE OK");
    clearTimeout(timer);
    app.exit(0);
  } catch (error) {
    console.error(`SMOKE FAIL: ${error instanceof Error ? error.message : String(error)}`);
    app.exit(1);
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    registerApi(
      createApi({
        version: app.getVersion(),
        credentials: {},
        openExternal: (url) => shell.openExternal(url),
      }),
      devServer ? [devServer] : [],
    );
    Menu.setApplicationMenu(buildMenu(() => mainWindow));
    mainWindow = createWindow();
    if (process.env.EDUTOOLS_SMOKE_TEST === "1") {
      void smokeTest(mainWindow);
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow();
      }
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}

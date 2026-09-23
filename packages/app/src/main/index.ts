import path from "node:path";
import { app, BrowserWindow, dialog, Menu, type OpenDialogOptions, shell } from "electron";
import { type Emit, sendEvent } from "../shared/ipc";
import { type ApiDeps, createApi } from "./api";
import { registerApi } from "./ipc";
import { buildMenu } from "./menu";
import { seedSmoke, smokeDeps, smokeTest } from "./smoke";

// electron-vite sets this in `dev` so the renderer is served with hot reload.
const devServer = process.env.ELECTRON_RENDERER_URL;
const here = import.meta.dirname;

app.setName("edutools");
app.setAboutPanelOptions({ applicationName: "edutools", applicationVersion: app.getVersion() });
// Electron's own data (caches, local storage) lives in a subfolder, so the
// edutools config directory holds only our site list and settings, and stays readable.
app.setPath("userData", path.join(app.getPath("appData"), "edutools", "app-data"));

let mainWindow: BrowserWindow | null = null;

const smoke = process.env.EDUTOOLS_SMOKE_TEST === "1";

const emit: Emit = (event, payload) => {
  for (const window of BrowserWindow.getAllWindows()) {
    sendEvent(window.webContents, event, payload);
  }
};

async function chooseFolder(defaultPath: string): Promise<string | null> {
  const options: OpenDialogOptions = {
    title: "Choose a snapshot folder",
    buttonLabel: "Choose",
    defaultPath,
    properties: ["openDirectory", "createDirectory", "promptToCreate"],
  };
  const result = mainWindow ? await dialog.showOpenDialog(mainWindow, options) : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

function realDeps(): ApiDeps {
  return {
    version: app.getVersion(),
    credentials: {},
    openExternal: (url) => shell.openExternal(url),
    documentsDir: app.getPath("documents"),
    chooseFolder,
    showItemInFolder: (fullPath) => shell.showItemInFolder(fullPath),
  };
}

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

  app.whenReady().then(async () => {
    const api = createApi({ ...(smoke ? smokeDeps(app.getVersion()) : realDeps()), emit });
    if (smoke) {
      await seedSmoke(api);
    }
    registerApi(api, devServer ? [devServer] : []);
    Menu.setApplicationMenu(buildMenu(() => mainWindow));
    mainWindow = createWindow();
    if (smoke) {
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

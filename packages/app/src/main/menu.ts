import { app, type BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";
import { NAVIGATE_CHANNEL } from "../shared/ipc";
import { SCREENS, type ScreenId } from "../shared/screens";

/**
 * A conventional menu bar. The Edit menu matters more than it looks: on macOS,
 * copy and paste in a text field only work when an Edit menu with those roles
 * exists, and pasting a Canvas token is the first thing a new user does.
 */
export function buildMenu(getWindow: () => BrowserWindow | null): Menu {
  const isMac = process.platform === "darwin";
  const go = (screen: ScreenId) => () => getWindow()?.webContents.send(NAVIGATE_CHANNEL, screen);

  const screenItems: MenuItemConstructorOptions[] = SCREENS.filter((s) => s.id !== "settings").map((s, i) => ({
    label: s.available ? s.title : `${s.title} (not yet available)`,
    enabled: s.available,
    accelerator: i < 9 ? `CmdOrCtrl+${i + 1}` : undefined,
    click: go(s.id),
  }));

  const settingsItem: MenuItemConstructorOptions = {
    label: isMac ? "Settings..." : "Settings",
    accelerator: "CmdOrCtrl+,",
    click: go("settings"),
  };

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              settingsItem,
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
    {
      label: "&File",
      submenu: isMac ? [{ role: "close" }] : [settingsItem, { type: "separator" }, { role: "quit", label: "E&xit" }],
    },
    {
      label: "&Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "&View",
      submenu: [
        ...screenItems,
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "reload" },
        { role: "toggleDevTools" },
      ],
    },
    { role: "windowMenu" },
    {
      label: "&Help",
      role: "help",
      submenu: [
        {
          label: "About edutools",
          visible: !isMac,
          click: () => app.showAboutPanel(),
        },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    // Only package.json `dependencies` stay external (the native keychain module);
    // @edutools/core and everything else is bundled into out/main.
    build: { externalizeDeps: true },
  },
  preload: {
    build: {
      // A sandboxed preload cannot load ES modules or require anything but
      // electron, so it is one self-contained CommonJS file.
      externalizeDeps: false,
      rollupOptions: {
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, "src/renderer"),
    build: {
      rollupOptions: { input: resolve(import.meta.dirname, "src/renderer/index.html") },
    },
    plugins: [react()],
  },
});

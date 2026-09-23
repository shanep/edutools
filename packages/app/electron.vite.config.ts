import { createRequire } from "node:module";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

// Loaded at run time rather than imported: electron-vite bundles this config as
// ESM, and a bundled copy of the CommonJS helper cannot require node:child_process.
// The cast is safe because the .d.cts beside the helper declares exactly this shape.
const { gitVersion } = createRequire(import.meta.url)(
  resolve(import.meta.dirname, "../../scripts/version.cjs"),
) as typeof import("../../scripts/version.cjs");

export default defineConfig({
  main: {
    // Only package.json `dependencies` stay external (the native modules);
    // @edutools/core and everything else is bundled into out/main.
    build: { externalizeDeps: true },
    // The one version, from git; see scripts/version.cjs. The renderer asks main for it.
    define: { __EDUTOOLS_VERSION__: JSON.stringify(gitVersion()) },
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

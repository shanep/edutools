/**
 * The edutools version, shared by the CLI and the desktop app.
 *
 * Builds replace __EDUTOOLS_VERSION__ with the version scripts/version.cjs derives
 * from git (esbuild for the CLI, electron-vite for the app). Running from source
 * (tsx, vitest) has no build step to stamp it, and core never shells out to git,
 * so that says it is source rather than guessing.
 */

declare const __EDUTOOLS_VERSION__: string | undefined;

export const VERSION: string = typeof __EDUTOOLS_VERSION__ === "string" ? __EDUTOOLS_VERSION__ : "0.0.0-source";

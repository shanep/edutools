// electron-builder configuration for the edutools desktop app.
//
// Unsigned by default. Signing switches on by itself when the standard
// electron-builder variables are present in the environment:
//   macOS signing:      CSC_LINK (a .p12 Developer ID Application cert), CSC_KEY_PASSWORD
//   macOS notarization: APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
//   Windows signing:    WIN_CSC_LINK (a .pfx), WIN_CSC_KEY_PASSWORD
// electron-builder reads all of these directly; this file only decides what an
// unsigned macOS build looks like.

const { gitVersion } = require("../../scripts/version.cjs");

const macSigned = Boolean(process.env.CSC_LINK || process.env.CSC_NAME);

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: "io.github.shanep.edutools",
  productName: "edutools",
  // npm workspaces hoist electron to the repo root, where electron-builder does
  // not look, so name the installed version rather than the package.json range.
  electronVersion: require("electron/package.json").version,
  copyright: "Copyright (c) Shane Panter",
  // The one version, from git (scripts/version.cjs), written into the packaged
  // package.json so the installer names, Info.plist and Windows metadata carry it
  // rather than this package's 0.0.0 placeholder.
  extraMetadata: { version: gitVersion() },
  directories: {
    output: "release",
    buildResources: "resources",
  },
  // Everything but the native modules (keychain, CSS inliner) is bundled into out/ by
  // electron-vite, so the app needs only out/ and package.json.
  files: ["out/**/*", "package.json"],
  // Both native modules are prebuilt N-API binaries: ABI-stable across Node and
  // Electron versions, so there is nothing to rebuild, and a .node file cannot be
  // loaded from inside an asar archive.
  npmRebuild: false,
  asar: true,
  asarUnpack: ["**/*.node", "node_modules/@napi-rs/**", "node_modules/@css-inline/**"],
  mac: {
    target: [{ target: "dmg", arch: ["arm64", "x64"] }],
    category: "public.app-category.education",
    // With no certificate, sign ad hoc rather than not at all: an Apple Silicon
    // Mac refuses to launch an app with no signature, but opens an ad hoc one
    // after the user approves it in System Settings > Privacy & Security.
    // Hardened runtime is for notarized builds and breaks ad hoc ones.
    identity: macSigned ? undefined : "-",
    hardenedRuntime: macSigned,
    entitlements: "resources/entitlements.mac.plist",
    entitlementsInherit: "resources/entitlements.mac.plist",
    // Only a signed build can be notarized. When Apple credentials are present,
    // electron-builder reads APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and
    // APPLE_TEAM_ID itself.
    notarize: macSigned && Boolean(process.env.APPLE_ID || process.env.APPLE_API_KEY),
  },
  dmg: {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder expands these macros itself.
    artifactName: "${productName}-${version}-mac-${arch}.${ext}",
  },
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
  },
  nsis: {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder expands these macros itself.
    artifactName: "${productName}-${version}-windows-${arch}-setup.${ext}",
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
  },
};

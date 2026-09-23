// Bundle the CLI into one file, dist/edutools.js, that runs with plain node.
//
// Native packages stay external: their .node binaries cannot be bundled, and
// they load from node_modules at runtime, which is why they are also listed in
// this package's dependencies.
import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { gitVersion } from "../../scripts/version.cjs";

const outfile = fileURLToPath(new URL("./dist/edutools.js", import.meta.url));

await build({
  entryPoints: [fileURLToPath(new URL("./src/main.ts", import.meta.url))],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["@napi-rs/keyring", "@css-inline/css-inline"],
  banner: {
    // cli-table3 and its dependencies are CommonJS and call require() for node
    // built-ins, which an ESM bundle does not have unless it is made here.
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __edutoolsCreateRequire } from "node:module";',
      "const require = __edutoolsCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  // The one version, from git; see scripts/version.cjs.
  define: { __EDUTOOLS_VERSION__: JSON.stringify(gitVersion()) },
  logLevel: "warning",
});

chmodSync(outfile, 0o755);

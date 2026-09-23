import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@edutools\/core\/(.*)$/,
        replacement: fileURLToPath(new URL("./packages/core/src/$1.ts", import.meta.url)),
      },
    ],
  },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
    passWithNoTests: true,
  },
});

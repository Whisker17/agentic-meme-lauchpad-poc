import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@0xwh1sker/mantle-meme-sdk": fileURLToPath(
        new URL("./packages/sdk/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: [
      "test/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      "tools/*/test/**/*.test.ts",
      "e2e/**/*.test.ts",
    ],
  },
});

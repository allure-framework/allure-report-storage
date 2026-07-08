import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";

const require = createRequire(import.meta.url);

export default defineConfig({
  test: {
    setupFiles: [require.resolve("allure-vitest/setup")],
    reporters: [
      "default",
      [
        "allure-vitest/reporter",
        {
          resultsDir: "./out/allure-results",
          globalLabels: [
            {
              name: "layer",
              value: "e2e",
            },
          ],
        },
      ],
    ],
    environment: "node",
    exclude: ["dist/**", "node_modules/**"],
    fileParallelism: false,
    hookTimeout: 90_000,
    include: ["test/e2e/**/*.spec.ts"],
    testTimeout: 90_000,
  },
});

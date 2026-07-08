import { defineConfig } from "vitest/config";

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
              value: "unit",
            },
          ],
        },
      ],
    ],
    environment: "node",
    exclude: ["dist/**", "node_modules/**"],
    include: ["test/unit/**/*.spec.ts"],
  },
});

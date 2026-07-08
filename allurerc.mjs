import { defineConfig } from "allure";

/**
 * @type {import("allure").AllureConfig}
 */
const config = {
  name: "Allure Report Storage",
  output: "./out/allure-report",
  plugins: {
    testops: {
      options: {
        launchName: `Allure Report Storage GitHub actions run (${new Date().toISOString()})`,
      },
    },
    log: {
      options: {
        groupBy: "layer",
      },
    },
  },
};

export default defineConfig(config);

#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const candidateDirs = ["src", "test", "features"].filter((dir) => fs.existsSync(path.resolve(process.cwd(), dir)));

if (candidateDirs.length === 0) {
  console.log("No source directories found for type-aware linting.");
  process.exit(0);
}

const result = spawnSync(
  "yarn",
  ["oxlint", "--type-aware", "--import-plugin", ...candidateDirs, ...process.argv.slice(2)],
  {
    stdio: "inherit",
  },
);

process.exit(result.status || 0);

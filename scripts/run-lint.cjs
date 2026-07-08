#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const fixMode = process.argv.includes("--fix");
const candidateDirs = ["src", "test", "features"].filter((dir) => fs.existsSync(path.resolve(process.cwd(), dir)));

if (candidateDirs.length === 0) {
  console.log("No source directories found for linting.");
  process.exit(0);
}

const args = ["oxlint", "--import-plugin"];
if (fixMode) {
  args.push("--fix");
}
args.push(...candidateDirs);

const result = spawnSync("yarn", args, {
  stdio: "inherit",
});

process.exit(result.status || 0);

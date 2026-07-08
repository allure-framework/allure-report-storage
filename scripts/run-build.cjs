#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const rootDir = path.resolve(process.cwd(), "src");

const hasSourceFiles = (currentDir) => {
  if (!fs.existsSync(currentDir)) {
    return false;
  }

  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const entryPath = path.join(currentDir, entry.name);
    if (entry.isDirectory() && hasSourceFiles(entryPath)) {
      return true;
    }
    if (entry.isFile() && /\.(?:[cm]?ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      return true;
    }
  }

  return false;
};

if (!hasSourceFiles(rootDir)) {
  console.log("No application source files found for build.");
  process.exit(0);
}

const result = spawnSync("yarn", ["tsc", "--project", "./tsconfig.json"], {
  stdio: "inherit",
});

process.exit(result.status || 0);

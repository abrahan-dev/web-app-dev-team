#!/usr/bin/env node

const { spawn, spawnSync } = require("node:child_process");
const { resolve } = require("node:path");

const bunCommand = process.env.WEB_APP_DEV_TEAM_BUN ?? "bun";
const check = spawnSync(bunCommand, ["--version"], { stdio: "ignore" });

if (check.error || check.status !== 0) {
  console.error("Error: Bun is required but is not available.");
  console.error("Install Bun from https://bun.sh and try again.");
  process.exitCode = 1;
} else {
  const cli = resolve(__dirname, "../dist/cli.js");
  const child = spawn(bunCommand, [cli, ...process.argv.slice(2)], { stdio: "inherit" });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }

  child.on("error", (error) => {
    console.error(`Error: Could not start web-app-dev-team: ${error.message}`);
    process.exitCode = 1;
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exitCode = code ?? 1;
  });
}

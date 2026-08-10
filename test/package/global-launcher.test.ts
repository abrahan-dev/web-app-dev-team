import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { packageRoot } from "../../src/package-paths.ts";
import { expectedPackageVersion } from "../support/package-metadata.ts";

const launcher = resolve(packageRoot, "bin/web-app-dev-team.cjs");

describe("global launcher", () => {
  test("starts the built CLI with Bun", () => {
    const result = Bun.spawnSync(["node", launcher, "--version"], {
      cwd: "/tmp",
      env: { ...process.env, WEB_APP_DEV_TEAM_BUN: Bun.which("bun") ?? "bun" },
      stderr: "pipe",
      stdout: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe(expectedPackageVersion);
  });

  test("explains how to fix a missing Bun executable", () => {
    const result = Bun.spawnSync(["node", launcher, "--version"], {
      env: { ...process.env, WEB_APP_DEV_TEAM_BUN: "/missing/web-app-dev-team-bun" },
      stderr: "pipe",
      stdout: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Bun is required");
    expect(result.stderr.toString()).toContain("https://bun.sh");
  });
});

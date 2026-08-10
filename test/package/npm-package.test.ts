import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { packageRoot } from "../../src/package-paths.ts";
import { expectedPackageVersion } from "../support/package-metadata.ts";

interface PackedFile {
  path: string;
  mode: number;
}

interface PackResult {
  files: PackedFile[];
  name: string;
  version: string;
}

let temporaryDirectory = "";
let packResult: PackResult;

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(resolve(tmpdir(), "web-app-dev-team-package-"));
  const packed = Bun.spawnSync(
    ["npm", "pack", "--json", "--dry-run", "--cache", resolve(temporaryDirectory, "npm-cache")],
    { cwd: packageRoot, stderr: "pipe", stdout: "pipe" },
  );

  if (packed.exitCode !== 0) {
    throw new Error(packed.stderr.toString());
  }

  const [result] = JSON.parse(packed.stdout.toString()) as PackResult[];

  if (!result) {
    throw new Error("npm pack returned no package result.");
  }

  packResult = result;
});

afterAll(async () => {
  await rm(temporaryDirectory, { force: true, recursive: true });
});

describe("npm package", () => {
  test("uses the public scoped identity", () => {
    expect(packResult.name).toBe("@hagioscopio/web-app-dev-team");
    expect(packResult.version).toBe(expectedPackageVersion);
  });

  test("contains the executable code and assets", () => {
    const files = packResult.files.map(({ path }) => path);

    expect(files).toContain("bin/web-app-dev-team.cjs");
    expect(files).toContain("dist/cli.js");
    expect(files).toContain("dist/watch-role.js");
    expect(files).toContain("assets/workspace/stack.json");
    expect(files).toContain("assets/agents/roles/specifier.md");
    expect(files).toContain("LICENSE");
    expect(packResult.files.find(({ path }) => path === "bin/web-app-dev-team.cjs")?.mode).toBe(
      0o755,
    );
  });

  test("excludes source, tests, and local data", () => {
    const files = packResult.files.map(({ path }) => path);

    expect(files.some((path) => path.startsWith("src/"))).toBeFalse();
    expect(files.some((path) => path.startsWith("test/"))).toBeFalse();
    expect(files.some((path) => path === ".env")).toBeFalse();
    expect(files.some((path) => path.startsWith(".web-app-dev-team/"))).toBeFalse();
  });
});

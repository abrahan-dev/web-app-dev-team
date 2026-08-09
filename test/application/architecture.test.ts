import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { relative } from "node:path";

async function sourceFiles(pattern: string): Promise<string[]> {
  return Array.fromAsync(
    new Bun.Glob(pattern).scan({
      cwd: resolveProjectRoot(),
      absolute: true,
      onlyFiles: true,
    }),
  );
}

function resolveProjectRoot(): string {
  return new URL("../../", import.meta.url).pathname;
}

async function forbiddenImports(pattern: string, forbiddenLayer: RegExp): Promise<string[]> {
  const root = resolveProjectRoot();
  const files = await sourceFiles(pattern);
  const violations: string[] = [];

  for (const file of files) {
    const content = await readFile(file, "utf8");

    if (forbiddenLayer.test(content)) {
      violations.push(relative(root, file));
    }
  }

  return violations;
}

describe("source layer boundaries", () => {
  test("keeps infrastructure out of the application layer", async () => {
    expect(
      await forbiddenImports("src/application/**/*.ts", /from ["'][^"']*infrastructure/),
    ).toEqual([]);
  });

  test("keeps application and infrastructure out of the domain layer", async () => {
    expect(
      await forbiddenImports("src/domain/**/*.ts", /from ["'][^"']*(?:application|infrastructure)/),
    ).toEqual([]);
  });
});

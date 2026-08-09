import { describe, expect, test } from "bun:test";
import {
  describeStackCatalog,
  loadStackCatalog,
} from "../../../src/infrastructure/configuration/stack-catalog.ts";

describe("stack catalog", () => {
  test("loads the exact bootstrap versions", () => {
    const catalog = loadStackCatalog();

    expect(catalog.runtime.bun).toBe("1.3.10");
    expect(catalog.dependencies["@trpc/server"]).toBe("11.18.0");
    expect(catalog.developmentDependencies.typescript).toBe("7.0.2");
  });

  test("describes every resolved version for the architect", () => {
    const description = describeStackCatalog();

    expect(description).toContain("- bun: 1.3.10");
    expect(description).toContain("- @trpc/server: 11.18.0");
    expect(description).toContain("- typescript: 7.0.2");
  });
});

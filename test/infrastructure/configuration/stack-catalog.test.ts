import { describe, expect, test } from "bun:test";
import {
  assertStackCatalogCompatibility,
  describeStackCatalog,
  loadStackCatalog,
  parseStackCatalog,
} from "../../../src/infrastructure/configuration/stack-catalog.ts";

describe("stack catalog", () => {
  test("loads the exact bootstrap versions", () => {
    const catalog = loadStackCatalog();

    expect(catalog.runtime.bun).toBe("1.3.10");
    expect(catalog.dependencies["@trpc/server"]).toBe("11.18.0");
    expect(catalog.dependencies["swagger-ui-dist"]).toBe("5.32.13");
    expect(catalog.developmentDependencies["@hey-api/openapi-ts"]).toBe("0.94.5");
    expect(catalog.developmentDependencies["@trpc/openapi"]).toBe("11.18.0-alpha");
    expect(catalog.developmentDependencies.typescript).toBe("6.0.3");
  });

  test("describes every resolved version for the architect", () => {
    const description = describeStackCatalog();

    expect(description).toContain("- bun: 1.3.10");
    expect(description).toContain("- @trpc/server: 11.18.0");
    expect(description).toContain("- @hey-api/openapi-ts: 0.94.5");
    expect(description).toContain("- swagger-ui-dist: 5.32.13");
    expect(description).toContain("- typescript: 6.0.3");
  });

  test("rejects a catalog outside the tested API combination", () => {
    const catalog = loadStackCatalog();
    const invalid = {
      ...catalog,
      developmentDependencies: {
        ...catalog.developmentDependencies,
        typescript: "7.0.2",
      },
    };

    expect(() => assertStackCatalogCompatibility(invalid)).toThrow(
      "typescript must be 6.0.3; received 7.0.2",
    );
  });

  test("rejects package version ranges", () => {
    const catalog = loadStackCatalog();
    const invalid = {
      ...catalog,
      dependencies: { ...catalog.dependencies, react: "^19.2.8" },
    };

    expect(() => parseStackCatalog(invalid)).toThrow("Use one exact semantic version");
  });
});

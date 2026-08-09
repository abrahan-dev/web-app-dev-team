import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { changePlanSchema, roles } from "../../src/domain/schemas.ts";

describe("specialized role contracts", () => {
  test("keeps one output schema for every registered role", async () => {
    for (const role of roles) {
      const schema = JSON.parse(
        await readFile(
          resolve(
            import.meta.dir,
            "../../assets/agents/output-schemas",
            `${role}-output.schema.json`,
          ),
          "utf8",
        ),
      ) as { properties?: { role?: { enum?: string[] } } };

      expect(schema.properties?.role?.enum).toEqual([role]);
    }
  });

  test("rejects an architect plan that requires no implementation surface", () => {
    expect(() =>
      changePlanSchema.parse({
        applicationName: "operations",
        contexts: ["orders"],
        dataRequired: false,
        backendRequired: false,
        frontendRequired: false,
      }),
    ).toThrow("At least one implementation surface");
  });
});

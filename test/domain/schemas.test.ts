import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { architectTurnSchema, changePlanSchema, roles } from "../../src/domain/schemas.ts";
import { Role } from "../../src/domain/roles.ts";

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
        persistenceContexts: [],
        dataRequired: false,
        backendRequired: false,
        frontendRequired: false,
      }),
    ).toThrow("At least one implementation surface");
  });

  test("keeps persistence contexts inside the planned contexts", () => {
    expect(() =>
      changePlanSchema.parse({
        applicationName: "operations",
        contexts: ["orders"],
        persistenceContexts: ["identity"],
        dataRequired: true,
        backendRequired: true,
        frontendRequired: false,
      }),
    ).toThrow("must be in contexts");
  });

  test("loads an old data plan with all contexts selected for persistence", () => {
    expect(
      changePlanSchema.parse({
        applicationName: "operations",
        contexts: ["orders", "identity"],
        dataRequired: true,
        backendRequired: true,
        frontendRequired: false,
      }).persistenceContexts,
    ).toEqual(["orders", "identity"]);
  });

  test("requires one owner and concrete findings for a failed architecture review", () => {
    expect(() =>
      architectTurnSchema.parse({
        role: Role.Architect,
        summary: "Review failed.",
        design: "Keep the approved plan.",
        changePlan: {
          applicationName: "operations",
          contexts: ["orders"],
          persistenceContexts: [],
          dataRequired: false,
          backendRequired: true,
          frontendRequired: false,
        },
        domainModel: [],
        apiContract: [],
        security: [],
        constraints: [],
        risks: [],
        reviewStatus: "changes-requested",
        reviewFindings: [],
        failureOwner: Role.BackendCoder,
        artifacts: [],
        evidence: [],
        decision: "handoff",
        nextRole: Role.BackendCoder,
        reason: "Correct the boundary.",
      }),
    ).toThrow("require findings");
  });
});

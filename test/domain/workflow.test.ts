import { describe, expect, test } from "bun:test";
import type { ChangePlan } from "../../src/domain/schemas.ts";
import { Role } from "../../src/domain/roles.ts";
import { TurnDecision } from "../../src/domain/workflow-values.ts";
import {
  firstImplementationRole,
  nextImplementationRole,
  validateTransition,
} from "../../src/domain/workflow.ts";

const fullStack: ChangePlan = {
  applicationName: "operations",
  contexts: ["orders"],
  dataRequired: true,
  backendRequired: true,
  frontendRequired: true,
};

function turn(
  nextRole: Role | null,
  decision: TurnDecision = TurnDecision.Handoff,
  failureOwner: Role | null = null,
) {
  return {
    decision,
    nextRole,
    failureOwner,
    failures: decision === TurnDecision.Handoff && failureOwner ? ["observable failure"] : [],
  };
}

describe("deterministic specialized workflow", () => {
  test("derives conditional implementation stages from the architect plan", () => {
    expect(firstImplementationRole(fullStack)).toBe(Role.UiDesigner);
    expect(nextImplementationRole(Role.UiDesigner, fullStack)).toBe(Role.DataEngineer);
    expect(nextImplementationRole(Role.DataEngineer, fullStack)).toBe(Role.BackendCoder);
    expect(nextImplementationRole(Role.BackendCoder, fullStack)).toBe(Role.FrontendCoder);
    expect(nextImplementationRole(Role.FrontendCoder, fullStack)).toBe(Role.Qa);

    expect(
      firstImplementationRole({
        ...fullStack,
        dataRequired: false,
        frontendRequired: false,
      }),
    ).toBe(Role.BackendCoder);
  });

  test("accepts the planned path, architect escalation and owned QA feedback", () => {
    expect(() => validateTransition(Role.Specifier, turn(Role.Architect))).not.toThrow();
    expect(() =>
      validateTransition(Role.Architect, turn(Role.UiDesigner), "delivery", fullStack),
    ).not.toThrow();
    expect(() =>
      validateTransition(Role.UiDesigner, turn(Role.DataEngineer), "delivery", fullStack),
    ).not.toThrow();
    expect(() =>
      validateTransition(Role.DataEngineer, turn(Role.BackendCoder), "delivery", fullStack),
    ).not.toThrow();
    expect(() =>
      validateTransition(Role.BackendCoder, turn(Role.FrontendCoder), "delivery", fullStack),
    ).not.toThrow();
    expect(() =>
      validateTransition(Role.FrontendCoder, turn(Role.Architect), "delivery", fullStack),
    ).not.toThrow();
    expect(() =>
      validateTransition(
        Role.Qa,
        turn(Role.FrontendCoder, TurnDecision.Handoff, Role.FrontendCoder),
      ),
    ).not.toThrow();
    expect(() => validateTransition(Role.Qa, turn(null, TurnDecision.Complete))).not.toThrow();
  });

  test("rejects skipped stages, premature completion and mismatched QA ownership", () => {
    expect(() =>
      validateTransition(Role.Architect, turn(Role.BackendCoder), "delivery", fullStack),
    ).toThrow("must hand off to ui-designer");
    expect(() => validateTransition(Role.BackendCoder, turn(null, TurnDecision.Complete))).toThrow(
      "Only QA may complete",
    );
    expect(() =>
      validateTransition(
        Role.Qa,
        turn(Role.BackendCoder, TurnDecision.Handoff, Role.FrontendCoder),
      ),
    ).toThrow("failureOwner");
  });
});

test("restitution cannot return an approved specification to the specifier", () => {
  expect(() =>
    validateTransition(
      Role.Architect,
      { decision: TurnDecision.Handoff, nextRole: Role.Specifier },
      "restitution",
      fullStack,
    ),
  ).toThrow("approved specification cannot return to the specifier");
});

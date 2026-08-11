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
  persistenceContexts: ["orders"],
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
    expect(nextImplementationRole(Role.FrontendCoder, fullStack)).toBe(Role.Architect);

    expect(
      firstImplementationRole({
        ...fullStack,
        persistenceContexts: [],
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
        Role.Architect,
        {
          ...turn(Role.Qa),
          reviewStatus: "approved",
          reviewFindings: [],
        },
        "delivery",
        fullStack,
        "pending",
      ),
    ).not.toThrow();
    expect(() =>
      validateTransition(
        Role.Architect,
        {
          ...turn(Role.BackendCoder, TurnDecision.Handoff, Role.BackendCoder),
          reviewStatus: "changes-requested",
          reviewFindings: ["src/backend.ts violates the planned boundary."],
        },
        "delivery",
        fullStack,
        "pending",
      ),
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

  test.each([
    [
      "completion with a next role",
      Role.Qa,
      turn(Role.Architect, TurnDecision.Complete),
      "completion has no next role",
    ],
    [
      "completion with a failure owner",
      Role.Qa,
      turn(null, TurnDecision.Complete, Role.BackendCoder),
      "cannot name a failure owner",
    ],
    [
      "completion with failures",
      Role.Qa,
      { ...turn(null, TurnDecision.Complete), failures: ["Still broken."] },
      "failures remain",
    ],
    ["handoff without a role", Role.Architect, turn(null), "must name its next role"],
    ["specifier skips architect", Role.Specifier, turn(Role.Qa), "specifier cannot hand off"],
    ["QA feedback without failures", Role.Qa, turn(Role.BackendCoder), "concrete failure"],
    [
      "implementation without a plan",
      Role.BackendCoder,
      turn(Role.FrontendCoder),
      "technical change plan",
    ],
  ])("rejects %s", (_label, from, decision, expected) => {
    expect(() => validateTransition(from, decision)).toThrow(expected);
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

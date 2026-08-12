import { describe, expect, test } from "bun:test";
import { activeQualityFailure } from "../../../src/application/development/quality-feedback.ts";
import type { LocalCheck } from "../../../src/domain/schemas.ts";
import { Role } from "../../../src/domain/roles.ts";
import { runStateFactory } from "../../support/domain-factories.ts";

function failedCheck(createdAt: string): LocalCheck {
  return {
    sequence: 1,
    turn: 1,
    role: Role.FrontendCoder,
    kind: "quality-gate",
    createdAt,
    passed: false,
    summary: "Coverage failed.",
    details: ["main.tsx is missing from coverage."],
    commands: [],
  };
}

describe("active quality failure", () => {
  test("uses a failure that is newer than the routed assignment", () => {
    const state = runStateFactory({ currentRole: Role.FrontendCoder });
    const failure = failedCheck("2026-08-11T10:01:00.000Z");
    state.localChecks.push(failure);

    expect(activeQualityFailure(state, Role.FrontendCoder)).toBe(failure);
  });

  test("expires a failure after a successful check", () => {
    const state = runStateFactory({ currentRole: Role.FrontendCoder });
    state.localChecks.push(failedCheck("2026-08-11T10:01:00.000Z"), {
      ...failedCheck("2026-08-11T10:02:00.000Z"),
      sequence: 2,
      turn: 2,
      passed: true,
      summary: "Coverage passed.",
      details: [],
    });

    expect(activeQualityFailure(state, Role.FrontendCoder)).toBeNull();
  });

  test("expires a failure after a newer routed assignment", () => {
    const state = runStateFactory({ currentRole: Role.FrontendCoder });
    state.localChecks.push(failedCheck("2026-08-11T10:01:00.000Z"));
    const initial = state.messages[0];

    if (!initial) {
      throw new Error("The run state has no initial assignment.");
    }

    state.messages.push({
      ...initial,
      id: "new-assignment",
      sequence: 1,
      createdAt: "2026-08-11T10:02:00.000Z",
    });

    expect(activeQualityFailure(state, Role.FrontendCoder)).toBeNull();
  });
});

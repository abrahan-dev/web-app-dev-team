import { describe, expect, test } from "bun:test";
import { extendedTurnLimit, parseTurnLimit, turnLimitLabel } from "../../src/domain/turn-limit.ts";

describe("turn limits", () => {
  test("parses and labels an unlimited turn count", () => {
    expect(parseTurnLimit("unlimited", "turn limit")).toBe(0);
    expect(turnLimitLabel(0)).toBe("∞");
  });

  test("keeps unlimited when a run resumes", () => {
    expect(extendedTurnLimit(0, 24)).toBe(0);
    expect(extendedTurnLimit(12, 0)).toBe(0);
    expect(extendedTurnLimit(12, 24)).toBe(24);
  });
});

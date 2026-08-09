import { expect, test } from "bun:test";
import { TerminalSpecificationReviewer } from "../../../src/apps/cli/terminal-specification-reviewer.ts";
import type { RunState, SpecifierTurn } from "../../../src/domain/schemas.ts";
import { Role } from "../../../src/domain/roles.ts";
import { emptyTokenTotals } from "../../../src/domain/token-usage.ts";
import { SpecificationReviewDecision, TurnDecision } from "../../../src/domain/workflow-values.ts";
import type { CommandRunner } from "../../../src/infrastructure/terminal/tmux.ts";

const specification: SpecifierTurn = {
  role: Role.Specifier,
  featureId: "validate-input",
  summary: "Accept valid input and reject invalid input.",
  specification:
    "Feature: Validate input\n\n  Scenario: Reject invalid input\n    Given invalid input\n    When validation runs\n    Then a validation error is returned",
  assumptions: [],
  outOfScope: [],
  artifacts: [],
  evidence: ["Given invalid input, the operation returns a validation error."],
  decision: TurnDecision.Handoff,
  nextRole: Role.Architect,
  reason: "The behavior is ready for architectural review.",
};

const state = {
  prompt: "Build validation",
  turns: 1,
  maxTurns: 12,
  tokenTotals: emptyTokenTotals(),
} as RunState;

test("human approval switches to the review window and back", async () => {
  const commands: string[][] = [];
  const runner: CommandRunner = {
    run(command) {
      commands.push(command);

      return Promise.resolve();
    },
  };
  const reviewer = new TerminalSpecificationReviewer(runner, "dev-team-test", () =>
    Promise.resolve("a"),
  );

  expect(await reviewer.review({ state, specification })).toEqual({
    decision: SpecificationReviewDecision.Approved,
    feedback: null,
  });
  expect(commands).toEqual([
    ["tmux", "select-window", "-t", "dev-team-test:orchestrator"],
    ["tmux", "select-window", "-t", "dev-team-test:agents"],
  ]);
});

test("human feedback requests another specifier turn", async () => {
  const answers = ["c", "Include the empty-input case."];
  const reviewer = new TerminalSpecificationReviewer(
    { run: () => Promise.resolve() },
    undefined,
    () => Promise.resolve(answers.shift() ?? ""),
  );

  expect(await reviewer.review({ state, specification })).toEqual({
    decision: SpecificationReviewDecision.ChangesRequested,
    feedback: "Include the empty-input case.",
  });
});

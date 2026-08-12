import { expect, test } from "bun:test";
import { formatGherkin } from "../../../src/domain/specification/gherkin-formatter.ts";

test("Gherkin formatting separates scenarios and indents their steps", () => {
  expect(
    formatGherkin(
      "Feature: Tasks\nScenario: Create a task\nGiven an empty list\nWhen a task is created\nThen the list shows it\nScenario: Delete a task\nGiven a saved task\nWhen the task is deleted\nThen the list is empty",
    ),
  ).toBe(`Feature: Tasks

  Scenario: Create a task
    Given an empty list
    When a task is created
    Then the list shows it

  Scenario: Delete a task
    Given a saved task
    When the task is deleted
    Then the list is empty`);
});

test("Gherkin formatting removes duplicate blank lines", () => {
  const source =
    "Feature: Tasks\n\n  Scenario: Create a task\n\n    Given an empty list\n    When a task is created\n    Then the list shows it";
  const formatted = formatGherkin(source);

  expect(formatted).toContain("Feature: Tasks\n\n  Scenario: Create a task\n    Given");
  expect(formatGherkin(formatted)).toBe(formatted);
});

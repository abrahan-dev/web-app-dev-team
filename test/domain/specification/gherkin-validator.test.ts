import { describe, expect, test } from "bun:test";
import { validateGherkin } from "../../../src/domain/specification/gherkin-validator.ts";

describe("local Gherkin validation", () => {
  test("derives a stable feature ID and accepts the supported subset", () => {
    const result = validateGherkin(`Feature: Gestión de pedidos

Scenario: Crear un pedido
  Given un carrito con productos
  When el cliente confirma el pedido
  Then el pedido queda registrado
  And se muestra su identificador`);

    expect(result.errors).toEqual([]);
    expect(result.featureId).toBe("gestion-de-pedidos");
    expect(result.scenarios).toEqual(["Crear un pedido"]);
  });

  test("rejects ambiguous or incomplete scenarios before human review", () => {
    const result = validateGherkin(`Feature: Checkout
Scenario: Empty step
  Given
  Then a result exists`);

    expect(result.errors).toContain("Line 3 has an empty Given statement.");
    expect(result.errors).toContain('Scenario "Empty step" has no When step.');
  });

  test.each([
    ["unsupported syntax", "Feature: Orders\nRule: Unsupported", "uses unsupported Gherkin syntax"],
    [
      "missing feature",
      "Scenario: Orphan\nGiven a state\nWhen it runs\nThen it works",
      "has no Feature",
    ],
    ["missing scenario", "Feature: Orders", "at least one Scenario"],
    [
      "duplicate feature",
      "Feature: Orders\nFeature: More orders\nScenario: Create\nGiven a state\nWhen it runs\nThen it works",
      "exactly one Feature",
    ],
    [
      "duplicate scenario",
      "Feature: Orders\nScenario: Create\nGiven a state\nWhen it runs\nThen it works\nScenario: Create\nGiven a state\nWhen it runs\nThen it works",
      "is duplicated",
    ],
  ])("rejects %s", (_label, source, expected) => {
    expect(validateGherkin(source).errors.some((error) => error.includes(expected))).toBe(true);
  });
});

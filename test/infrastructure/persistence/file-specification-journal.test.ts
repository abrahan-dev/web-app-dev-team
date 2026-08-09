import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { SpecifierTurn } from "../../../src/domain/schemas.ts";
import { Role } from "../../../src/domain/roles.ts";
import { TurnDecision } from "../../../src/domain/workflow-values.ts";
import { FileSpecificationJournal } from "../../../src/infrastructure/persistence/file-specification-journal.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function workspace(): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), "specification-journal-"));
  temporaryDirectories.push(directory);

  return directory;
}

function specification(featureId: string): SpecifierTurn {
  return {
    role: Role.Specifier,
    featureId,
    summary: `Specified ${featureId}.`,
    specification: `Feature: ${featureId}\n\n  Scenario: Deliver behavior\n    Given a valid initial state\n    When the behavior runs\n    Then its outcome is observable`,
    assumptions: ["The public contract is stable."],
    outOfScope: ["Unrelated behavior."],
    artifacts: [],
    evidence: ["The scenario has an observable outcome."],
    decision: TurnDecision.Handoff,
    nextRole: Role.Architect,
    reason: "Ready for review.",
  };
}

describe("specification journal", () => {
  test("publishes approved changes in immutable sequence order", async () => {
    const root = await workspace();
    const journal = new FileSpecificationJournal();
    const first = await journal.publish({
      workspace: root,
      sourceReviewId: "review-1",
      specification: specification("account-registration"),
    });
    const second = await journal.publish({
      workspace: root,
      sourceReviewId: "review-2",
      specification: specification("authentication"),
    });

    expect(first.path).toBe("specifications/000001-account-registration.feature");
    expect(second.path).toBe("specifications/000002-authentication.feature");
    expect(await readFile(resolve(root, first.path), "utf8")).toContain("# Sequence: 1");
    const manifest = JSON.parse(
      await readFile(resolve(root, "specifications/manifest.json"), "utf8"),
    ) as { nextSequence: number; specifications: Array<{ sequence: number }> };
    expect(manifest.nextSequence).toBe(3);
    expect(manifest.specifications.map(({ sequence }) => sequence)).toEqual([1, 2]);
    await expect(journal.verify(root)).resolves.toBeUndefined();
  });

  test("is idempotent for the same approved review", async () => {
    const root = await workspace();
    const journal = new FileSpecificationJournal();
    const request = {
      workspace: root,
      sourceReviewId: "review-1",
      specification: specification("account-registration"),
    };

    expect(await journal.publish(request)).toEqual(await journal.publish(request));
    const manifest = JSON.parse(
      await readFile(resolve(root, "specifications/manifest.json"), "utf8"),
    ) as { specifications: unknown[] };
    expect(manifest.specifications).toHaveLength(1);
  });

  test("detects modification of an approved specification", async () => {
    const root = await workspace();
    const journal = new FileSpecificationJournal();
    const published = await journal.publish({
      workspace: root,
      sourceReviewId: "review-1",
      specification: specification("account-registration"),
    });
    await Bun.write(resolve(root, published.path), "tampered\n");

    await expect(journal.verify(root)).rejects.toThrow("Specification integrity check failed");
  });
});

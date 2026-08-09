import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { AgentRunner } from "../../../src/application/ports/agent-runner.ts";
import { ScriptedAgentRunner } from "../../../src/infrastructure/agents/scripted/scripted-agent-runner.ts";
import type { SpecifierTurn } from "../../../src/domain/schemas.ts";
import { Role } from "../../../src/domain/roles.ts";
import { RestitutionStatus, RunStatus, TurnDecision } from "../../../src/domain/workflow-values.ts";
import { loadRunState } from "../../../src/infrastructure/persistence/file-run-store.ts";
import {
  createRestitution,
  loadRestitutionState,
  runRestitution,
} from "../../../src/infrastructure/restitution/specification-restitution.ts";
import { FileSpecificationJournal } from "../../../src/infrastructure/persistence/file-specification-journal.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryRoot(label: string): Promise<string> {
  const directory = await mkdtemp(resolve(tmpdir(), label));
  temporaryDirectories.push(directory);

  return directory;
}

function specification(featureId: string): SpecifierTurn {
  return {
    role: Role.Specifier,
    featureId,
    summary: `Specify ${featureId}.`,
    specification: `Feature: ${featureId}\n\n  Scenario: Restore behavior\n    Given an empty application\n    When this change is restored\n    Then its behavior is available`,
    assumptions: [],
    outOfScope: [],
    artifacts: [],
    evidence: ["The outcome is observable."],
    decision: TurnDecision.Handoff,
    nextRole: Role.Architect,
    reason: "Ready for approval.",
  };
}

async function sourceArchive(featureIds: string[]): Promise<string> {
  const root = await temporaryRoot("restitution-source-");
  const journal = new FileSpecificationJournal();

  for (const [index, featureId] of featureIds.entries()) {
    await journal.publish({
      workspace: root,
      sourceReviewId: `review-${index + 1}`,
      specification: specification(featureId),
    });
  }

  return resolve(root, "specifications");
}

describe("specification restitution", () => {
  test("implements and checkpoints every approved specification in order", async () => {
    const source = await sourceArchive(["first-change", "second-change"]);
    const workspace = await temporaryRoot("restitution-target-");
    await Bun.write(resolve(workspace, "README.md"), "# Existing test project\n");
    const created = await createRestitution({
      workspace,
      specificationsDirectory: source,
      maxTurnsPerSpecification: 8,
    });
    const scripted = new ScriptedAgentRunner();
    const meteredRunner: AgentRunner = {
      async run(context) {
        return {
          turn: await scripted.run(context),
          usage: {
            inputTokens: 8,
            cachedInputTokens: 4,
            outputTokens: 2,
            reasoningOutputTokens: 1,
            totalTokens: 10,
          },
        };
      },
    };
    const result = await runRestitution(created.directory, meteredRunner);

    expect(result.status).toBe(RestitutionStatus.Completed);
    expect(result.completedSequences).toEqual([1, 2]);
    expect(result.nextSequence).toBe(3);
    expect(result.tokenTotals.team.totalTokens).toBe(120);
    expect(result.tokenTotals.byRole[Role.Architect].totalTokens).toBe(20);
    expect(
      JSON.parse(await readFile(resolve(created.directory, "results", "000001.json"), "utf8")),
    ).toMatchObject({ mode: "restitution", status: RunStatus.Completed });
    expect(
      await readFile(resolve(workspace, "specifications", "000002-second-change.feature"), "utf8"),
    ).toContain("Feature: second-change");
  });

  test("resumes the current agent without skipping a sequence after failure", async () => {
    const source = await sourceArchive(["resumable-change"]);
    const workspace = await temporaryRoot("restitution-target-");
    await Bun.write(resolve(workspace, "README.md"), "# Existing test project\n");
    const created = await createRestitution({
      workspace,
      specificationsDirectory: source,
      maxTurnsPerSpecification: 8,
    });
    const scripted = new ScriptedAgentRunner();
    let calls = 0;
    const quotaFailure: AgentRunner = {
      run(context) {
        calls += 1;

        if (calls === 2) {
          throw new Error("token quota exhausted");
        }

        return scripted.run(context);
      },
    };
    const interrupted = await runRestitution(created.directory, quotaFailure);

    expect(interrupted.status).toBe(RestitutionStatus.Interrupted);
    expect(interrupted.currentSequence).toBe(1);
    expect(interrupted.completedSequences).toEqual([]);
    expect(interrupted.failure).toContain("token quota exhausted");
    expect(interrupted.resumeRole).toBe(Role.UiDesigner);
    expect((await loadRunState(created.directory)).interruptions).toMatchObject([
      { role: Role.UiDesigner, reason: "token quota exhausted" },
    ]);
    expect(await readFile(resolve(created.directory, "progress.log"), "utf8")).toContain(
      "Interrupted resumable-change at agent ui-designer",
    );

    const resumed = await runRestitution(created.directory, new ScriptedAgentRunner());

    expect(resumed.status).toBe(RestitutionStatus.Completed);
    expect(resumed.completedSequences).toEqual([1]);
    expect((await loadRestitutionState(created.directory)).nextSequence).toBe(2);
  });
});

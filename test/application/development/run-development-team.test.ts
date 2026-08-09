import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AgentContext, AgentRunner } from "../../../src/application/ports/agent-runner.ts";
import { ScriptedAgentRunner } from "../../../src/infrastructure/agents/scripted/scripted-agent-runner.ts";
import type { AgentTurn, GitWorkflowState } from "../../../src/domain/schemas.ts";
import { Role } from "../../../src/domain/roles.ts";
import {
  RunStatus,
  SpecificationReviewDecision,
  TurnDecision,
  GitWorkflowStep,
} from "../../../src/domain/workflow-values.ts";
import type { RepositoryWorkflow } from "../../../src/application/ports/repository-workflow.ts";
import { runDevelopmentTeam as executeDevelopmentTeam } from "../../../src/application/development/run-development-team.ts";
import {
  createRunState,
  loadRunState,
  saveRunState,
} from "../../../src/infrastructure/persistence/file-run-store.ts";
import {
  AutomaticSpecificationReviewer,
  type SpecificationReviewer,
} from "../../../src/application/ports/specification-reviewer.ts";
import { FileSpecificationJournal } from "../../../src/infrastructure/persistence/file-specification-journal.ts";
import type {
  SpecificationJournal,
  WorkspaceBootstrapper,
} from "../../../src/application/ports/development-services.ts";
import { developmentServices } from "../../../src/infrastructure/development-services.ts";
import { DeterministicWorkspaceBootstrapper } from "../../../src/infrastructure/workspace/workspace-bootstrapper.ts";
import { DevelopmentTeamHarness } from "../../support/development-team-harness.ts";
import { gitWorkflowStateFactory } from "../../support/domain-factories.ts";
import { TemporaryWorkspaceManager } from "../../support/temporary-workspaces.ts";

const temporary = new TemporaryWorkspaceManager();

afterEach(async () => {
  await temporary.cleanup();
});

async function newRun(maxTurns = 12): Promise<string> {
  const root = await temporary.create();
  await writeFile(resolve(root, "README.md"), "# Existing test project\n");
  const created = await createRunState({
    prompt: "Build a small feature",
    workspace: root,
    runsRoot: root,
    maxTurns,
  });

  return created.runDirectory;
}

function runDevelopmentTeam(
  runner: AgentRunner,
  runDirectory: string,
  reviewer: SpecificationReviewer,
  journal: SpecificationJournal,
  bootstrapper: WorkspaceBootstrapper = new DeterministicWorkspaceBootstrapper(),
  repositoryWorkflow?: RepositoryWorkflow,
) {
  return executeDevelopmentTeam(
    runner,
    runDirectory,
    reviewer,
    journal,
    developmentServices,
    bootstrapper,
    repositoryWorkflow,
  );
}

describe("development team orchestration", () => {
  test("creates the feature branch after approval and finalizes Git after QA", async () => {
    const directory = await newRun();
    const state = await loadRunState(directory);
    state.gitWorkflow = gitWorkflowStateFactory();
    await saveRunState(directory, state);
    const events: string[] = [];
    const workflow: RepositoryWorkflow = {
      prepare(): Promise<GitWorkflowState | null> {
        return Promise.resolve(null);
      },
      createFeatureBranch(run, featureId): Promise<void> {
        events.push(`branch:${featureId}:${run.currentRole}`);

        return Promise.resolve();
      },
      finalize(run): Promise<void> {
        events.push(`finalize:${run.status}:${run.currentRole}`);

        return Promise.resolve();
      },
    };

    await runDevelopmentTeam(
      new ScriptedAgentRunner(),
      directory,
      new AutomaticSpecificationReviewer(),
      new FileSpecificationJournal(),
      undefined,
      workflow,
    );

    expect(events).toEqual([
      `branch:deliver-a-generic-feature:${Role.Architect}`,
      `finalize:${RunStatus.Completed}:null`,
    ]);
  });

  test("retries a failed final Git step without another agent turn", async () => {
    const directory = await newRun();
    const state = await loadRunState(directory);
    state.gitWorkflow = gitWorkflowStateFactory();
    await saveRunState(directory, state);
    let finalizationAttempts = 0;
    const workflow: RepositoryWorkflow = {
      prepare: () => Promise.resolve(null),
      createFeatureBranch: () => Promise.resolve(),
      finalize(run): Promise<void> {
        finalizationAttempts += 1;

        if (finalizationAttempts === 1) {
          run.gitWorkflow!.failedStep = GitWorkflowStep.Push;
          run.gitWorkflow!.failure = "push failed";
          throw new Error("push failed");
        }

        run.gitWorkflow!.failedStep = null;
        run.gitWorkflow!.failure = null;

        return Promise.resolve();
      },
    };

    const failed = await runDevelopmentTeam(
      new ScriptedAgentRunner(),
      directory,
      new AutomaticSpecificationReviewer(),
      new FileSpecificationJournal(),
      undefined,
      workflow,
    );
    const resumed = await runDevelopmentTeam(
      new ScriptedAgentRunner(),
      directory,
      new AutomaticSpecificationReviewer(),
      new FileSpecificationJournal(),
      undefined,
      workflow,
    );

    expect(failed.status).toBe(RunStatus.Failed);
    expect(resumed.status).toBe(RunStatus.Completed);
    expect(resumed.turns).toBe(7);
    expect(finalizationAttempts).toBe(2);
  });

  test("persists every handoff and completes only after QA", async () => {
    const harness = await DevelopmentTeamHarness.create(temporary);
    const result = await harness.run();

    expect(result.status).toBe(RunStatus.Completed);
    expect(result.turns).toBe(7);
    expect(result.messages.map(({ from, to }) => [from, to])).toEqual([
      ["user", Role.Specifier],
      [Role.Specifier, Role.Architect],
      [Role.Architect, Role.UiDesigner],
      [Role.UiDesigner, Role.DataEngineer],
      [Role.DataEngineer, Role.BackendCoder],
      [Role.BackendCoder, Role.FrontendCoder],
      [Role.FrontendCoder, Role.Qa],
      [Role.Qa, null],
    ]);
    expect(result.specificationReviews).toHaveLength(1);
    expect(result.workspaceBootstrap).toMatchObject({
      status: "skipped",
      template: "web-app",
      templateVersion: 1,
    });
    expect(result.specificationReviews[0]?.decision).toBe(SpecificationReviewDecision.Approved);
    expect(result.specificationReviews[0]?.publishedSpecification?.path).toBe(
      "specifications/000001-deliver-a-generic-feature.feature",
    );
    expect((await loadRunState(harness.runDirectory)).finalSummary).toContain("passed");
  });

  test("persists token totals and renders readable loop and handoff information", async () => {
    const directory = await newRun();
    const scripted = new ScriptedAgentRunner();
    const runner: AgentRunner = {
      async run(context) {
        return {
          turn: await scripted.run(context),
          usage: {
            inputTokens: 100,
            cachedInputTokens: 40,
            outputTokens: 20,
            reasoningOutputTokens: 5,
            totalTokens: 120,
          },
        };
      },
    };
    const result = await runDevelopmentTeam(
      runner,
      directory,
      new AutomaticSpecificationReviewer(),
      new FileSpecificationJournal(),
    );

    expect(result.tokenTotals.team.totalTokens).toBe(840);
    expect(result.tokenTotals.byRole[Role.Architect].totalTokens).toBe(120);
    expect(result.executions).toHaveLength(7);
    const architectLog = await readFile(
      resolve(directory, "logs", `${Role.Architect}.log`),
      "utf8",
    );
    expect(architectLog).toContain("SPECIFIER → ARCHITECT");
    expect(architectLog).toContain("ARCHITECT → UI-DESIGNER");
    expect(architectLog).toContain("ARCHITECT WORKING");
    expect(architectLog).toContain("THIS AGENT 120");
    expect(architectLog).toContain("TEAM 840");
  });

  test("skips UI and data specialists for a backend-only change", async () => {
    const directory = await newRun();
    const scripted = new ScriptedAgentRunner();
    const visited: string[] = [];
    const runner: AgentRunner = {
      async run(context) {
        visited.push(context.role);
        const turn = await scripted.run(context);

        if (turn.role === Role.Architect) {
          return {
            ...turn,
            changePlan: {
              ...turn.changePlan,
              dataRequired: false,
              frontendRequired: false,
            },
            nextRole: Role.Qa,
          };
        }

        if (turn.role === Role.BackendCoder) {
          return { ...turn, nextRole: Role.Qa };
        }

        return turn;
      },
    };

    const result = await runDevelopmentTeam(
      runner,
      directory,
      new AutomaticSpecificationReviewer(),
      new FileSpecificationJournal(),
    );

    expect(result.status).toBe(RunStatus.Completed);
    expect(visited).toEqual([Role.Specifier, Role.Architect, Role.BackendCoder, Role.Qa]);
  });

  test("fails closed when an agent invents a transition", async () => {
    const directory = await newRun();
    const invalidRunner: AgentRunner = {
      run: (): Promise<AgentTurn> =>
        Promise.resolve({
          role: Role.BackendCoder,
          summary: "skip ahead",
          changes: [],
          tests: [],
          apiProcedures: [],
          domainDecisions: [],
          artifacts: [],
          evidence: [],
          decision: TurnDecision.Handoff,
          nextRole: Role.Qa,
          reason: "faster",
        }),
    };

    expect(
      runDevelopmentTeam(
        invalidRunner,
        directory,
        new AutomaticSpecificationReviewer(),
        new FileSpecificationJournal(),
      ),
    ).rejects.toThrow("specifier returned a backend-coder turn");
    expect((await loadRunState(directory)).status).toBe(RunStatus.Failed);
  });

  test("stops feedback loops at the configured turn budget", async () => {
    const directory = await newRun(2);
    const loopRunner: AgentRunner = {
      run: ({ role }: AgentContext): Promise<AgentTurn> => {
        if (role === Role.Specifier) {
          return Promise.resolve({
            role,
            featureId: "clarify-behavior",
            summary: "needs another pass",
            specification:
              "Feature: Clarify behavior\n\n  Scenario: Pending clarification\n    Given an ambiguous request\n    When it is specified\n    Then the behavior is explicit",
            assumptions: ["The ambiguity can be resolved by the architect."],
            outOfScope: [],
            artifacts: [],
            evidence: [],
            decision: TurnDecision.Handoff,
            nextRole: Role.Architect,
            reason: "architectural review is needed",
          });
        }

        return Promise.resolve({
          role: Role.Architect,
          summary: "needs specification clarification",
          design: "No design until the ambiguity is resolved.",
          changePlan: {
            applicationName: "business-app",
            contexts: ["clarify-behavior"],
            dataRequired: false,
            backendRequired: true,
            frontendRequired: false,
          },
          domainModel: [],
          apiContract: [],
          security: [],
          constraints: [],
          risks: ["Ambiguous behavior."],
          artifacts: [],
          evidence: [],
          decision: TurnDecision.Handoff,
          nextRole: Role.Specifier,
          reason: "ambiguity remains",
        });
      },
    };

    expect(
      runDevelopmentTeam(
        loopRunner,
        directory,
        new AutomaticSpecificationReviewer(),
        new FileSpecificationJournal(),
      ),
    ).rejects.toThrow("Maximum turn count (2) reached");
    expect((await loadRunState(directory)).turns).toBe(2);
  });

  test("returns requested specification changes to the specifier", async () => {
    const directory = await newRun();
    let reviewCount = 0;
    const reviewer: SpecificationReviewer = {
      review: () => {
        reviewCount += 1;

        return Promise.resolve(
          reviewCount === 1
            ? {
                decision: SpecificationReviewDecision.ChangesRequested,
                feedback: "Add an explicit rejected-input example.",
              }
            : { decision: SpecificationReviewDecision.Approved, feedback: null },
        );
      },
    };
    const result = await runDevelopmentTeam(
      new ScriptedAgentRunner(),
      directory,
      reviewer,
      new FileSpecificationJournal(),
    );

    expect(result.status).toBe(RunStatus.Completed);
    expect(result.turns).toBe(8);
    expect(result.specificationReviews.map(({ decision }) => decision)).toEqual([
      SpecificationReviewDecision.ChangesRequested,
      SpecificationReviewDecision.Approved,
    ]);
    expect(result.specificationReviews[0]?.feedback).toContain("rejected-input");
    expect(result.messages.map(({ from, to }) => [from, to])).toEqual([
      ["user", Role.Specifier],
      [Role.Specifier, Role.Architect],
      [Role.Architect, Role.UiDesigner],
      [Role.UiDesigner, Role.DataEngineer],
      [Role.DataEngineer, Role.BackendCoder],
      [Role.BackendCoder, Role.FrontendCoder],
      [Role.FrontendCoder, Role.Qa],
      [Role.Qa, null],
    ]);
  });

  test("returns invalid Gherkin to the specifier before asking the human", async () => {
    const directory = await newRun();
    const scripted = new ScriptedAgentRunner();
    let specifierRuns = 0;
    let reviews = 0;
    const runner: AgentRunner = {
      async run(context) {
        const turn = await scripted.run(context);

        if (
          context.role === Role.Specifier &&
          ++specifierRuns === 1 &&
          turn.role === Role.Specifier
        ) {
          return {
            ...turn,
            specification: "Feature: Incomplete\nScenario: Missing steps",
          };
        }

        return turn;
      },
    };
    const reviewer: SpecificationReviewer = {
      review() {
        reviews += 1;

        return Promise.resolve({
          decision: SpecificationReviewDecision.Approved,
          feedback: null,
        });
      },
    };

    const result = await runDevelopmentTeam(
      runner,
      directory,
      reviewer,
      new FileSpecificationJournal(),
    );

    expect(result.turns).toBe(8);
    expect(reviews).toBe(1);
    expect(
      result.localChecks.filter(({ kind }) => kind === "gherkin").map(({ passed }) => passed),
    ).toEqual([false, true]);
  });

  test("returns a failed local quality gate directly to the backend coder", async () => {
    const directory = await newRun();
    const state = await loadRunState(directory);
    await mkdir(resolve(state.workspace, "src", "contexts", "decisions", "domain"), {
      recursive: true,
    });
    const scripted = new ScriptedAgentRunner();
    let coderRuns = 0;
    let qaRuns = 0;
    const runner: AgentRunner = {
      async run(context) {
        const turn = await scripted.run(context);

        if (context.role === Role.Qa) {
          qaRuns += 1;
        }

        if (context.role !== Role.BackendCoder || turn.role !== Role.BackendCoder) {
          return turn;
        }

        coderRuns += 1;
        const path = resolve(
          context.state.workspace,
          "src",
          "contexts",
          "decisions",
          "domain",
          "decision.ts",
        );
        const source =
          coderRuns === 1
            ? `export function decide(values: boolean[]): number {
  let result = 0;
  ${Array.from({ length: 11 }, (_, index) => `if (values[${index}]) result += 1;`).join("\n  ")}
  return result;
}\n`
            : "export const decide = (value: boolean): number => value ? 1 : 0;\n";
        await writeFile(path, source);

        return {
          turn: {
            ...turn,
            artifacts: ["src/contexts/decisions/domain/decision.ts"],
          },
          usage: null,
          observations: { commands: [], changedFiles: [path] },
        };
      },
    };

    const result = await runDevelopmentTeam(
      runner,
      directory,
      new AutomaticSpecificationReviewer(),
      new FileSpecificationJournal(),
    );

    expect(coderRuns).toBe(2);
    expect(qaRuns).toBe(1);
    expect(
      result.localChecks
        .filter(({ kind, role }) => kind === "quality-gate" && role === Role.BackendCoder)
        .map(({ passed }) => passed),
    ).toEqual([false, true]);
  });
});

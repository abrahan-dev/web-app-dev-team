import { describe, expect, test } from "bun:test";
import { processQualityPhase } from "../../../src/application/development/turn-phases.ts";
import type {
  DevelopmentServices,
  QualityGateOptions,
} from "../../../src/application/ports/development-services.ts";
import { DevelopmentRun } from "../../../src/domain/run/development-run.ts";
import type { AgentTurn, LocalCheck } from "../../../src/domain/schemas.ts";
import { Role } from "../../../src/domain/roles.ts";
import { TurnDecision } from "../../../src/domain/workflow-values.ts";
import {
  backendHandoffFactory,
  qaCompletionFactory,
  runStateFactory,
} from "../../support/domain-factories.ts";

function services(passed: boolean, requests: QualityGateOptions[]): DevelopmentServices {
  return {
    runRepository: {
      load: () => Promise.reject(new Error("load is not used")),
      save: () => Promise.resolve(),
    },
    workspaceInventory: {
      load: (workspace) =>
        Promise.resolve({
          workspace,
          packageManager: "bun",
          scripts: { "test:coverage": "bun test --coverage" },
          sourceRoots: ["src"],
          testRoots: ["test"],
          topLevelDirectories: ["src", "test"],
          configFiles: ["package.json", "bunfig.toml"],
          architectureBaseline: [],
        }),
      refresh: () => Promise.reject(new Error("refresh is not used")),
    },
    qualityGate: {
      run(options) {
        requests.push(options);

        return Promise.resolve({
          sequence: options.sequence,
          turn: options.turn,
          role: options.role,
          kind: "quality-gate",
          createdAt: "2026-08-09T00:00:00.000Z",
          passed,
          summary: passed ? "Coverage passed." : "Coverage failed.",
          details: passed ? [] : ["Coverage is below the configured limit."],
          commands: [
            {
              command: "bun run test:coverage",
              exitCode: passed ? 0 : 1,
              output: "coverage result",
            },
          ],
        } satisfies LocalCheck);
      },
    },
    operatorLog: {
      turnStarted: () => Promise.resolve(),
      turnCompleted: () => Promise.resolve(),
      humanReviewRequested: () => Promise.resolve(),
      specificationReview: () => Promise.resolve(),
      handoff: () => Promise.resolve(),
      runFailure: () => Promise.resolve(),
      localCheck: () => Promise.resolve(),
      workspaceBootstrap: () => Promise.resolve(),
    },
  };
}

describe("development quality phase", () => {
  test("runs core scripts without browser tests after a backend turn", async () => {
    const run = DevelopmentRun.restore(runStateFactory());
    const backend = backendHandoffFactory();

    if (backend.role !== Role.BackendCoder) {
      throw new Error("The backend factory returned an invalid role.");
    }

    const turn: AgentTurn = {
      ...backend,
      nextRole: Role.Architect,
    };
    const requests: QualityGateOptions[] = [];

    const result = await processQualityPhase({
      accepted: { role: Role.BackendCoder, turn, result: null },
      turn,
      runDirectory: "/tmp/run",
      run,
      services: services(true, requests),
    });

    expect(result.repeatRole).toBe(false);
    expect(requests).toMatchObject([
      {
        role: Role.BackendCoder,
        runScripts: true,
        runBrowserTests: false,
        runCoverage: false,
      },
    ]);
  });

  test("returns failed final coverage to QA", async () => {
    const run = DevelopmentRun.restore(runStateFactory({ currentRole: Role.Qa }));
    const turn = qaCompletionFactory();
    const requests: QualityGateOptions[] = [];

    const result = await processQualityPhase({
      accepted: { role: Role.Qa, turn, result: null },
      turn,
      runDirectory: "/tmp/run",
      run,
      services: services(false, requests),
    });

    expect(result.repeatRole).toBe(true);
    expect(run.state.currentRole).toBe(Role.Qa);
    expect(requests).toMatchObject([
      { role: Role.Qa, runScripts: true, runBrowserTests: true, runCoverage: true },
    ]);
  });

  test("does not run coverage when QA reports an implementation failure", async () => {
    const run = DevelopmentRun.restore(runStateFactory({ currentRole: Role.Qa }));
    const completion = qaCompletionFactory();

    if (completion.role !== Role.Qa) {
      throw new Error("The QA factory returned an invalid role.");
    }

    const turn: AgentTurn = {
      ...completion,
      decision: TurnDecision.Handoff,
      nextRole: Role.BackendCoder,
      failures: ["The API returned an invalid response."],
      failureOwner: Role.BackendCoder,
    };
    const requests: QualityGateOptions[] = [];

    const result = await processQualityPhase({
      accepted: { role: Role.Qa, turn, result: null },
      turn,
      runDirectory: "/tmp/run",
      run,
      services: services(true, requests),
    });

    expect(result.repeatRole).toBe(false);
    expect(requests).toEqual([]);
  });
});

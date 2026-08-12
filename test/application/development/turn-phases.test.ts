import { describe, expect, test } from "bun:test";
import { processQualityPhase } from "../../../src/application/development/turn-phases.ts";
import type {
  DevelopmentServices,
  QualityGateOptions,
} from "../../../src/application/ports/development-services.ts";
import { DevelopmentRun } from "../../../src/domain/run/development-run.ts";
import type { AgentTurn, LocalCheck } from "../../../src/domain/schemas.ts";
import { Role } from "../../../src/domain/roles.ts";
import { RunStatus, TurnDecision } from "../../../src/domain/workflow-values.ts";
import {
  backendHandoffFactory,
  qaCompletionFactory,
  runStateFactory,
  tokenUsageFactory,
} from "../../support/domain-factories.ts";

function services(
  passed: boolean,
  requests: QualityGateOptions[],
  failureDetail = "Coverage is below the configured limit.",
  failureOwner?: Role,
): DevelopmentServices {
  return {
    runRepository: {
      load: () => Promise.reject(new Error("load is not used")),
      save: () => Promise.resolve(),
    },
    workspaceInventory: {
      load: (workspace) =>
        Promise.resolve({
          workspace,
          workspaceKind: "existing",
          packageManager: "bun",
          scripts: { "test:coverage": "bun test --coverage" },
          sourceRoots: ["src"],
          testRoots: ["test"],
          topLevelDirectories: ["src", "test"],
          configFiles: ["package.json", "bunfig.toml"],
          migrationFiles: [],
          architectureBaseline: [],
        }),
      refresh: (workspace) =>
        Promise.resolve({
          workspace,
          workspaceKind: "existing",
          packageManager: "bun",
          scripts: { "test:coverage": "bun test --coverage" },
          sourceRoots: ["src"],
          testRoots: ["test"],
          topLevelDirectories: ["src", "test"],
          configFiles: ["package.json", "bunfig.toml"],
          migrationFiles: [],
          architectureBaseline: [],
        }),
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
          details: passed ? [] : [failureDetail],
          findings:
            passed || !failureOwner
              ? []
              : [
                  {
                    code: "coverage-below-threshold",
                    owner: failureOwner,
                    file: "test/setup.ts",
                    metric: "functions",
                    actual: 0,
                    required: 80,
                    message: "test/setup.ts has 0% functions coverage. The required value is 80%.",
                  },
                ],
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
      runCancelled: () => Promise.resolve(),
      localCheck: () => Promise.resolve(),
      workspaceBootstrap: () => Promise.resolve(),
    },
  };
}

describe("development quality phase", () => {
  test("runs only role coverage after a backend turn", async () => {
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
        runScripts: false,
        runBrowserTests: false,
        runCoverage: true,
      },
    ]);
  });

  test("returns failed independent coverage verification to QA", async () => {
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

  test("returns failed coverage to the coder before QA", async () => {
    const run = DevelopmentRun.restore(runStateFactory({ currentRole: Role.BackendCoder }));
    const turn = backendHandoffFactory();
    const requests: QualityGateOptions[] = [];

    const result = await processQualityPhase({
      accepted: { role: Role.BackendCoder, turn, result: null },
      turn,
      runDirectory: "/tmp/run",
      run,
      services: services(false, requests),
    });

    expect(result.repeatRole).toBe(true);
    expect(run.state.currentRole).toBe(Role.BackendCoder);
    expect(requests).toMatchObject([
      {
        role: Role.BackendCoder,
        runScripts: false,
        runBrowserTests: false,
        runCoverage: true,
      },
    ]);
  });

  test("escalates three identical unchanged failures to the architect", async () => {
    const state = runStateFactory({ currentRole: Role.BackendCoder, turns: 3 });

    for (const turn of [1, 2, 3]) {
      state.executions.push({
        sequence: turn,
        turn,
        role: Role.BackendCoder,
        startedAt: `2026-08-09T00:0${turn}:00.000Z`,
        completedAt: `2026-08-09T00:0${turn}:30.000Z`,
        status: RunStatus.Completed as const,
        usage: tokenUsageFactory(),
        commands: [],
        changedFiles: [],
      });
    }

    for (const turn of [1, 2]) {
      state.localChecks.push({
        sequence: turn,
        turn,
        role: Role.BackendCoder,
        kind: "quality-gate",
        createdAt: `2026-08-09T00:0${turn}:31.000Z`,
        passed: false,
        summary: "Coverage failed.",
        details: [
          `bun --config=/tmp/web-app-dev-team-coverage-${turn} test exited 1: failure [${turn}.00ms]`,
        ],
        findings: [
          {
            code: "coverage-below-threshold",
            owner: Role.BackendCoder,
            file: "test/setup.ts",
            metric: "functions",
            actual: 0,
            required: 80,
            message: `Variable diagnostic text ${turn}.`,
          },
        ],
        commands: [
          {
            command: "bun run test:coverage",
            exitCode: 1,
            output: "coverage result",
          },
        ],
      });
    }

    const run = DevelopmentRun.restore(state);
    const turn = backendHandoffFactory();
    const requests: QualityGateOptions[] = [];
    const failure =
      "bun --config=/tmp/web-app-dev-team-coverage-current test exited 1: failure [3ms]";
    const result = await processQualityPhase({
      accepted: { role: Role.BackendCoder, turn, result: null },
      turn,
      runDirectory: "/tmp/run",
      run,
      services: services(false, requests, failure, Role.BackendCoder),
    });

    expect(result.repeatRole).toBe(false);
    expect(result.turn.nextRole).toBe(Role.Architect);
    expect(result.turn.reason).toContain("occurred 3 times without file changes");
  });

  test("does not escalate repeated failures after a file change", async () => {
    const state = runStateFactory({ currentRole: Role.BackendCoder, turns: 3 });

    for (const turn of [1, 2, 3]) {
      state.executions.push({
        sequence: turn,
        turn,
        role: Role.BackendCoder,
        startedAt: `2026-08-09T00:0${turn}:00.000Z`,
        completedAt: `2026-08-09T00:0${turn}:30.000Z`,
        status: RunStatus.Completed as const,
        usage: null,
        commands: [],
        changedFiles: turn === 3 ? ["src/backend.ts"] : [],
      });
    }

    for (const turn of [1, 2]) {
      state.localChecks.push({
        sequence: turn,
        turn,
        role: Role.BackendCoder,
        kind: "quality-gate",
        createdAt: `2026-08-09T00:0${turn}:31.000Z`,
        passed: false,
        summary: "Coverage failed.",
        details: ["same failure"],
        commands: [
          {
            command: "bun run test:coverage",
            exitCode: 1,
            output: "coverage result",
          },
        ],
      });
    }

    const run = DevelopmentRun.restore(state);
    const turn = backendHandoffFactory();
    const requests: QualityGateOptions[] = [];
    const result = await processQualityPhase({
      accepted: { role: Role.BackendCoder, turn, result: null },
      turn,
      runDirectory: "/tmp/run",
      run,
      services: services(false, requests, "same failure"),
    });

    expect(result.repeatRole).toBe(true);
    expect(run.state.currentRole).toBe(Role.BackendCoder);
  });

  test("routes a foreign deterministic failure to the architect", async () => {
    const run = DevelopmentRun.restore(runStateFactory({ currentRole: Role.BackendCoder }));
    const turn = backendHandoffFactory();
    const requests: QualityGateOptions[] = [];
    const result = await processQualityPhase({
      accepted: { role: Role.BackendCoder, turn, result: null },
      turn,
      runDirectory: "/tmp/run",
      run,
      services: services(false, requests, "Coverage failed.", Role.FrontendCoder),
    });

    expect(result.repeatRole).toBe(false);
    expect(result.turn.nextRole).toBe(Role.Architect);
    expect(result.turn.reason).toContain("belongs to frontend-coder, not backend-coder");
  });

  test("reserves final turns for architecture and QA", async () => {
    const state = runStateFactory({ currentRole: Role.BackendCoder, turns: 91, maxTurns: 100 });
    state.executions.push(
      ...Array.from({ length: 91 }, (_, index) => ({
        sequence: index + 1,
        turn: index + 1,
        role: Role.BackendCoder,
        startedAt: `2026-08-09T00:00:${String(index).padStart(2, "0")}.000Z`,
        completedAt: `2026-08-09T00:00:${String(index).padStart(2, "0")}.500Z`,
        status: RunStatus.Completed as const,
        usage: null,
        commands: [],
        changedFiles: ["src/apps/example/backend/server.ts"],
      })),
    );
    const run = DevelopmentRun.restore(state);
    const turn = backendHandoffFactory();
    const requests: QualityGateOptions[] = [];
    const result = await processQualityPhase({
      accepted: { role: Role.BackendCoder, turn, result: null },
      turn,
      runDirectory: "/tmp/run",
      run,
      services: services(false, requests),
    });

    expect(result.repeatRole).toBe(false);
    expect(result.turn.nextRole).toBe(Role.Architect);
    expect(result.turn.reason).toContain("Only 9 configured turns remain");
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

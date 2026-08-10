import { describe, expect, test } from "bun:test";
import { DevelopmentRun } from "../../../src/domain/run/development-run.ts";
import type { AgentTurn, LocalCheck, WorkspaceBootstrap } from "../../../src/domain/schemas.ts";
import { Role } from "../../../src/domain/roles.ts";
import { RunStatus, TurnDecision } from "../../../src/domain/workflow-values.ts";
import {
  backendHandoffFactory,
  qaCompletionFactory,
  runStateFactory,
  tokenUsageFactory,
} from "../../support/domain-factories.ts";

describe("development run aggregate", () => {
  test("records ordered executions and permits only QA completion", () => {
    const run = DevelopmentRun.restore(runStateFactory());
    const backend = backendHandoffFactory();

    run.recordExecution(Role.BackendCoder, "2026-08-09T00:00:00.000Z", null, {
      commands: [],
      changedFiles: [],
    });
    run.transition(Role.BackendCoder, backend);
    run.recordExecution(Role.Qa, "2026-08-09T00:01:00.000Z", null, {
      commands: [],
      changedFiles: [],
    });
    run.transition(Role.Qa, qaCompletionFactory());

    expect(run.state.status).toBe(RunStatus.Completed);
    expect(run.state.currentRole).toBeNull();
    expect(run.state.turns).toBe(2);
    expect(run.state.executions.map(({ sequence }) => sequence)).toEqual([1, 2]);
    expect(run.state.messages.map(({ sequence }) => sequence)).toEqual([0, 1, 2]);
  });

  test("rejects completion by a role other than QA", () => {
    const run = DevelopmentRun.restore(runStateFactory());
    const invalid = {
      ...backendHandoffFactory(),
      decision: TurnDecision.Complete,
      nextRole: null,
    } as unknown as AgentTurn;

    expect(() => run.transition(Role.BackendCoder, invalid)).toThrow("Only QA can complete a run");
  });

  test("rejects a state with a broken handoff sequence", () => {
    const state = runStateFactory();
    state.messages[0]!.sequence = 2;

    expect(() => DevelopmentRun.restore(state)).toThrow("Invalid handoff sequence");
  });

  test("records a failed attempt and resumes the active role", () => {
    const run = DevelopmentRun.restore(runStateFactory());
    const usage = tokenUsageFactory(12);

    run.recordFailedAttempt({
      role: Role.BackendCoder,
      startedAt: "2026-08-09T00:00:00.000Z",
      usage,
      executionRecorded: false,
      failure: "Agent connection failed.",
    });

    expect(run.state.status).toBe(RunStatus.Failed);
    expect(run.state.executions).toMatchObject([
      { sequence: 1, role: Role.BackendCoder, status: RunStatus.Failed },
    ]);
    expect(run.state.interruptions).toMatchObject([
      { sequence: 1, role: Role.BackendCoder, reason: "Agent connection failed." },
    ]);
    expect(run.state.tokenTotals.team.totalTokens).toBe(12);

    run.resume(8);

    expect(run.state.status).toBe(RunStatus.Running);
    expect(run.state.currentRole).toBe(Role.BackendCoder);
    expect(run.state.maxTurns).toBe(8);
    expect(run.state.failure).toBeNull();
  });

  test("rejects invalid state relationships", () => {
    expect(() =>
      DevelopmentRun.restore(runStateFactory({ status: RunStatus.Running, currentRole: null })),
    ).toThrow("must have a current role");

    expect(() => DevelopmentRun.restore(runStateFactory({ turns: 1, maxTurns: 1 }))).toThrow(
      "completed execution count",
    );
  });

  test("permits unlimited turns", () => {
    const run = DevelopmentRun.restore(runStateFactory({ maxTurns: 0 }));

    for (let turn = 0; turn < 20; turn += 1) {
      run.assertTurnAvailable();
    }

    expect(run.state.maxTurns).toBe(0);
  });

  test("rejects unordered checks and a duplicate bootstrap", () => {
    const run = DevelopmentRun.restore(runStateFactory());
    const check: LocalCheck = {
      sequence: 2,
      turn: 0,
      role: Role.BackendCoder,
      kind: "quality-gate",
      createdAt: "2026-08-09T00:00:00.000Z",
      passed: true,
      summary: "Passed.",
      details: [],
      commands: [],
    };

    expect(() => run.recordCheck(check)).toThrow("Expected local check sequence 1");

    const bootstrap: WorkspaceBootstrap = {
      template: "web-app",
      templateVersion: 1,
      status: "skipped",
      reason: "Existing content.",
      applicationName: "business-app",
      contexts: ["orders"],
      surfaces: ["backend"],
      persistence: false,
      createdAt: "2026-08-09T00:00:00.000Z",
      createdFiles: [],
      commands: [],
    };
    run.recordBootstrap(bootstrap);

    expect(() => run.recordBootstrap(bootstrap)).toThrow("already recorded");
  });

  test("rejects work from a role that is not active", () => {
    const run = DevelopmentRun.restore(runStateFactory());

    expect(() => run.transition(Role.FrontendCoder, backendHandoffFactory())).toThrow(
      "Only the active role",
    );
    expect(() => run.recordInterruption(Role.FrontendCoder, "Stopped.")).toThrow(
      "Cannot interrupt",
    );
  });
});

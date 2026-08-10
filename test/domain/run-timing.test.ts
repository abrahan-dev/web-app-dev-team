import { describe, expect, test } from "bun:test";
import { Role } from "../../src/domain/roles.ts";
import {
  formatCompactElapsed,
  formatElapsed,
  roleElapsedMilliseconds,
  runElapsedMilliseconds,
} from "../../src/domain/run-timing.ts";
import { RunStatus } from "../../src/domain/workflow-values.ts";
import { runStateFactory } from "../support/domain-factories.ts";

describe("run timing", () => {
  test("measures wall time from the initial prompt", () => {
    const state = runStateFactory();
    state.startedAt = "2026-08-10T10:00:00.000Z";

    expect(runElapsedMilliseconds(state, new Date("2026-08-10T10:03:04.000Z"))).toBe(184_000);
  });

  test("uses the initial handoff time for an old state", () => {
    const state = runStateFactory();
    state.startedAt = null;

    expect(runElapsedMilliseconds(state, new Date("2026-08-09T00:01:00.000Z"))).toBe(60_000);
  });

  test("stops wall time when a run completes", () => {
    const state = runStateFactory({ status: RunStatus.Completed, currentRole: null });
    state.startedAt = "2026-08-10T10:00:00.000Z";
    state.messages = [
      {
        id: "run-1-0001",
        sequence: 0,
        from: Role.Qa,
        to: null,
        createdAt: "2026-08-10T10:04:00.000Z",
        turn: null,
      },
    ];

    expect(runElapsedMilliseconds(state, new Date("2026-08-10T11:00:00.000Z"))).toBe(240_000);
  });

  test("adds prior and current work when a role becomes active again", () => {
    const state = runStateFactory({ currentRole: Role.BackendCoder });
    state.executions = [
      {
        sequence: 1,
        turn: 1,
        role: Role.BackendCoder,
        startedAt: "2026-08-10T10:00:00.000Z",
        completedAt: "2026-08-10T10:02:00.000Z",
        status: RunStatus.Completed,
        usage: null,
        commands: [],
        changedFiles: [],
      },
    ];
    state.activeExecutionStartedAt = "2026-08-10T10:05:00.000Z";

    expect(
      roleElapsedMilliseconds(state, Role.BackendCoder, new Date("2026-08-10T10:06:30.000Z")),
    ).toBe(210_000);
    expect(roleElapsedMilliseconds(state, Role.Qa, new Date("2026-08-10T10:06:30.000Z"))).toBe(0);
  });

  test("formats long and compact durations", () => {
    expect(formatElapsed(3_723_000)).toBe("1h 02m 03s");
    expect(formatCompactElapsed(3_723_000)).toBe("1h02m03s");
  });
});

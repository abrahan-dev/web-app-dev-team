import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { LocalCheck } from "../../../src/domain/schemas.ts";
import { Role } from "../../../src/domain/roles.ts";
import { recordTurnStarted } from "../../../src/infrastructure/observability/operator-log.ts";
import { runStateFactory } from "../../support/domain-factories.ts";
import { TemporaryWorkspaceManager } from "../../support/temporary-workspaces.ts";

const temporary = new TemporaryWorkspaceManager();

afterEach(async () => {
  await temporary.cleanup();
});

function check(sequence: number, passed: boolean): LocalCheck {
  return {
    sequence,
    turn: sequence,
    role: Role.FrontendCoder,
    kind: "quality-gate",
    createdAt: `2026-08-11T10:0${sequence}:00.000Z`,
    passed,
    summary: passed ? "Coverage passed." : "Coverage failed.",
    details: passed ? [] : ["main.tsx is missing from coverage."],
    commands: [],
  };
}

describe("operator correction log", () => {
  test("does not report a failed check after a later pass", async () => {
    const runDirectory = await temporary.create("web-app-dev-team-operator-log-");
    await mkdir(resolve(runDirectory, "logs"));
    const state = runStateFactory({ currentRole: Role.FrontendCoder });
    state.localChecks.push(check(1, false), check(2, true));

    await recordTurnStarted(runDirectory, state, Role.FrontendCoder);

    const summary = await readFile(resolve(runDirectory, "logs/summary.log"), "utf8");
    expect(summary).not.toContain("CORRECTION:");
    expect(summary).not.toContain("main.tsx is missing from coverage");
  });
});

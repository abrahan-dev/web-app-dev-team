import { describe, expect, test } from "bun:test";
import { Role } from "../../../src/domain/roles.ts";
import { RunStatus } from "../../../src/domain/workflow-values.ts";
import {
  paneActivityCommand,
  paneBorderFormat,
  paneIdentityCommands,
  paneStatus,
  paneSpinnerCommand,
  paneTimingCommands,
  roleColors,
  roleIsActive,
} from "../../../src/infrastructure/terminal/active-role-accent.ts";

describe("active role pane accent", () => {
  test("detects only the working role in a running state", () => {
    const running = JSON.stringify({ status: RunStatus.Running, currentRole: Role.Architect });
    const failed = JSON.stringify({ status: RunStatus.Failed, currentRole: Role.Architect });

    expect(roleIsActive(running, Role.Architect)).toBeTrue();
    expect(roleIsActive(running, Role.Specifier)).toBeFalse();
    expect(roleIsActive(failed, Role.Architect)).toBeFalse();
  });

  test("builds pane-local tmux commands", () => {
    expect(paneIdentityCommands("%7", Role.BackendCoder)).toEqual([
      ["tmux", "select-pane", "-t", "%7", "-T", "BACKEND-CODER"],
      ["tmux", "set-option", "-p", "-t", "%7", "@web_app_role_active", "0"],
      ["tmux", "set-option", "-p", "-t", "%7", "@web_app_role_elapsed", "0m00s"],
      ["tmux", "set-option", "-p", "-t", "%7", "@web_app_run_elapsed", "0m00s"],
      ["tmux", "set-option", "-p", "-t", "%7", "@web_app_spinner", "·"],
    ]);
    expect(paneActivityCommand("%7", true)).toEqual([
      "tmux",
      "set-option",
      "-p",
      "-t",
      "%7",
      "@web_app_role_active",
      "1",
    ]);
    expect(paneBorderFormat).toContain("● WORKING · #{pane_title}");
    expect(paneBorderFormat).toContain("ACTIVE #{@web_app_role_elapsed}");
    expect(paneBorderFormat).toContain("RUN #{@web_app_run_elapsed}");
    expect(paneBorderFormat).toContain("RUN #{@web_app_run_elapsed} · #{@web_app_spinner}");
    expect(paneBorderFormat).toContain(roleColors[Role.BackendCoder].tmux);
    expect(paneBorderFormat).toContain("BACKEND-CODER");
    expect(paneSpinnerCommand("%7", "··")).toEqual([
      "tmux",
      "set-option",
      "-p",
      "-t",
      "%7",
      "@web_app_spinner",
      "··",
    ]);
  });

  test("builds live timing values and commands", () => {
    const state = {
      version: 4,
      id: "run-1",
      startedAt: "2026-08-10T10:00:00.000Z",
      activeExecutionStartedAt: "2026-08-10T10:02:00.000Z",
      prompt: "Build an app.",
      workspace: "/tmp/app",
      status: RunStatus.Running,
      currentRole: Role.BackendCoder,
      turns: 0,
      maxTurns: 0,
      messages: [],
      specificationReviews: [],
      finalSummary: null,
      failure: null,
      mode: "delivery",
      targetSpecification: null,
      interruptions: [],
      tokenTotals: {
        team: {
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: 0,
        },
        byRole: Object.fromEntries(
          Object.values(Role).map((item) => [
            item,
            {
              inputTokens: 0,
              cachedInputTokens: 0,
              outputTokens: 0,
              reasoningOutputTokens: 0,
              totalTokens: 0,
            },
          ]),
        ),
      },
      executions: [],
      localChecks: [],
      workspaceBootstrap: null,
      gitWorkflow: null,
    };
    const status = paneStatus(
      JSON.stringify(state),
      Role.BackendCoder,
      new Date("2026-08-10T10:03:04.000Z"),
    );

    expect(status).toEqual({ active: true, roleElapsed: "1m04s", runElapsed: "3m04s" });
    expect(paneTimingCommands("%7", status)).toEqual([
      ["tmux", "set-option", "-p", "-t", "%7", "@web_app_role_elapsed", "1m04s"],
      ["tmux", "set-option", "-p", "-t", "%7", "@web_app_run_elapsed", "3m04s"],
    ]);
  });
});

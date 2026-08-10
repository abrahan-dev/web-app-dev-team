import { describe, expect, test } from "bun:test";
import { Role } from "../../../src/domain/roles.ts";
import { RunStatus } from "../../../src/domain/workflow-values.ts";
import {
  paneActivityCommand,
  paneBorderFormat,
  paneIdentityCommands,
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
    expect(paneBorderFormat).toContain(roleColors[Role.BackendCoder].tmux);
    expect(paneBorderFormat).toContain("BACKEND-CODER");
  });
});

import { Role, roles } from "../../domain/roles.ts";
import {
  formatCompactElapsed,
  roleElapsedMilliseconds,
  runElapsedMilliseconds,
} from "../../domain/run-timing.ts";
import type { RunState } from "../../domain/run/run-state.ts";
import { RunStatus } from "../../domain/workflow-values.ts";

export const roleColors: Record<Role, { ansi: string; tmux: string }> = {
  [Role.Specifier]: { ansi: "35", tmux: "colour13" },
  [Role.Architect]: { ansi: "34", tmux: "colour12" },
  [Role.UiDesigner]: { ansi: "35", tmux: "colour13" },
  [Role.DataEngineer]: { ansi: "36", tmux: "colour14" },
  [Role.BackendCoder]: { ansi: "33", tmux: "colour11" },
  [Role.FrontendCoder]: { ansi: "34", tmux: "colour12" },
  [Role.Qa]: { ansi: "32", tmux: "colour10" },
};

const inactivePaneLabel = roles.reduceRight(
  (fallback, role) =>
    `#{?#{==:#{pane_title},${role.toUpperCase()}},#[fg=${roleColors[role].tmux} bold] #{pane_title} · ACTIVE #{@web_app_role_elapsed} #[default],${fallback}}`,
  "#[fg=colour244] #{pane_title} #[default]",
);

export const paneBorderFormat = `#{?#{==:#{@web_app_role_active},1},#[fg=colour255 bg=colour236 bold] ● WORKING · #{pane_title} · ACTIVE #{@web_app_role_elapsed} · RUN #{@web_app_run_elapsed} · #{@web_app_spinner} #[default],${inactivePaneLabel}}`;

export interface PaneStatus {
  active: boolean;
  roleElapsed: string;
  runElapsed: string;
}

export function roleIsActive(stateContent: string, role: Role): boolean {
  const state = JSON.parse(stateContent) as { status?: unknown; currentRole?: unknown };

  return state.status === RunStatus.Running && state.currentRole === role;
}

export function paneStatus(stateContent: string, role: Role, now = new Date()): PaneStatus {
  const state = JSON.parse(stateContent) as RunState;

  return {
    active: state.status === RunStatus.Running && state.currentRole === role,
    roleElapsed: formatCompactElapsed(roleElapsedMilliseconds(state, role, now)),
    runElapsed: formatCompactElapsed(runElapsedMilliseconds(state, now)),
  };
}

export function paneIdentityCommands(pane: string, role: Role): string[][] {
  return [
    ["tmux", "select-pane", "-t", pane, "-T", role.toUpperCase()],
    ["tmux", "set-option", "-p", "-t", pane, "@web_app_role_active", "0"],
    ["tmux", "set-option", "-p", "-t", pane, "@web_app_role_elapsed", "0m00s"],
    ["tmux", "set-option", "-p", "-t", pane, "@web_app_run_elapsed", "0m00s"],
    ["tmux", "set-option", "-p", "-t", pane, "@web_app_spinner", "·"],
  ];
}

export function paneSpinnerCommand(pane: string, spinner: string): string[] {
  return ["tmux", "set-option", "-p", "-t", pane, "@web_app_spinner", spinner];
}

export function paneActivityCommand(pane: string, active: boolean): string[] {
  return ["tmux", "set-option", "-p", "-t", pane, "@web_app_role_active", active ? "1" : "0"];
}

export function paneTimingCommands(
  pane: string,
  status: Pick<PaneStatus, "roleElapsed" | "runElapsed">,
): string[][] {
  return [
    ["tmux", "set-option", "-p", "-t", pane, "@web_app_role_elapsed", status.roleElapsed],
    ["tmux", "set-option", "-p", "-t", pane, "@web_app_run_elapsed", status.runElapsed],
  ];
}

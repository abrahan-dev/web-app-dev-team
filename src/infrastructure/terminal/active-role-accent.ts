import { Role, roles } from "../../domain/roles.ts";
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
    `#{?#{==:#{pane_title},${role.toUpperCase()}},#[fg=${roleColors[role].tmux} bold] #{pane_title} #[default],${fallback}}`,
  "#[fg=colour244] #{pane_title} #[default]",
);

export const paneBorderFormat = `#{?#{==:#{@web_app_role_active},1},#[fg=colour255 bg=colour236 bold] ● WORKING · #{pane_title} #[default],${inactivePaneLabel}}`;

export function roleIsActive(stateContent: string, role: Role): boolean {
  const state = JSON.parse(stateContent) as { status?: unknown; currentRole?: unknown };

  return state.status === RunStatus.Running && state.currentRole === role;
}

export function paneIdentityCommands(pane: string, role: Role): string[][] {
  return [
    ["tmux", "select-pane", "-t", pane, "-T", role.toUpperCase()],
    ["tmux", "set-option", "-p", "-t", pane, "@web_app_role_active", "0"],
  ];
}

export function paneActivityCommand(pane: string, active: boolean): string[] {
  return ["tmux", "set-option", "-p", "-t", pane, "@web_app_role_active", active ? "1" : "0"];
}

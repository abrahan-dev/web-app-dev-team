import { Role } from "../../domain/roles.ts";
import { RunStatus } from "../../domain/workflow-values.ts";

export const paneBorderFormat =
  "#{?#{==:#{@web_app_role_active},1},#[fg=colour255 bg=colour236 bold] ● WORKING · #{pane_title} #[default],#[fg=colour244] #{pane_title} #[default]}";

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

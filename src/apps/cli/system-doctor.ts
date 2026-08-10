import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { resolve } from "node:path";

export type DoctorStatus = "PASS" | "WARNING" | "FAIL";

export interface DoctorCheck {
  status: DoctorStatus;
  name: string;
  detail: string;
}

function commandCheck(name: string): DoctorCheck {
  const path = Bun.which(name);

  return path
    ? { status: "PASS", name, detail: path }
    : { status: "FAIL", name, detail: `${name} is not available in PATH.` };
}

function run(command: string[]): { success: boolean; output: string } {
  const result = Bun.spawnSync(command, { stderr: "pipe", stdout: "pipe" });
  const output = `${result.stdout.toString()}${result.stderr.toString()}`.trim();

  return { success: result.exitCode === 0, output };
}

async function workspaceCheck(workspace: string): Promise<DoctorCheck> {
  try {
    await access(workspace, constants.R_OK | constants.W_OK);

    return { status: "PASS", name: "workspace", detail: workspace };
  } catch {
    return {
      status: "FAIL",
      name: "workspace",
      detail: `${workspace} is not readable and writable.`,
    };
  }
}

function repositoryCheck(workspace: string): DoctorCheck {
  const result = run(["git", "-C", workspace, "rev-parse", "--show-toplevel"]);

  return result.success
    ? { status: "PASS", name: "Git repository", detail: result.output }
    : {
        status: "WARNING",
        name: "Git repository",
        detail: "The workspace is not a Git repository.",
      };
}

function codexAuthenticationCheck(): DoctorCheck {
  const result = run(["codex", "login", "status"]);

  return result.success
    ? { status: "PASS", name: "Codex authentication", detail: result.output }
    : {
        status: "FAIL",
        name: "Codex authentication",
        detail: result.output || "Codex is not authenticated.",
      };
}

export async function inspectSystem(workspaceValue: string): Promise<DoctorCheck[]> {
  const workspace = resolve(workspaceValue);
  const platformSupported = process.platform === "darwin" || process.platform === "linux";
  const checks: DoctorCheck[] = [
    {
      status: platformSupported ? "PASS" : "FAIL",
      name: "platform",
      detail: `${process.platform}/${process.arch}`,
    },
    { status: "PASS", name: "Bun", detail: Bun.version },
    commandCheck("tmux"),
    commandCheck("git"),
    commandCheck("codex"),
    await workspaceCheck(workspace),
  ];

  if (Bun.which("git")) {
    checks.push(repositoryCheck(workspace));
  }

  if (Bun.which("codex")) {
    checks.push(codexAuthenticationCheck());
  }

  if (process.env.WEB_APP_DEV_TEAM_CREATE_PR === "on") {
    checks.push(
      commandCheck(process.env.WEB_APP_DEV_TEAM_GITHUB_MCP_COMMAND ?? "github-mcp-server"),
    );
  } else {
    checks.push({
      status: "WARNING",
      name: "pull request creation",
      detail: "Automatic pull request creation is disabled.",
    });
  }

  return checks;
}

export function renderDoctorChecks(checks: DoctorCheck[]): string {
  return checks
    .map(({ status, name, detail }) => `${status.padEnd(7)} ${name}: ${detail}`)
    .join("\n");
}

import {
  NoRepositoryWorkflow,
  type PullRequestPublisher,
  type RepositoryWorkflow,
} from "../../application/ports/repository-workflow.ts";
import { BunGitCommandRunner } from "./git-command-runner.ts";
import { GitHubMcpPullRequestPublisher } from "./github-mcp-publisher.ts";
import { DeterministicRepositoryWorkflow } from "./repository-workflow.ts";

export type GitWorkflowMode = "on" | "off" | "auto";

function mode(value = process.env.WEB_APP_DEV_TEAM_GIT_WORKFLOW ?? "auto"): GitWorkflowMode {
  if (value === "on" || value === "off" || value === "auto") {
    return value;
  }

  throw new Error("WEB_APP_DEV_TEAM_GIT_WORKFLOW must be on, off, or auto.");
}

function pullRequestPublisher(): PullRequestPublisher | null {
  if (process.env.WEB_APP_DEV_TEAM_CREATE_PR !== "on") {
    return null;
  }

  const rawArguments = JSON.parse(
    process.env.WEB_APP_DEV_TEAM_GITHUB_MCP_ARGS ?? '["stdio","--tools=create_pull_request"]',
  ) as unknown;

  if (!Array.isArray(rawArguments) || !rawArguments.every((value) => typeof value === "string")) {
    throw new Error("WEB_APP_DEV_TEAM_GITHUB_MCP_ARGS must be a JSON string array.");
  }

  return new GitHubMcpPullRequestPublisher({
    command: process.env.WEB_APP_DEV_TEAM_GITHUB_MCP_COMMAND ?? "github-mcp-server",
    arguments_: rawArguments,
  });
}

export function createRepositoryWorkflow(): RepositoryWorkflow {
  const selectedMode = mode();

  if (selectedMode === "off") {
    return new NoRepositoryWorkflow();
  }

  return new DeterministicRepositoryWorkflow(new BunGitCommandRunner(), {
    mode: selectedMode,
    remote: process.env.WEB_APP_DEV_TEAM_GIT_REMOTE ?? "origin",
    baseBranch: process.env.WEB_APP_DEV_TEAM_GIT_BASE_BRANCH ?? "main",
    pullRequestPublisher: pullRequestPublisher(),
  });
}

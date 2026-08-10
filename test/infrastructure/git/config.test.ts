import { afterEach, describe, expect, test } from "bun:test";
import { NoRepositoryWorkflow } from "../../../src/application/ports/repository-workflow.ts";
import {
  createRepositoryWorkflow,
  parseGitWorkflowMode,
  parseMcpArguments,
  pullRequestCreationEnabled,
} from "../../../src/infrastructure/git/config.ts";

const originalMode = process.env.WEB_APP_DEV_TEAM_GIT_WORKFLOW;
const originalPullRequestCreation = process.env.WEB_APP_DEV_TEAM_CREATE_PR;

afterEach(() => {
  if (originalMode === undefined) {
    delete process.env.WEB_APP_DEV_TEAM_GIT_WORKFLOW;
  } else {
    process.env.WEB_APP_DEV_TEAM_GIT_WORKFLOW = originalMode;
  }

  if (originalPullRequestCreation === undefined) {
    delete process.env.WEB_APP_DEV_TEAM_CREATE_PR;
  } else {
    process.env.WEB_APP_DEV_TEAM_CREATE_PR = originalPullRequestCreation;
  }
});

describe("Git workflow configuration", () => {
  test("accepts the supported workflow modes", () => {
    expect(["on", "off", "auto"].map(parseGitWorkflowMode)).toEqual(["on", "off", "auto"]);
    expect(() => parseGitWorkflowMode("invalid")).toThrow("must be on, off, or auto");
  });

  test("validates MCP arguments", () => {
    expect(parseMcpArguments('["stdio","--tools=create_pull_request"]')).toEqual([
      "stdio",
      "--tools=create_pull_request",
    ]);
    expect(() => parseMcpArguments("{}")).toThrow("JSON string array");
    expect(() => parseMcpArguments('["stdio",1]')).toThrow("JSON string array");
  });

  test("enables pull request creation by default", () => {
    delete process.env.WEB_APP_DEV_TEAM_CREATE_PR;

    expect(pullRequestCreationEnabled()).toBe(true);
    expect(pullRequestCreationEnabled("on")).toBe(true);
    expect(pullRequestCreationEnabled("off")).toBe(false);
    expect(() => pullRequestCreationEnabled("invalid")).toThrow("must be on or off");
  });

  test("disables the repository workflow", () => {
    process.env.WEB_APP_DEV_TEAM_GIT_WORKFLOW = "off";

    expect(createRepositoryWorkflow()).toBeInstanceOf(NoRepositoryWorkflow);
  });
});

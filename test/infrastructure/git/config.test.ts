import { afterEach, describe, expect, test } from "bun:test";
import { NoRepositoryWorkflow } from "../../../src/application/ports/repository-workflow.ts";
import {
  createRepositoryWorkflow,
  parseGitWorkflowMode,
  parseMcpArguments,
} from "../../../src/infrastructure/git/config.ts";

const originalMode = process.env.WEB_APP_DEV_TEAM_GIT_WORKFLOW;

afterEach(() => {
  if (originalMode === undefined) {
    delete process.env.WEB_APP_DEV_TEAM_GIT_WORKFLOW;
  } else {
    process.env.WEB_APP_DEV_TEAM_GIT_WORKFLOW = originalMode;
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

  test("disables the repository workflow", () => {
    process.env.WEB_APP_DEV_TEAM_GIT_WORKFLOW = "off";

    expect(createRepositoryWorkflow()).toBeInstanceOf(NoRepositoryWorkflow);
  });
});

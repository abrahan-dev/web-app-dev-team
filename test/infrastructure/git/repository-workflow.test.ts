import { afterEach, describe, expect, test } from "bun:test";
import type {
  GitCommandResult,
  GitCommandRunner,
  PullRequestPublisher,
  PullRequestRequest,
} from "../../../src/application/ports/repository-workflow.ts";
import { DeterministicRepositoryWorkflow } from "../../../src/infrastructure/git/repository-workflow.ts";
import { createRunState } from "../../../src/infrastructure/persistence/file-run-store.ts";
import { gitWorkflowStateFactory } from "../../support/domain-factories.ts";
import { TemporaryWorkspaceManager } from "../../support/temporary-workspaces.ts";

const temporary = new TemporaryWorkspaceManager();

afterEach(async () => {
  await temporary.cleanup();
});

class FakeGitRunner implements GitCommandRunner {
  readonly commands: string[] = [];
  readonly responses = new Map<string, { exitCode: number; output?: string }>();

  run(arguments_: string[]): Promise<GitCommandResult> {
    const key = arguments_.join(" ");
    const response = this.responses.get(key) ?? { exitCode: 0, output: "" };
    this.commands.push(key);

    return Promise.resolve({
      command: ["git", ...arguments_],
      exitCode: response.exitCode,
      output: response.output ?? "",
    });
  }
}

async function workspace(): Promise<string> {
  return temporary.create("web-app-dev-team-git-");
}

describe("deterministic repository workflow", () => {
  test("updates main with fast-forward only and requires a clean tree", async () => {
    const root = await workspace();
    const runner = new FakeGitRunner();
    runner.responses.set("rev-parse --show-toplevel", { exitCode: 0, output: root });
    runner.responses.set("remote get-url origin", {
      exitCode: 0,
      output: "git@github.com:example/business-app.git",
    });
    runner.responses.set("rev-parse HEAD", { exitCode: 0, output: "base-sha" });
    const workflow = new DeterministicRepositoryWorkflow(runner, {
      mode: "on",
      remote: "origin",
      baseBranch: "main",
      pullRequestPublisher: null,
    });

    const state = await workflow.prepare(root);

    expect(state).toMatchObject({ baseCommit: "base-sha", baseBranch: "main" });
    expect(runner.commands).toContain("fetch origin main");
    expect(runner.commands).toContain("switch main");
    expect(runner.commands).toContain("merge --ff-only origin/main");
  });

  test("stops before fetch when the working tree is not clean", async () => {
    const root = await workspace();
    const runner = new FakeGitRunner();
    runner.responses.set("rev-parse --show-toplevel", { exitCode: 0, output: root });
    runner.responses.set("status --porcelain", {
      exitCode: 0,
      output: " M src/order.ts",
    });
    const workflow = new DeterministicRepositoryWorkflow(runner, {
      mode: "on",
      remote: "origin",
      baseBranch: "main",
      pullRequestPublisher: null,
    });

    expect(workflow.prepare(root)).rejects.toThrow("clean working tree");
    expect(runner.commands).not.toContain("fetch origin main");
  });

  test("creates, commits, pushes, and publishes a template-based pull request", async () => {
    const root = await workspace();
    const runner = new FakeGitRunner();
    runner.responses.set("show-ref --verify --quiet refs/heads/feat/approve-orders", {
      exitCode: 1,
    });
    runner.responses.set("show-ref --verify --quiet refs/remotes/origin/feat/approve-orders", {
      exitCode: 1,
    });
    runner.responses.set("diff --cached --quiet", { exitCode: 1 });
    runner.responses.set("rev-parse HEAD", { exitCode: 0, output: "commit-sha" });
    const requests: PullRequestRequest[] = [];
    const publisher: PullRequestPublisher = {
      create(value) {
        requests.push(value);

        return Promise.resolve({ url: "https://github.com/example/business-app/pull/7" });
      },
    };
    const workflow = new DeterministicRepositoryWorkflow(runner, {
      mode: "on",
      remote: "origin",
      baseBranch: "main",
      pullRequestPublisher: publisher,
    });
    const created = await createRunState({
      prompt: "Approve orders",
      workspace: root,
      runsRoot: root,
      maxTurns: 12,
      gitWorkflow: gitWorkflowStateFactory(),
    });

    await workflow.createFeatureBranch(created.state, "approve-orders");
    await workflow.finalize(created.state);

    expect(created.state.gitWorkflow).toMatchObject({
      featureBranch: "feat/approve-orders",
      commitSha: "commit-sha",
      pullRequestUrl: "https://github.com/example/business-app/pull/7",
    });
    expect(runner.commands).toContain("commit -m feat: implement approve-orders");
    expect(runner.commands).toContain("push --set-upstream origin feat/approve-orders");
    expect(requests[0]).toMatchObject({
      title: "feat: implement approve-orders",
      baseBranch: "main",
      featureBranch: "feat/approve-orders",
    });
    expect(requests[0]?.body).toContain("## What");
    expect(requests[0]?.body).toContain("Implements `approve-orders`");
  });
});

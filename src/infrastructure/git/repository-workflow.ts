import { resolve } from "node:path";
import type { GitWorkflowState, RunState } from "../../domain/schemas.ts";
import { GitWorkflowStatus, GitWorkflowStep } from "../../domain/workflow-values.ts";
import type {
  GitCommandResult,
  GitCommandRunner,
  PullRequestPublisher,
  RepositoryWorkflow,
} from "../../application/ports/repository-workflow.ts";
import { renderPullRequestBody } from "./pull-request-template.ts";

interface RepositoryWorkflowOptions {
  mode: "on" | "off" | "auto";
  remote: string;
  baseBranch: string;
  pullRequestPublisher: PullRequestPublisher | null;
}

function commandText(result: GitCommandResult): string {
  return result.command.join(" ");
}

function githubRepository(remoteUrl: string): { owner: string; repository: string } {
  const match = remoteUrl.match(
    /github\.com(?::|\/)(?<owner>[^/]+)\/(?<repository>[^/]+?)(?:\.git)?$/,
  );

  const owner = match?.groups?.owner;
  const repository = match?.groups?.repository;

  if (!owner || !repository) {
    throw new Error(`The remote is not a GitHub repository: ${remoteUrl}`);
  }

  return {
    owner,
    repository,
  };
}

function shortRunId(runId: string): string {
  return (runId.split("-")[0] ?? runId).slice(-8);
}

export class DeterministicRepositoryWorkflow implements RepositoryWorkflow {
  constructor(
    private readonly runner: GitCommandRunner,
    private readonly options: RepositoryWorkflowOptions,
  ) {}

  private async git(arguments_: string[], workspace: string): Promise<GitCommandResult> {
    return this.runner.run(arguments_, workspace);
  }

  private async require(arguments_: string[], workspace: string): Promise<string> {
    const result = await this.git(arguments_, workspace);

    if (result.exitCode !== 0) {
      throw new Error(
        `${commandText(result)} failed with code ${result.exitCode}: ${result.output || "no output"}`,
      );
    }

    return result.output;
  }

  async prepare(workspace: string): Promise<GitWorkflowState | null> {
    if (this.options.mode === "off") {
      return null;
    }

    const repositoryCheck = await this.git(["rev-parse", "--show-toplevel"], workspace);

    if (repositoryCheck.exitCode !== 0 && this.options.mode === "auto") {
      return null;
    }

    if (repositoryCheck.exitCode !== 0) {
      throw new Error("The Git workflow requires a Git repository.");
    }

    if (resolve(repositoryCheck.output) !== resolve(workspace)) {
      throw new Error("The Git workflow requires the workspace to be the repository root.");
    }

    const changes = await this.require(["status", "--porcelain"], workspace);

    if (changes) {
      throw new Error("The Git workflow requires a clean working tree.");
    }

    const remoteUrl = await this.require(["remote", "get-url", this.options.remote], workspace);
    await this.require(["fetch", this.options.remote, this.options.baseBranch], workspace);
    await this.require(["switch", this.options.baseBranch], workspace);
    await this.require(
      ["merge", "--ff-only", `${this.options.remote}/${this.options.baseBranch}`],
      workspace,
    );
    const baseCommit = await this.require(["rev-parse", "HEAD"], workspace);

    return {
      status: GitWorkflowStatus.Prepared,
      remote: this.options.remote,
      remoteUrl,
      baseBranch: this.options.baseBranch,
      baseCommit,
      featureBranch: null,
      featureId: null,
      commitSha: null,
      pushedAt: null,
      pullRequestUrl: null,
      failedStep: null,
      failure: null,
    };
  }

  private async branchName(state: RunState, featureId: string): Promise<string> {
    const git = state.gitWorkflow;

    if (!git) {
      throw new Error("Git workflow state is not available.");
    }

    const initial = `feat/${featureId}`;
    const refs = [`refs/heads/${initial}`, `refs/remotes/${git.remote}/${initial}`];
    const checks = await Promise.all(
      refs.map((ref) => this.git(["show-ref", "--verify", "--quiet", ref], state.workspace)),
    );

    return checks.some(({ exitCode }) => exitCode === 0)
      ? `${initial}-${shortRunId(state.id)}`
      : initial;
  }

  async createFeatureBranch(state: RunState, featureId: string): Promise<void> {
    const git = state.gitWorkflow;

    if (!git || git.featureBranch) {
      return;
    }

    try {
      const branch = await this.branchName(state, featureId);
      await this.require(["switch", "-c", branch], state.workspace);
      git.featureId = featureId;
      git.featureBranch = branch;
      git.status = GitWorkflowStatus.Branched;
      git.failedStep = null;
      git.failure = null;
    } catch (error) {
      this.fail(git, GitWorkflowStep.CreateBranch, error);
      throw error;
    }
  }

  private fail(git: GitWorkflowState, step: GitWorkflowStep, error: unknown): void {
    git.status = GitWorkflowStatus.Failed;
    git.failedStep = step;
    git.failure = error instanceof Error ? error.message : String(error);
  }

  private async commit(state: RunState): Promise<void> {
    const git = state.gitWorkflow;

    if (!git || git.commitSha || !git.featureId) {
      return;
    }

    await this.require(["add", "-A", "--", ".", ":(exclude).web-app-dev-team"], state.workspace);
    const staged = await this.git(["diff", "--cached", "--quiet"], state.workspace);

    if (staged.exitCode === 0) {
      throw new Error("The Git workflow found no changes to commit.");
    }

    if (staged.exitCode !== 1) {
      throw new Error("The Git workflow could not inspect the staged changes.");
    }

    await this.require(["commit", "-m", `feat: implement ${git.featureId}`], state.workspace);
    git.commitSha = await this.require(["rev-parse", "HEAD"], state.workspace);
    git.status = GitWorkflowStatus.Committed;
  }

  private async push(state: RunState): Promise<void> {
    const git = state.gitWorkflow;

    if (!git || git.pushedAt || !git.featureBranch) {
      return;
    }

    await this.require(["push", "--set-upstream", git.remote, git.featureBranch], state.workspace);
    git.pushedAt = new Date().toISOString();
    git.status = GitWorkflowStatus.Pushed;
  }

  private async createPullRequest(state: RunState): Promise<void> {
    const git = state.gitWorkflow;

    if (!git || git.pullRequestUrl) {
      return;
    }

    if (!this.options.pullRequestPublisher) {
      git.status = GitWorkflowStatus.Pushed;

      return;
    }

    if (!git.featureBranch || !git.featureId) {
      throw new Error("The pull request requires a feature branch and feature ID.");
    }

    const repository = githubRepository(git.remoteUrl);
    const result = await this.options.pullRequestPublisher.create({
      owner: repository.owner,
      repository: repository.repository,
      baseBranch: git.baseBranch,
      featureBranch: git.featureBranch,
      title: `feat: implement ${git.featureId}`,
      body: await renderPullRequestBody(state),
    });
    git.pullRequestUrl = result.url;
    git.status = GitWorkflowStatus.PullRequestCreated;
  }

  async finalize(state: RunState): Promise<void> {
    const git = state.gitWorkflow;

    if (!git) {
      return;
    }

    try {
      await this.commit(state);
      await this.push(state);
      await this.createPullRequest(state);
      git.failedStep = null;
      git.failure = null;
    } catch (error) {
      const step = !git.commitSha
        ? GitWorkflowStep.Commit
        : !git.pushedAt
          ? GitWorkflowStep.Push
          : GitWorkflowStep.CreatePullRequest;
      this.fail(git, step, error);
      throw error;
    }
  }
}

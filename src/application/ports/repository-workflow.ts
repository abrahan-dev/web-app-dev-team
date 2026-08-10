import type { GitWorkflowState, RunState } from "../../domain/schemas.ts";

export interface GitCommandResult {
  command: string[];
  exitCode: number;
  output: string;
}

export interface GitCommandRunner {
  run(arguments_: string[], workspace: string): Promise<GitCommandResult>;
}

export interface PullRequestRequest {
  owner: string;
  repository: string;
  baseBranch: string;
  featureBranch: string;
  title: string;
  body: string;
}

export interface PullRequestPublisher {
  verify(): Promise<void>;
  create(request: PullRequestRequest): Promise<{ url: string }>;
}

export interface RepositoryWorkflow {
  prepare(workspace: string): Promise<GitWorkflowState | null>;
  createFeatureBranch(state: RunState, featureId: string): Promise<void>;
  finalize(state: RunState): Promise<void>;
}

export class NoRepositoryWorkflow implements RepositoryWorkflow {
  prepare(): Promise<null> {
    return Promise.resolve(null);
  }

  createFeatureBranch(): Promise<void> {
    return Promise.resolve();
  }

  finalize(): Promise<void> {
    return Promise.resolve();
  }
}

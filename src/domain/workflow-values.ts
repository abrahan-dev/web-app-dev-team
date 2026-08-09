export enum TurnDecision {
  Handoff = "handoff",
  Complete = "complete",
}

export enum RunStatus {
  Running = "running",
  Completed = "completed",
  Failed = "failed",
}

export enum SpecificationReviewDecision {
  Approved = "approved",
  ChangesRequested = "changes_requested",
}

export enum RestitutionStatus {
  Running = RunStatus.Running,
  Interrupted = "interrupted",
  Completed = RunStatus.Completed,
}

export enum GitWorkflowStatus {
  Prepared = "prepared",
  Branched = "branched",
  Committed = "committed",
  Pushed = "pushed",
  PullRequestCreated = "pull-request-created",
  Failed = "failed",
}

export enum GitWorkflowStep {
  CreateBranch = "create-branch",
  Commit = "commit",
  Push = "push",
  CreatePullRequest = "create-pull-request",
}

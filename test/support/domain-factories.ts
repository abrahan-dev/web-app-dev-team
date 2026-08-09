import {
  runStateSchema,
  type AgentTurn,
  type GitWorkflowState,
  type PublishedSpecification,
  type RestitutionState,
  type RunState,
  type TokenUsage,
} from "../../src/domain/schemas.ts";
import { Role } from "../../src/domain/roles.ts";
import { emptyTokenTotals } from "../../src/domain/token-usage.ts";
import {
  GitWorkflowStatus,
  RestitutionStatus,
  RunStatus,
  TurnDecision,
} from "../../src/domain/workflow-values.ts";

export function tokenUsageFactory(totalTokens = 10): TokenUsage {
  return {
    inputTokens: totalTokens - 2,
    cachedInputTokens: 0,
    outputTokens: 2,
    reasoningOutputTokens: 0,
    totalTokens,
  };
}

export function gitWorkflowStateFactory(): GitWorkflowState {
  return {
    status: GitWorkflowStatus.Prepared,
    remote: "origin",
    remoteUrl: "git@github.com:example/business-app.git",
    baseBranch: "main",
    baseCommit: "base-sha",
    featureBranch: null,
    featureId: null,
    commitSha: null,
    pushedAt: null,
    pullRequestUrl: null,
    failedStep: null,
    failure: null,
  };
}

export function publishedSpecificationFactory(sequence = 1): PublishedSpecification {
  const featureId = `feature-${sequence}`;

  return {
    sequence,
    featureId,
    path: `specifications/${String(sequence).padStart(6, "0")}-${featureId}.feature`,
    createdAt: "2026-08-09T00:00:00.000Z",
    sha256: "a".repeat(64),
    sourceReviewId: `review-${sequence}`,
  };
}

interface RunStateFactoryOptions {
  status?: RunStatus;
  currentRole?: Role | null;
  turns?: number;
  maxTurns?: number;
  workspace?: string;
  gitWorkflow?: GitWorkflowState | null;
}

export function runStateFactory(options: RunStateFactoryOptions = {}): RunState {
  const status = options.status ?? RunStatus.Running;
  const currentRole = options.currentRole === undefined ? Role.BackendCoder : options.currentRole;

  return runStateSchema.parse({
    version: 4,
    id: "run-1",
    prompt: "Implement a feature.",
    workspace: options.workspace ?? "/tmp/project",
    status,
    currentRole,
    turns: options.turns ?? 0,
    maxTurns: options.maxTurns ?? 8,
    messages:
      currentRole === null
        ? []
        : [
            {
              id: "run-1-0000",
              sequence: 0,
              from: "user",
              to: currentRole,
              createdAt: "2026-08-09T00:00:00.000Z",
              turn: null,
            },
          ],
    specificationReviews: [],
    finalSummary: status === RunStatus.Completed ? "Complete." : null,
    failure: status === RunStatus.Failed ? "Test failure." : null,
    gitWorkflow: options.gitWorkflow ?? null,
  });
}

export function restitutionStateFactory(count = 2): RestitutionState {
  return {
    version: 1,
    id: "restitution-1",
    workspace: "/tmp/project",
    sourceSpecifications: "/tmp/specifications",
    status: RestitutionStatus.Running,
    specifications: Array.from({ length: count }, (_, index) =>
      publishedSpecificationFactory(index + 1),
    ),
    nextSequence: 1,
    currentSequence: null,
    resumeRole: null,
    completedSequences: [],
    maxTurnsPerSpecification: 8,
    failure: null,
    tokenTotals: emptyTokenTotals(),
  };
}

export function backendHandoffFactory(): AgentTurn {
  return {
    role: Role.BackendCoder,
    summary: "Implemented the backend.",
    changes: ["Added the use case."],
    tests: ["Added a unit test."],
    apiProcedures: ["Added feature.create."],
    domainDecisions: ["Kept validation in the domain."],
    artifacts: ["src/contexts/feature/application/create.ts"],
    evidence: ["bun test: exit 0"],
    decision: TurnDecision.Handoff,
    nextRole: Role.Qa,
    reason: "The backend is ready for QA.",
  };
}

export function qaCompletionFactory(): AgentTurn {
  return {
    role: Role.Qa,
    summary: "All acceptance checks passed.",
    scenariosTested: ["Create a feature."],
    commands: ["bun test"],
    failures: [],
    failureOwner: null,
    artifacts: [],
    evidence: ["bun test: exit 0"],
    decision: TurnDecision.Complete,
    nextRole: null,
    reason: "The run meets the approved specification.",
  };
}

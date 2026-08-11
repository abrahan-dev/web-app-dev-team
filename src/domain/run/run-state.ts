import { z } from "zod";
import { Role, roles } from "../roles.ts";
import { agentTurnSchema, featureIdSchema, roleSchema } from "../agent/agent-turn.ts";
import {
  publishedSpecificationSchema,
  specificationReviewSchema,
} from "../specification/specification.ts";
import { GitWorkflowStatus, GitWorkflowStep, RunStatus } from "../workflow-values.ts";

export const tokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningOutputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});
export type TokenUsage = z.infer<typeof tokenUsageSchema>;

export const tokenTotalsSchema = z.object({
  team: tokenUsageSchema,
  byRole: z.object({
    [Role.Specifier]: tokenUsageSchema,
    [Role.Architect]: tokenUsageSchema,
    [Role.UiDesigner]: tokenUsageSchema,
    [Role.DataEngineer]: tokenUsageSchema,
    [Role.BackendCoder]: tokenUsageSchema,
    [Role.FrontendCoder]: tokenUsageSchema,
    [Role.Qa]: tokenUsageSchema,
  }),
});
export type TokenTotals = z.infer<typeof tokenTotalsSchema>;

export const agentExecutionSchema = z.object({
  sequence: z.number().int().positive(),
  turn: z.number().int().positive(),
  role: roleSchema,
  startedAt: z.string(),
  completedAt: z.string(),
  status: z.enum([RunStatus.Completed, RunStatus.Failed]).default(RunStatus.Completed),
  usage: tokenUsageSchema.nullable(),
  commands: z
    .array(
      z.object({
        command: z.string(),
        exitCode: z.number().int().nullable(),
        startedAt: z.string().optional(),
        durationMs: z.number().int().nonnegative().optional(),
        outputBytes: z.number().int().nonnegative().optional(),
      }),
    )
    .default([]),
  changedFiles: z.array(z.string()).default([]),
});
export type AgentExecution = z.infer<typeof agentExecutionSchema>;

export const localCommandResultSchema = z.object({
  command: z.string(),
  exitCode: z.number().int(),
  output: z.string(),
  startedAt: z.string().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  outputBytes: z.number().int().nonnegative().optional(),
});
export type LocalCommandResult = z.infer<typeof localCommandResultSchema>;

export const localCheckSchema = z.object({
  sequence: z.number().int().positive(),
  turn: z.number().int().positive(),
  role: roleSchema,
  kind: z.enum(["gherkin", "quality-gate"]),
  createdAt: z.string(),
  passed: z.boolean(),
  summary: z.string(),
  details: z.array(z.string()),
  commands: z.array(localCommandResultSchema),
});
export type LocalCheck = z.infer<typeof localCheckSchema>;

export const workspaceBootstrapSchema = z.object({
  template: z.literal("web-app"),
  templateVersion: z.literal(1),
  status: z.enum(["created", "skipped"]),
  reason: z.string().min(1),
  applicationName: featureIdSchema,
  contexts: z.array(featureIdSchema).min(1),
  surfaces: z.array(z.enum(["backend", "frontend"])),
  persistence: z.boolean(),
  createdAt: z.string(),
  createdFiles: z.array(z.string()),
  commands: z.array(localCommandResultSchema),
});
export type WorkspaceBootstrap = z.infer<typeof workspaceBootstrapSchema>;

export const architectureReviewStatuses = [
  "not-started",
  "pending",
  "changes-requested",
  "approved",
] as const;
export const architectureReviewStatusSchema = z.enum(architectureReviewStatuses);
export type ArchitectureReviewStatus = z.infer<typeof architectureReviewStatusSchema>;

export const handoffSchema = z.object({
  id: z.string(),
  sequence: z.number().int().nonnegative(),
  from: z.union([roleSchema, z.literal("user")]),
  to: roleSchema.nullable(),
  createdAt: z.string(),
  turn: agentTurnSchema.nullable(),
});
export type Handoff = z.infer<typeof handoffSchema>;

export const interruptionSchema = z.object({
  sequence: z.number().int().positive(),
  role: roleSchema,
  turn: z.number().int().positive(),
  createdAt: z.string(),
  reason: z.string().min(1),
  logPath: z.string().min(1),
});
export type Interruption = z.infer<typeof interruptionSchema>;

export const gitWorkflowStateSchema = z.object({
  status: z.enum(GitWorkflowStatus),
  remote: z.string().min(1),
  remoteUrl: z.string().min(1),
  baseBranch: z.string().min(1),
  baseCommit: z.string().min(1),
  featureBranch: z.string().nullable(),
  featureId: featureIdSchema.nullable(),
  commitSha: z.string().nullable(),
  pushedAt: z.string().nullable(),
  pullRequestUrl: z.string().nullable(),
  failedStep: z.enum(GitWorkflowStep).nullable(),
  failure: z.string().nullable(),
});
export type GitWorkflowState = z.infer<typeof gitWorkflowStateSchema>;

export const runStateSchema = z.object({
  version: z.literal(4),
  id: z.string(),
  startedAt: z.string().nullable().default(null),
  activeExecutionStartedAt: z.string().nullable().default(null),
  prompt: z.string().min(1),
  workspace: z.string().min(1),
  status: z.enum(RunStatus),
  currentRole: roleSchema.nullable(),
  turns: z.number().int().nonnegative(),
  maxTurns: z.number().int().nonnegative(),
  messages: z.array(handoffSchema),
  specificationReviews: z.array(specificationReviewSchema).default([]),
  finalSummary: z.string().nullable(),
  failure: z.string().nullable(),
  mode: z.enum(["delivery", "restitution"]).default("delivery"),
  targetSpecification: publishedSpecificationSchema.nullable().default(null),
  interruptions: z.array(interruptionSchema).default([]),
  tokenTotals: tokenTotalsSchema.default(() => ({
    team: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
    },
    byRole: Object.fromEntries(
      roles.map((role) => [
        role,
        {
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: 0,
        },
      ]),
    ) as Record<Role, TokenUsage>,
  })),
  executions: z.array(agentExecutionSchema).default([]),
  localChecks: z.array(localCheckSchema).default([]),
  workspaceBootstrap: workspaceBootstrapSchema.nullable().default(null),
  architectureReviewStatus: architectureReviewStatusSchema.default("not-started"),
  gitWorkflow: gitWorkflowStateSchema.nullable().default(null),
});
export type RunState = z.infer<typeof runStateSchema>;

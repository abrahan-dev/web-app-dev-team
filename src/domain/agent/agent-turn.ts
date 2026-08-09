import { z } from "zod";
import { Role, roles } from "../roles.ts";
import { TurnDecision } from "../workflow-values.ts";

export const roleSchema = z.enum(roles);
export const featureIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Must be a lowercase kebab-case ID.");

const agentTurnBaseSchema = z.object({
  summary: z.string().min(1),
  artifacts: z.array(z.string()),
  evidence: z.array(z.string()),
  reason: z.string().min(1),
});

export const specifierTurnSchema = agentTurnBaseSchema.extend({
  role: z.literal(Role.Specifier),
  featureId: featureIdSchema,
  specification: z.string().min(1),
  assumptions: z.array(z.string()),
  outOfScope: z.array(z.string()),
  decision: z.literal(TurnDecision.Handoff),
  nextRole: z.literal(Role.Architect),
});
export type SpecifierTurn = z.infer<typeof specifierTurnSchema>;

export const changePlanSchema = z
  .object({
    applicationName: featureIdSchema,
    contexts: z.array(featureIdSchema).min(1),
    dataRequired: z.boolean(),
    backendRequired: z.boolean(),
    frontendRequired: z.boolean(),
  })
  .refine(
    ({ dataRequired, backendRequired, frontendRequired }) =>
      dataRequired || backendRequired || frontendRequired,
    "At least one implementation surface is required.",
  );
export type ChangePlan = z.infer<typeof changePlanSchema>;

export const architectTurnSchema = agentTurnBaseSchema.extend({
  role: z.literal(Role.Architect),
  design: z.string().min(1),
  changePlan: changePlanSchema,
  domainModel: z.array(z.string()),
  apiContract: z.array(z.string()),
  security: z.array(z.string()),
  constraints: z.array(z.string()),
  risks: z.array(z.string()),
  decision: z.literal(TurnDecision.Handoff),
  nextRole: z.enum([
    Role.Specifier,
    Role.UiDesigner,
    Role.DataEngineer,
    Role.BackendCoder,
    Role.FrontendCoder,
    Role.Qa,
  ]),
});
export type ArchitectTurn = z.infer<typeof architectTurnSchema>;

export const uiDesignerTurnSchema = agentTurnBaseSchema.extend({
  role: z.literal(Role.UiDesigner),
  screens: z.array(z.string()),
  interactions: z.array(z.string()),
  interfaceStates: z.array(z.string()),
  accessibility: z.array(z.string()),
  decision: z.literal(TurnDecision.Handoff),
  nextRole: z.enum([
    Role.Architect,
    Role.DataEngineer,
    Role.BackendCoder,
    Role.FrontendCoder,
    Role.Qa,
  ]),
});
export type UiDesignerTurn = z.infer<typeof uiDesignerTurnSchema>;

export const dataEngineerTurnSchema = agentTurnBaseSchema.extend({
  role: z.literal(Role.DataEngineer),
  schemaChanges: z.array(z.string()),
  migrations: z.array(z.string()),
  persistenceMappings: z.array(z.string()),
  tests: z.array(z.string()),
  decision: z.literal(TurnDecision.Handoff),
  nextRole: z.enum([Role.Architect, Role.BackendCoder, Role.FrontendCoder, Role.Qa]),
});
export type DataEngineerTurn = z.infer<typeof dataEngineerTurnSchema>;

export const backendCoderTurnSchema = agentTurnBaseSchema.extend({
  role: z.literal(Role.BackendCoder),
  changes: z.array(z.string()),
  tests: z.array(z.string()),
  apiProcedures: z.array(z.string()),
  domainDecisions: z.array(z.string()),
  decision: z.literal(TurnDecision.Handoff),
  nextRole: z.enum([Role.Architect, Role.FrontendCoder, Role.Qa]),
});
export type BackendCoderTurn = z.infer<typeof backendCoderTurnSchema>;

export const frontendCoderTurnSchema = agentTurnBaseSchema.extend({
  role: z.literal(Role.FrontendCoder),
  changes: z.array(z.string()),
  tests: z.array(z.string()),
  screens: z.array(z.string()),
  apiUsage: z.array(z.string()),
  decision: z.literal(TurnDecision.Handoff),
  nextRole: z.enum([Role.Architect, Role.Qa]),
});
export type FrontendCoderTurn = z.infer<typeof frontendCoderTurnSchema>;

export const qaTurnSchema = agentTurnBaseSchema.extend({
  role: z.literal(Role.Qa),
  scenariosTested: z.array(z.string()),
  commands: z.array(z.string()),
  failures: z.array(z.string()),
  failureOwner: z
    .enum([Role.Architect, Role.DataEngineer, Role.BackendCoder, Role.FrontendCoder])
    .nullable(),
  decision: z.enum(TurnDecision),
  nextRole: z
    .enum([Role.Architect, Role.DataEngineer, Role.BackendCoder, Role.FrontendCoder])
    .nullable(),
});
export type QaTurn = z.infer<typeof qaTurnSchema>;

export const agentTurnSchema = z.discriminatedUnion("role", [
  specifierTurnSchema,
  architectTurnSchema,
  uiDesignerTurnSchema,
  dataEngineerTurnSchema,
  backendCoderTurnSchema,
  frontendCoderTurnSchema,
  qaTurnSchema,
]);
export type AgentTurn = z.infer<typeof agentTurnSchema>;

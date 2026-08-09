import type { AgentContext, AgentRunner } from "../../../application/ports/agent-runner.ts";
import type { AgentTurn } from "../../../domain/schemas.ts";
import { Role } from "../../../domain/roles.ts";
import { TurnDecision } from "../../../domain/workflow-values.ts";

const turns: Record<Role, AgentTurn> = {
  [Role.Specifier]: {
    role: Role.Specifier,
    featureId: "generic-feature",
    summary: "Defined observable behavior and acceptance criteria.",
    specification:
      "Feature: Deliver a generic feature\n\n  Scenario: Complete the requested behavior\n    Given a valid request\n    When the feature is exercised\n    Then the requested behavior is observable",
    assumptions: [],
    outOfScope: [],
    artifacts: [],
    evidence: ["The request has one cohesive user-visible behavior."],
    decision: TurnDecision.Handoff,
    nextRole: Role.Architect,
    reason: "The behavior is precise enough for technical design.",
  },
  [Role.Architect]: {
    role: Role.Architect,
    summary: "Closed the feature as a full-stack business application slice.",
    design: "Implement one domain context, a tRPC API, SQLite persistence and a React UI.",
    changePlan: {
      applicationName: "business-app",
      contexts: ["generic-feature"],
      dataRequired: true,
      backendRequired: true,
      frontendRequired: true,
    },
    domainModel: ["GenericFeature aggregate owns its invariant."],
    apiContract: ["genericFeature.complete mutation validates input with Zod."],
    security: ["The procedure requires an authenticated actor."],
    constraints: ["Dependencies point toward src/contexts/*/domain."],
    risks: [],
    artifacts: [],
    evidence: ["Every Gherkin outcome is assigned to an implementation surface."],
    decision: TurnDecision.Handoff,
    nextRole: Role.UiDesigner,
    reason: "The UI contract must be described before implementation.",
  },
  [Role.UiDesigner]: {
    role: Role.UiDesigner,
    summary: "Defined the business UI interaction contract.",
    screens: ["Feature workspace with a primary completion form."],
    interactions: ["Submit the valid request and show the resulting identifier."],
    interfaceStates: ["loading", "empty", "error", "success"],
    accessibility: ["The form is labelled and keyboard operable."],
    artifacts: [],
    evidence: ["All observable Gherkin outcomes have a visible UI state."],
    decision: TurnDecision.Handoff,
    nextRole: Role.DataEngineer,
    reason: "The persistence stage is required by the technical plan.",
  },
  [Role.DataEngineer]: {
    role: Role.DataEngineer,
    summary: "Implemented the SQLite schema and reversible migration.",
    schemaChanges: ["Added the generic_features table with explicit constraints."],
    migrations: ["Added a versioned Drizzle SQL migration."],
    persistenceMappings: ["Implemented the domain repository with Drizzle."],
    tests: ["Migrated an empty SQLite database and exercised the repository."],
    artifacts: ["drizzle/0001_generic_feature.sql"],
    evidence: ["Migration and repository tests pass."],
    decision: TurnDecision.Handoff,
    nextRole: Role.BackendCoder,
    reason: "Persistence is ready for backend integration.",
  },
  [Role.BackendCoder]: {
    role: Role.BackendCoder,
    summary: "Implemented the domain use case and documented tRPC API.",
    changes: ["Added the requested domain and application behavior."],
    tests: ["Added unit, integration and API contract tests."],
    apiProcedures: ["genericFeature.complete"],
    domainDecisions: ["Kept the invariant inside the aggregate."],
    artifacts: ["src/contexts/generic-feature", "src/apps/business-app/backend"],
    evidence: ["Backend tests and OpenAPI generation pass."],
    decision: TurnDecision.Handoff,
    nextRole: Role.FrontendCoder,
    reason: "The typed API is ready for UI integration.",
  },
  [Role.FrontendCoder]: {
    role: Role.FrontendCoder,
    summary: "Implemented the accessible React interface against tRPC.",
    changes: ["Added the feature screen and all specified interface states."],
    tests: ["Added focused component tests."],
    screens: ["Generic feature workspace."],
    apiUsage: ["Calls genericFeature.complete through the typed tRPC client."],
    artifacts: ["src/apps/business-app/frontend"],
    evidence: ["Frontend tests pass."],
    decision: TurnDecision.Handoff,
    nextRole: Role.Qa,
    reason: "The complete user journey is ready for independent QA.",
  },
  [Role.Qa]: {
    role: Role.Qa,
    summary: "Acceptance behavior passed through the browser.",
    scenariosTested: ["Complete the requested behavior"],
    commands: ["bun run test:e2e"],
    failures: [],
    failureOwner: null,
    artifacts: ["test/e2e/generic-feature.spec.ts"],
    evidence: ["Playwright: 1 pass, 0 fail"],
    decision: TurnDecision.Complete,
    nextRole: null,
    reason: "All acceptance criteria have executable end-to-end evidence.",
  },
};

export class ScriptedAgentRunner implements AgentRunner {
  run(context: AgentContext): Promise<AgentTurn> {
    return Promise.resolve(turns[context.role]);
  }
}

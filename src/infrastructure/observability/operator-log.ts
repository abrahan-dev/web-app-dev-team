import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  roles,
  type AgentTurn,
  type Handoff,
  type LocalCheck,
  type RunState,
  type SpecificationReview,
  type SpecifierTurn,
  type TokenUsage,
  type WorkspaceBootstrap,
} from "../../domain/schemas.ts";
import { Role } from "../../domain/roles.ts";
import { SpecificationReviewDecision } from "../../domain/workflow-values.ts";

const rule = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";

function count(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function label(role: Role | null): string {
  return role?.toUpperCase() ?? "COMPLETE";
}

function lines(title: string, values: string[]): string {
  if (values.length === 0) {
    return `  ${title}: none`;
  }

  return [`  ${title}:`, ...values.map((value) => `    • ${value}`)].join("\n");
}

function block(title: string, value: string): string {
  return [`  ${title}:`, ...value.split("\n").map((line) => `    ${line}`)].join("\n");
}

function deliverable(turn: AgentTurn): string {
  switch (turn.role) {
    case Role.Specifier:
      return [
        `  Feature: ${turn.featureId}`,
        block("Gherkin", turn.specification),
        lines("Assumptions", turn.assumptions),
        lines("Out of scope", turn.outOfScope),
      ].join("\n");
    case Role.Architect:
      return [
        block("Design", turn.design),
        `  Application: ${turn.changePlan.applicationName}`,
        `  Surfaces: data=${turn.changePlan.dataRequired} · backend=${turn.changePlan.backendRequired} · frontend=${turn.changePlan.frontendRequired}`,
        lines("Contexts", turn.changePlan.contexts),
        lines("Domain model", turn.domainModel),
        lines("API contract", turn.apiContract),
        lines("Security", turn.security),
        lines("Constraints", turn.constraints),
        lines("Risks", turn.risks),
      ].join("\n");
    case Role.UiDesigner:
      return [
        lines("Screens", turn.screens),
        lines("Interactions", turn.interactions),
        lines("Interface states", turn.interfaceStates),
        lines("Accessibility", turn.accessibility),
      ].join("\n");
    case Role.DataEngineer:
      return [
        lines("Schema", turn.schemaChanges),
        lines("Migrations", turn.migrations),
        lines("Persistence mappings", turn.persistenceMappings),
        lines("Tests", turn.tests),
      ].join("\n");
    case Role.BackendCoder:
      return [
        lines("Changes", turn.changes),
        lines("Tests", turn.tests),
        lines("API procedures", turn.apiProcedures),
        lines("Domain decisions", turn.domainDecisions),
      ].join("\n");
    case Role.FrontendCoder:
      return [
        lines("Changes", turn.changes),
        lines("Tests", turn.tests),
        lines("Screens", turn.screens),
        lines("API usage", turn.apiUsage),
      ].join("\n");
    case Role.Qa:
      return [
        lines("Scenarios", turn.scenariosTested),
        lines("Commands", turn.commands),
        lines("Failures", turn.failures),
      ].join("\n");
  }
}

async function appendRole(runDirectory: string, role: Role, message: string): Promise<void> {
  await appendFile(resolve(runDirectory, "logs", `${role}.log`), `${message}\n`);
}

async function appendEveryRole(
  runDirectory: string,
  messageFor: (role: Role) => string,
): Promise<void> {
  await Promise.all(roles.map((role) => appendRole(runDirectory, role, messageFor(role))));
}

function tokenStatus(state: RunState, paneRole: Role): string {
  return `TOKENS  THIS AGENT ${count(state.tokenTotals.byRole[paneRole].totalTokens)}  ·  TEAM ${count(state.tokenTotals.team.totalTokens)}`;
}

export async function recordTurnStarted(
  runDirectory: string,
  state: RunState,
  activeRole: Role,
): Promise<void> {
  await appendEveryRole(
    runDirectory,
    (paneRole) =>
      `\n${rule}\n▶ TURN ${state.turns + 1}/${state.maxTurns}  ·  ${label(activeRole)} WORKING\n${tokenStatus(state, paneRole)}\n${rule}`,
  );
}

export async function recordTurnCompleted(
  runDirectory: string,
  state: RunState,
  activeRole: Role,
  usage: TokenUsage | null,
): Promise<void> {
  const turnTokens = usage ? `${count(usage.totalTokens)} tokens` : "tokens unavailable";

  await appendEveryRole(
    runDirectory,
    (paneRole) =>
      `\n✓ TURN ${state.turns}/${state.maxTurns}  ·  ${label(activeRole)} FINISHED  ·  ${turnTokens}\n${tokenStatus(state, paneRole)}`,
  );
}

export async function recordHumanReviewRequested(
  runDirectory: string,
  specification: SpecifierTurn,
): Promise<void> {
  await appendEveryRole(
    runDirectory,
    () =>
      `\n⏸ HUMAN REVIEW  ·  ${specification.featureId}\n  The specification is waiting for approval or change feedback.`,
  );
}

export async function recordSpecificationReview(
  runDirectory: string,
  review: SpecificationReview,
): Promise<void> {
  const outcome =
    review.decision === SpecificationReviewDecision.Approved
      ? `APPROVED  ·  ${review.publishedSpecification.path}`
      : `CHANGES REQUESTED  ·  ${review.feedback}`;

  await appendEveryRole(
    runDirectory,
    () => `\n◆ HUMAN REVIEW  ·  ${review.specification.featureId}  ·  ${outcome}`,
  );
}

export async function recordHandoff(runDirectory: string, handoff: Handoff): Promise<void> {
  if (handoff.turn === null || handoff.from === "user") {
    return;
  }

  const from = handoff.from;
  const to = handoff.to;
  const heading = `${label(from)} → ${label(to)}`;
  const full = [
    `\n╭─ HANDOFF #${handoff.sequence}  ·  ${heading}`,
    `  Summary: ${handoff.turn.summary}`,
    `  Reason: ${handoff.turn.reason}`,
    deliverable(handoff.turn),
    lines("Artifacts", handoff.turn.artifacts),
    lines("Evidence", handoff.turn.evidence),
    "╰─",
  ].join("\n");
  const compact = `\n↪ HANDOFF #${handoff.sequence}  ·  ${heading}\n  ${handoff.turn.summary}`;

  await appendEveryRole(runDirectory, (paneRole) =>
    paneRole === from || paneRole === to ? full : compact,
  );
}

export async function recordRunFailure(
  runDirectory: string,
  state: RunState,
  role: Role | null,
  failure: string,
): Promise<void> {
  await appendEveryRole(
    runDirectory,
    (paneRole) =>
      `\n✗ RUN STOPPED  ·  ${label(role)}\n  ${failure}\n${tokenStatus(state, paneRole)}`,
  );
}

export async function recordLocalCheck(
  runDirectory: string,
  state: RunState,
  check: LocalCheck,
): Promise<void> {
  const mark = check.passed ? "✓" : "✗";
  const detail = check.details.length
    ? `\n${check.details.map((value) => `  • ${value}`).join("\n")}`
    : "";

  await appendEveryRole(
    runDirectory,
    (paneRole) =>
      `\n${mark} LOCAL ${check.kind.toUpperCase()}  ·  ${check.summary}${detail}\n${tokenStatus(state, paneRole)}`,
  );
}

export async function recordWorkspaceBootstrap(
  runDirectory: string,
  state: RunState,
  bootstrap: WorkspaceBootstrap,
): Promise<void> {
  const mark = bootstrap.status === "created" ? "✓" : "○";
  const files =
    bootstrap.status === "created"
      ? `  ${bootstrap.createdFiles.length} boilerplate files created.\n`
      : "";
  const commands =
    bootstrap.commands.length > 0
      ? `  ${bootstrap.commands.length} install/validation commands passed.\n`
      : "";

  await appendEveryRole(
    runDirectory,
    (paneRole) =>
      `\n${mark} WORKSPACE BOOTSTRAP  ·  ${bootstrap.status.toUpperCase()}  ·  TEMPLATE v${bootstrap.templateVersion}\n${files}${commands}  ${bootstrap.reason}\n${tokenStatus(state, paneRole)}`,
  );
}

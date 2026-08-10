import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
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
import { turnLimitLabel } from "../../domain/turn-limit.ts";
import {
  formatElapsed,
  roleElapsedMilliseconds,
  runElapsedMilliseconds,
} from "../../domain/run-timing.ts";

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

async function appendSummary(runDirectory: string, message: string): Promise<void> {
  await appendFile(resolve(runDirectory, "logs", "summary.log"), `${message}\n`);
}

function summaryTable(state: RunState, activeRole: Role | null, turn = state.turns): string {
  const usage = activeRole ? state.tokenTotals.byRole[activeRole] : null;
  const roleName = label(activeRole);
  const roleTime = activeRole
    ? formatElapsed(roleElapsedMilliseconds(state, activeRole))
    : "0m 00s";

  return [
    "┌──────────────┬──────────────────────┬──────────────────────┐",
    `│ TURN         │ ${(turn + "/" + turnLimitLabel(state.maxTurns)).padEnd(20)} │ ${state.status.toUpperCase().padEnd(20)} │`,
    "├──────────────┼──────────────────────┼──────────────────────┤",
    `│ ROLE         │ ${roleName.padEnd(20)} │ TEAM                 │`,
    `│ TOKENS       │ ${count(usage?.totalTokens ?? 0).padEnd(20)} │ ${count(state.tokenTotals.team.totalTokens).padEnd(20)} │`,
    `│ CACHED INPUT │ ${count(usage?.cachedInputTokens ?? 0).padEnd(20)} │ ${count(state.tokenTotals.team.cachedInputTokens).padEnd(20)} │`,
    `│ ACTIVE TIME  │ ${roleTime.padEnd(20)} │ ${formatElapsed(runElapsedMilliseconds(state)).padEnd(20)} │`,
    "└──────────────┴──────────────────────┴──────────────────────┘",
  ].join("\n");
}

export async function recordTurnStarted(
  runDirectory: string,
  state: RunState,
  activeRole: Role,
): Promise<void> {
  const message = `\n${rule}\n▶ TURN ${state.turns + 1}/${turnLimitLabel(state.maxTurns)}  ·  ${label(activeRole)} WORKING\n${rule}`;
  await Promise.all([
    appendRole(runDirectory, activeRole, message),
    appendSummary(
      runDirectory,
      `\n${summaryTable(state, activeRole, state.turns + 1)}\n▶ ${label(activeRole)} WORKING`,
    ),
  ]);
}

export async function recordTurnCompleted(
  runDirectory: string,
  state: RunState,
  activeRole: Role,
  usage: TokenUsage | null,
): Promise<void> {
  const turnTokens = usage ? `${count(usage.totalTokens)} tokens` : "tokens unavailable";

  const message = `\n✓ TURN ${state.turns}/${turnLimitLabel(state.maxTurns)}  ·  ${label(activeRole)} FINISHED  ·  ${turnTokens}`;
  await Promise.all([
    appendRole(runDirectory, activeRole, message),
    appendSummary(
      runDirectory,
      `\n${summaryTable(state, activeRole)}\n✓ ${label(activeRole)} FINISHED  ·  ${turnTokens}`,
    ),
  ]);
}

export async function recordHumanReviewRequested(
  runDirectory: string,
  specification: SpecifierTurn,
): Promise<void> {
  const message = `\n⏸ HUMAN REVIEW  ·  ${specification.featureId}\n  The specification is waiting for approval or change feedback.`;
  await Promise.all([
    appendRole(runDirectory, Role.Specifier, message),
    appendSummary(runDirectory, message),
  ]);
}

export async function recordSpecificationReview(
  runDirectory: string,
  review: SpecificationReview,
): Promise<void> {
  const outcome =
    review.decision === SpecificationReviewDecision.Approved
      ? `APPROVED  ·  ${review.publishedSpecification.path}`
      : `CHANGES REQUESTED  ·  ${review.feedback}`;

  const message = `\n◆ HUMAN REVIEW  ·  ${review.specification.featureId}  ·  ${outcome}`;
  await Promise.all([
    appendRole(runDirectory, Role.Specifier, message),
    appendSummary(runDirectory, message),
  ]);
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

  await Promise.all([
    appendRole(runDirectory, from, full),
    ...(to ? [appendRole(runDirectory, to, full)] : []),
    appendSummary(runDirectory, compact),
  ]);
}

export async function recordRunFailure(
  runDirectory: string,
  state: RunState,
  role: Role | null,
  failure: string,
): Promise<void> {
  const message = `\n✗ RUN STOPPED  ·  ${label(role)}\n  ${failure}`;
  await Promise.all([
    ...(role ? [appendRole(runDirectory, role, message)] : []),
    appendSummary(runDirectory, `${message}\n${summaryTable(state, role)}`),
  ]);
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

  const message = `\n${mark} LOCAL ${check.kind.toUpperCase()}  ·  ${check.summary}${detail}`;
  await Promise.all([
    appendRole(runDirectory, check.role, message),
    appendSummary(
      runDirectory,
      `\n${mark} LOCAL ${check.kind.toUpperCase()}  ·  ${label(check.role)}  ·  ${check.summary}${detail}\n${summaryTable(state, check.role)}`,
    ),
  ]);
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

  const message = `\n${mark} WORKSPACE BOOTSTRAP  ·  ${bootstrap.status.toUpperCase()}  ·  TEMPLATE v${bootstrap.templateVersion}\n${files}${commands}  ${bootstrap.reason}`;
  await Promise.all([
    appendRole(runDirectory, Role.Architect, message),
    appendSummary(runDirectory, `${message}\n${summaryTable(state, state.currentRole)}`),
  ]);
}

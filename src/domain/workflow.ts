import type { ChangePlan } from "./schemas.ts";
import { Role } from "./roles.ts";
import { TurnDecision } from "./workflow-values.ts";

interface WorkflowDecision {
  decision: TurnDecision;
  nextRole: Role | null;
  failureOwner?: Role | null;
  failures?: string[];
}

function validateCompletion(from: Role, turn: WorkflowDecision): void {
  if (from !== Role.Qa || turn.nextRole !== null) {
    throw new Error("Only QA may complete a run, and completion has no next role.");
  }

  if (turn.failureOwner) {
    throw new Error("QA completion cannot name a failure owner.");
  }

  if (turn.failures?.length) {
    throw new Error("QA cannot complete while failures remain.");
  }
}

function requireNextRole(turn: WorkflowDecision): Role {
  if (turn.nextRole === null) {
    throw new Error("A handoff must name its next role.");
  }

  return turn.nextRole;
}

function validateSpecifierHandoff(nextRole: Role): void {
  if (nextRole !== Role.Architect) {
    throw new Error(`Invalid handoff: specifier cannot hand off to ${nextRole}.`);
  }
}

function validateQaFeedback(turn: WorkflowDecision, nextRole: Role): void {
  if (!turn.failures?.length) {
    throw new Error("QA feedback requires at least one concrete failure.");
  }

  if (!turn.failureOwner || turn.failureOwner !== nextRole) {
    throw new Error("QA feedback must route to its declared failureOwner.");
  }
}

function validatePlannedHandoff(from: Role, nextRole: Role, plan?: ChangePlan): void {
  if (!plan) {
    throw new Error(`A technical change plan is required after ${from}.`);
  }

  const expected = nextImplementationRole(from, plan);

  if (nextRole !== expected) {
    throw new Error(`Invalid handoff: ${from} must hand off to ${expected}, not ${nextRole}.`);
  }
}

function returnsApprovedSpecificationToSpecifier(
  mode: "delivery" | "restitution",
  nextRole: Role,
): boolean {
  return mode === "restitution" && nextRole === Role.Specifier;
}

function isDeliveryClarification(
  from: Role,
  nextRole: Role,
  mode: "delivery" | "restitution",
): boolean {
  return from === Role.Architect && nextRole === Role.Specifier && mode === "delivery";
}

export function firstImplementationRole(plan: ChangePlan): Role {
  if (plan.frontendRequired) {
    return Role.UiDesigner;
  }

  if (plan.dataRequired) {
    return Role.DataEngineer;
  }

  if (plan.backendRequired) {
    return Role.BackendCoder;
  }

  return Role.Qa;
}

export function nextImplementationRole(from: Role, plan: ChangePlan): Role {
  if (from === Role.Architect) {
    return firstImplementationRole(plan);
  }

  if (from === Role.UiDesigner && plan.dataRequired) {
    return Role.DataEngineer;
  }

  if ((from === Role.UiDesigner || from === Role.DataEngineer) && plan.backendRequired) {
    return Role.BackendCoder;
  }

  if (
    [Role.UiDesigner, Role.DataEngineer, Role.BackendCoder].includes(from) &&
    plan.frontendRequired
  ) {
    return Role.FrontendCoder;
  }

  return Role.Qa;
}

export function validateTransition(
  from: Role,
  turn: WorkflowDecision,
  mode: "delivery" | "restitution" = "delivery",
  plan?: ChangePlan,
): void {
  if (turn.decision === TurnDecision.Complete) {
    validateCompletion(from, turn);

    return;
  }

  const nextRole = requireNextRole(turn);

  if (returnsApprovedSpecificationToSpecifier(mode, nextRole)) {
    throw new Error(
      "Invalid restitution handoff: an approved specification cannot return to the specifier.",
    );
  }

  if (from === Role.Specifier) {
    validateSpecifierHandoff(nextRole);

    return;
  }

  if (from === Role.Qa) {
    validateQaFeedback(turn, nextRole);

    return;
  }

  if (nextRole === Role.Architect) {
    return;
  }

  if (isDeliveryClarification(from, nextRole, mode)) {
    return;
  }

  validatePlannedHandoff(from, nextRole, plan);
}

export function transitionDescription(mode: "delivery" | "restitution" = "delivery"): string {
  const prefix = mode === "delivery" ? ["specifier -> architect"] : [];

  return [
    ...prefix,
    "architect -> specifier (clarification) | first required implementation role",
    "ui-designer -> architect (blocker) | next required implementation role",
    "data-engineer -> architect (blocker) | next required implementation role",
    "backend-coder -> architect (blocker) | frontend-coder | qa",
    "frontend-coder -> architect (blocker) | qa",
    "qa -> complete | declared failure owner",
  ].join("\n");
}

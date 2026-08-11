import type { ArchitectureReviewStatus, ChangePlan } from "./schemas.ts";
import { Role } from "./roles.ts";
import { TurnDecision } from "./workflow-values.ts";

interface WorkflowDecision {
  decision: TurnDecision;
  nextRole: Role | null;
  failureOwner?: Role | null;
  failures?: string[];
  reviewStatus?: "not-applicable" | "approved" | "changes-requested";
  reviewFindings?: string[];
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

function validatePlannedHandoff(
  from: Role,
  nextRole: Role,
  plan: ChangePlan | undefined,
  reviewStatus: ArchitectureReviewStatus,
): void {
  if (!plan) {
    throw new Error(`A technical change plan is required after ${from}.`);
  }

  const expected = plannedNextRole(from, plan, reviewStatus);

  if (nextRole !== expected) {
    throw new Error(`Invalid handoff: ${from} must hand off to ${expected}, not ${nextRole}.`);
  }
}

function validateArchitectReview(turn: WorkflowDecision, nextRole: Role): void {
  if (turn.reviewStatus === "approved" && nextRole === Role.Qa && !turn.failureOwner) {
    return;
  }

  if (
    turn.reviewStatus === "changes-requested" &&
    turn.reviewFindings?.length &&
    turn.failureOwner === nextRole &&
    [Role.DataEngineer, Role.BackendCoder, Role.FrontendCoder].includes(nextRole)
  ) {
    return;
  }

  throw new Error(
    "Architecture review must approve QA or return concrete findings to one failure owner.",
  );
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

  return Role.Architect;
}

export function plannedNextRole(
  from: Role,
  plan: ChangePlan,
  reviewStatus: ArchitectureReviewStatus = "not-started",
): Role {
  if (
    reviewStatus !== "not-started" &&
    [Role.DataEngineer, Role.BackendCoder, Role.FrontendCoder].includes(from)
  ) {
    return Role.Architect;
  }

  return nextImplementationRole(from, plan);
}

function validateRoleSpecificHandoff(
  from: Role,
  turn: WorkflowDecision,
  nextRole: Role,
  architectureReviewStatus: ArchitectureReviewStatus,
): boolean {
  switch (from) {
    case Role.Specifier:
      validateSpecifierHandoff(nextRole);

      return true;
    case Role.Qa:
      validateQaFeedback(turn, nextRole);

      return true;
    case Role.Architect:
      if (architectureReviewStatus === "pending") {
        validateArchitectReview(turn, nextRole);

        return true;
      }

      if ((turn.reviewStatus ?? "not-applicable") !== "not-applicable") {
        throw new Error("Architecture planning must use reviewStatus=not-applicable.");
      }

      return false;
    default:
      return false;
  }
}

export function validateTransition(
  from: Role,
  turn: WorkflowDecision,
  mode: "delivery" | "restitution" = "delivery",
  plan?: ChangePlan,
  architectureReviewStatus: ArchitectureReviewStatus = "not-started",
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

  if (validateRoleSpecificHandoff(from, turn, nextRole, architectureReviewStatus)) {
    return;
  }

  if (nextRole === Role.Architect) {
    return;
  }

  if (isDeliveryClarification(from, nextRole, mode)) {
    return;
  }

  validatePlannedHandoff(from, nextRole, plan, architectureReviewStatus);
}

export function transitionDescription(mode: "delivery" | "restitution" = "delivery"): string {
  const prefix = mode === "delivery" ? ["specifier -> architect"] : [];

  return [
    ...prefix,
    "architect -> specifier (clarification) | first required implementation role",
    "ui-designer -> architect (blocker) | next required implementation role",
    "data-engineer -> architect (blocker) | next required implementation role",
    "backend-coder -> architect (blocker or final review) | frontend-coder",
    "frontend-coder -> architect (blocker or final review)",
    "architect review -> qa | one declared implementation failure owner",
    "qa -> complete | declared failure owner",
  ].join("\n");
}

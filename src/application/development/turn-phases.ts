import {
  specificationReviewDecisionSchema,
  specifierTurnSchema,
  type AgentTurn,
  type Handoff,
  type LocalCheck,
  type RunState,
  type SpecificationReview,
} from "../../domain/schemas.ts";
import { Role } from "../../domain/roles.ts";
import {
  RunStatus,
  SpecificationReviewDecision,
  TurnDecision,
} from "../../domain/workflow-values.ts";
import { validateGherkin } from "../../domain/specification/gherkin-validator.ts";
import {
  type DevelopmentServices,
  type SpecificationJournal,
  type WorkspaceBootstrapper,
} from "../ports/development-services.ts";
import type { SpecificationReviewer } from "../ports/specification-reviewer.ts";
import type { AcceptedTurn } from "./turn-execution.ts";
import { isCodeWritingRole, normalizeChangedFiles } from "./turn-routing.ts";

export interface TurnPhaseResult {
  turn: AgentTurn;
  repeatRole: boolean;
}

function handoffId(state: RunState): string {
  return `${state.id}-${String(state.messages.length).padStart(4, "0")}`;
}

function gherkinCheck(
  state: RunState,
  specification: string,
): {
  check: LocalCheck;
  featureId: string | null;
} {
  const validation = validateGherkin(specification);

  return {
    featureId: validation.featureId,
    check: {
      sequence: state.localChecks.length + 1,
      turn: state.turns,
      role: Role.Specifier,
      kind: "gherkin",
      createdAt: new Date().toISOString(),
      passed: validation.errors.length === 0,
      summary:
        validation.errors.length === 0
          ? `Gherkin passed (${validation.scenarios.length} scenarios).`
          : `Gherkin failed with ${validation.errors.length} issue(s).`,
      details: validation.errors,
      commands: [],
    },
  };
}

async function repeatSpecifier(
  runDirectory: string,
  state: RunState,
  turn: AgentTurn,
  services: DevelopmentServices,
): Promise<TurnPhaseResult> {
  state.currentRole = Role.Specifier;
  await services.runRepository.save(runDirectory, state);

  return { turn, repeatRole: true };
}

export async function processSpecificationPhase(options: {
  accepted: AcceptedTurn;
  runDirectory: string;
  state: RunState;
  reviewer: SpecificationReviewer;
  journal: SpecificationJournal;
  services: DevelopmentServices;
}): Promise<TurnPhaseResult> {
  const { accepted, runDirectory, state, reviewer, journal, services } = options;

  if (accepted.role !== Role.Specifier) {
    return { turn: accepted.turn, repeatRole: false };
  }

  let specification = specifierTurnSchema.parse(accepted.turn);
  const validation = gherkinCheck(state, specification.specification);
  state.localChecks.push(validation.check);
  await services.runRepository.save(runDirectory, state);
  await services.operatorLog.localCheck(runDirectory, state, validation.check);

  if (!validation.check.passed || !validation.featureId) {
    return repeatSpecifier(runDirectory, state, specification, services);
  }

  specification = { ...specification, featureId: validation.featureId };
  await services.operatorLog.humanReviewRequested(runDirectory, specification);
  const decision = specificationReviewDecisionSchema.parse(
    await reviewer.review({ state, specification }),
  );
  const reviewId = `${state.id}-specification-${String(
    state.specificationReviews.length + 1,
  ).padStart(4, "0")}`;
  const reviewBase = {
    id: reviewId,
    createdAt: new Date().toISOString(),
    specification,
  };

  if (decision.decision === SpecificationReviewDecision.ChangesRequested) {
    const review: SpecificationReview = {
      ...reviewBase,
      ...decision,
      publishedSpecification: null,
    };
    state.specificationReviews.push(review);
    await services.operatorLog.specificationReview(runDirectory, review);

    return repeatSpecifier(runDirectory, state, specification, services);
  }

  const publishedSpecification = await journal.publish({
    workspace: state.workspace,
    sourceReviewId: reviewId,
    specification,
  });
  await journal.verify(state.workspace);
  const review: SpecificationReview = {
    ...reviewBase,
    ...decision,
    publishedSpecification,
  };
  state.specificationReviews.push(review);
  await services.operatorLog.specificationReview(runDirectory, review);

  return {
    repeatRole: false,
    turn: {
      ...specification,
      artifacts: [...new Set([...specification.artifacts, publishedSpecification.path])],
    },
  };
}

export async function processBootstrapPhase(options: {
  turn: AgentTurn;
  runDirectory: string;
  state: RunState;
  bootstrapper: WorkspaceBootstrapper;
  services: DevelopmentServices;
}): Promise<void> {
  const { turn, runDirectory, state, bootstrapper, services } = options;

  if (
    turn.role !== Role.Architect ||
    turn.nextRole === Role.Specifier ||
    state.workspaceBootstrap !== null
  ) {
    return;
  }

  const bootstrap = await bootstrapper.bootstrap(state.workspace, turn.changePlan);
  state.workspaceBootstrap = bootstrap;
  await services.workspaceInventory.refresh(state.workspace, runDirectory);
  await services.runRepository.save(runDirectory, state);
  await services.operatorLog.workspaceBootstrap(runDirectory, state, bootstrap);
}

export async function processQualityPhase(options: {
  accepted: AcceptedTurn;
  turn: AgentTurn;
  runDirectory: string;
  state: RunState;
  services: DevelopmentServices;
}): Promise<TurnPhaseResult> {
  const { accepted, runDirectory, state, services } = options;
  let { turn } = options;

  if (!isCodeWritingRole(accepted.role) || turn.nextRole === Role.Architect) {
    return { turn, repeatRole: false };
  }

  const gate = await services.qualityGate.run({
    workspace: state.workspace,
    facts: await services.workspaceInventory.load(state.workspace, runDirectory),
    changedFiles: normalizeChangedFiles(
      accepted.result?.observations?.changedFiles ?? turn.artifacts,
      state.workspace,
    ),
    turn: state.turns,
    sequence: state.localChecks.length + 1,
    role: accepted.role,
    runScripts: turn.nextRole === Role.Qa,
  });
  state.localChecks.push(gate);
  turn = {
    ...turn,
    evidence: [
      ...new Set([
        ...turn.evidence,
        ...gate.commands.map(({ command, exitCode }) => `${command}: exit ${exitCode}`),
      ]),
    ],
  };
  await services.runRepository.save(runDirectory, state);
  await services.operatorLog.localCheck(runDirectory, state, gate);

  if (!gate.passed) {
    state.currentRole = accepted.role;
    await services.runRepository.save(runDirectory, state);

    return { turn, repeatRole: true };
  }

  return { turn, repeatRole: false };
}

function handoff(state: RunState, from: Role, to: Role | null, turn: AgentTurn): Handoff {
  return {
    id: handoffId(state),
    sequence: state.messages.length,
    from,
    to,
    createdAt: new Date().toISOString(),
    turn,
  };
}

export async function persistTurnTransition(options: {
  runDirectory: string;
  state: RunState;
  role: Role;
  turn: AgentTurn;
  services: DevelopmentServices;
}): Promise<boolean> {
  const { runDirectory, state, role, turn, services } = options;

  if (turn.decision === TurnDecision.Complete) {
    const completion = handoff(state, role, null, turn);
    state.messages.push(completion);
    state.status = RunStatus.Completed;
    state.currentRole = null;
    state.finalSummary = turn.summary;
    await services.runRepository.save(runDirectory, state);
    await services.operatorLog.handoff(runDirectory, completion);

    return true;
  }

  if (turn.nextRole === null) {
    throw new Error("Validated handoff unexpectedly has no recipient.");
  }

  const message = handoff(state, role, turn.nextRole, turn);
  state.messages.push(message);
  state.currentRole = turn.nextRole;
  await services.runRepository.save(runDirectory, state);
  await services.operatorLog.handoff(runDirectory, message);

  return false;
}

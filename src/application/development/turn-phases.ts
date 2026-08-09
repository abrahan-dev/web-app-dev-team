import {
  specificationReviewDecisionSchema,
  specifierTurnSchema,
  type AgentTurn,
  type DevelopmentRun,
  type LocalCheck,
  type RunState,
  type SpecificationReview,
} from "../../domain/schemas.ts";
import { Role } from "../../domain/roles.ts";
import { SpecificationReviewDecision, TurnDecision } from "../../domain/workflow-values.ts";
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

function gherkinCheck(
  state: RunState,
  sequence: number,
  specification: string,
): {
  check: LocalCheck;
  featureId: string | null;
} {
  const validation = validateGherkin(specification);

  return {
    featureId: validation.featureId,
    check: {
      sequence,
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
  run: DevelopmentRun,
  turn: AgentTurn,
  services: DevelopmentServices,
): Promise<TurnPhaseResult> {
  run.repeatRole(Role.Specifier);
  await services.runRepository.save(runDirectory, run.state);

  return { turn, repeatRole: true };
}

export async function processSpecificationPhase(options: {
  accepted: AcceptedTurn;
  runDirectory: string;
  run: DevelopmentRun;
  reviewer: SpecificationReviewer;
  journal: SpecificationJournal;
  services: DevelopmentServices;
}): Promise<TurnPhaseResult> {
  const { accepted, runDirectory, run, reviewer, journal, services } = options;
  const state = run.state;

  if (accepted.role !== Role.Specifier) {
    return { turn: accepted.turn, repeatRole: false };
  }

  let specification = specifierTurnSchema.parse(accepted.turn);
  const validation = gherkinCheck(state, run.nextCheckSequence(), specification.specification);
  run.recordCheck(validation.check);
  await services.runRepository.save(runDirectory, state);
  await services.operatorLog.localCheck(runDirectory, state, validation.check);

  if (!validation.check.passed || !validation.featureId) {
    return repeatSpecifier(runDirectory, run, specification, services);
  }

  specification = { ...specification, featureId: validation.featureId };
  await services.operatorLog.humanReviewRequested(runDirectory, specification);
  const decision = specificationReviewDecisionSchema.parse(
    await reviewer.review({ state, specification }),
  );
  const reviewId = run.nextReviewId();
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
    run.recordReview(review);
    await services.operatorLog.specificationReview(runDirectory, review);

    return repeatSpecifier(runDirectory, run, specification, services);
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
  run.recordReview(review);
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
  run: DevelopmentRun;
  bootstrapper: WorkspaceBootstrapper;
  services: DevelopmentServices;
}): Promise<void> {
  const { turn, runDirectory, run, bootstrapper, services } = options;
  const state = run.state;

  if (
    turn.role !== Role.Architect ||
    turn.nextRole === Role.Specifier ||
    state.workspaceBootstrap !== null
  ) {
    return;
  }

  const bootstrap = await bootstrapper.bootstrap(state.workspace, turn.changePlan);
  run.recordBootstrap(bootstrap);
  await services.workspaceInventory.refresh(state.workspace, runDirectory);
  await services.runRepository.save(runDirectory, state);
  await services.operatorLog.workspaceBootstrap(runDirectory, state, bootstrap);
}

export async function processQualityPhase(options: {
  accepted: AcceptedTurn;
  turn: AgentTurn;
  runDirectory: string;
  run: DevelopmentRun;
  services: DevelopmentServices;
}): Promise<TurnPhaseResult> {
  const { accepted, runDirectory, run, services } = options;
  const state = run.state;
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
    sequence: run.nextCheckSequence(),
    role: accepted.role,
    runScripts: turn.nextRole === Role.Qa,
  });
  run.recordCheck(gate);
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
    run.repeatRole(accepted.role);
    await services.runRepository.save(runDirectory, state);

    return { turn, repeatRole: true };
  }

  return { turn, repeatRole: false };
}

export async function persistTurnTransition(options: {
  runDirectory: string;
  run: DevelopmentRun;
  role: Role;
  turn: AgentTurn;
  services: DevelopmentServices;
}): Promise<boolean> {
  const { runDirectory, run, role, turn, services } = options;
  const message = run.transition(role, turn);
  await services.runRepository.save(runDirectory, run.state);
  await services.operatorLog.handoff(runDirectory, message);

  return turn.decision === TurnDecision.Complete;
}

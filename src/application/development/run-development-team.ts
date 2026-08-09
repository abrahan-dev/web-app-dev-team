import type { AgentRunner } from "../ports/agent-runner.ts";
import type { RunState } from "../../domain/schemas.ts";
import { Role } from "../../domain/roles.ts";
import { RunStatus } from "../../domain/workflow-values.ts";
import { NoRepositoryWorkflow, type RepositoryWorkflow } from "../ports/repository-workflow.ts";
import {
  type DevelopmentServices,
  type SpecificationJournal,
  type WorkspaceBootstrapper,
} from "../ports/development-services.ts";
import type { SpecificationReviewer } from "../ports/specification-reviewer.ts";
import { emptyAttemptState, executeAgentTurn, recordFailedAttempt } from "./turn-execution.ts";
import {
  persistTurnTransition,
  processBootstrapPhase,
  processQualityPhase,
  processSpecificationPhase,
} from "./turn-phases.ts";

function assertTurnBudget(state: RunState): void {
  if (state.turns >= state.maxTurns) {
    throw new Error(`Maximum turn count (${state.maxTurns}) reached.`);
  }
}

function approvedFeatureId(state: RunState): string {
  const specification = state.specificationReviews.findLast(
    ({ publishedSpecification }) => publishedSpecification !== null,
  )?.publishedSpecification;

  if (!specification) {
    throw new Error("The Git workflow requires an approved specification.");
  }

  return specification.featureId;
}

async function runGitStep(
  runDirectory: string,
  state: RunState,
  operation: () => Promise<void>,
  services: DevelopmentServices,
): Promise<boolean> {
  try {
    await operation();
    state.failure = null;
    state.status = state.currentRole === null ? RunStatus.Completed : RunStatus.Running;
    await services.runRepository.save(runDirectory, state);

    return true;
  } catch (error) {
    state.status = RunStatus.Failed;
    state.failure = error instanceof Error ? error.message : String(error);
    await services.runRepository.save(runDirectory, state);

    return false;
  }
}

async function resumeGitFailure(
  runDirectory: string,
  state: RunState,
  repositoryWorkflow: RepositoryWorkflow,
  services: DevelopmentServices,
): Promise<boolean> {
  const step = state.gitWorkflow?.failedStep;

  if (!step) {
    return state.status !== RunStatus.Failed;
  }

  return runGitStep(
    runDirectory,
    state,
    () =>
      state.currentRole === null
        ? repositoryWorkflow.finalize(state)
        : repositoryWorkflow.createFeatureBranch(state, approvedFeatureId(state)),
    services,
  );
}

function createBranchAfterSpecification(
  runDirectory: string,
  state: RunState,
  role: Role,
  repositoryWorkflow: RepositoryWorkflow,
  services: DevelopmentServices,
): Promise<boolean> {
  if (role !== Role.Specifier) {
    return Promise.resolve(true);
  }

  return runGitStep(
    runDirectory,
    state,
    () => repositoryWorkflow.createFeatureBranch(state, approvedFeatureId(state)),
    services,
  );
}

export async function runDevelopmentTeam(
  runner: AgentRunner,
  runDirectory: string,
  specificationReviewer: SpecificationReviewer,
  specificationJournal: SpecificationJournal,
  services: DevelopmentServices,
  workspaceBootstrapper: WorkspaceBootstrapper,
  repositoryWorkflow: RepositoryWorkflow = new NoRepositoryWorkflow(),
): Promise<RunState> {
  const state = await services.runRepository.load(runDirectory);
  const attempt = emptyAttemptState(state.currentRole);

  if (!(await resumeGitFailure(runDirectory, state, repositoryWorkflow, services))) {
    return state;
  }

  try {
    while (state.status === RunStatus.Running) {
      assertTurnBudget(state);
      const accepted = await executeAgentTurn({
        runner,
        runDirectory,
        state,
        journal: specificationJournal,
        attempt,
        services,
      });
      const specificationPhase = await processSpecificationPhase({
        accepted,
        runDirectory,
        state,
        reviewer: specificationReviewer,
        journal: specificationJournal,
        services,
      });

      if (specificationPhase.repeatRole) {
        continue;
      }

      await processBootstrapPhase({
        turn: specificationPhase.turn,
        runDirectory,
        state,
        bootstrapper: workspaceBootstrapper,
        services,
      });
      const qualityPhase = await processQualityPhase({
        accepted,
        turn: specificationPhase.turn,
        runDirectory,
        state,
        services,
      });

      if (qualityPhase.repeatRole) {
        continue;
      }

      const completed = await persistTurnTransition({
        runDirectory,
        state,
        role: accepted.role,
        turn: qualityPhase.turn,
        services,
      });

      if (
        !(await createBranchAfterSpecification(
          runDirectory,
          state,
          accepted.role,
          repositoryWorkflow,
          services,
        ))
      ) {
        return state;
      }

      if (completed) {
        await runGitStep(runDirectory, state, () => repositoryWorkflow.finalize(state), services);

        return state;
      }
    }
  } catch (error) {
    await recordFailedAttempt(runDirectory, state, attempt, error, services);
    throw error;
  }

  return state;
}

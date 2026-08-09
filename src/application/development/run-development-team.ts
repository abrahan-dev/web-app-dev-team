import type { AgentRunner } from "../ports/agent-runner.ts";
import { DevelopmentRun, type RunState } from "../../domain/schemas.ts";
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

async function runGitStep(
  runDirectory: string,
  run: DevelopmentRun,
  operation: () => Promise<void>,
  services: DevelopmentServices,
): Promise<boolean> {
  try {
    await operation();
    run.recordGitResult(null);
    await services.runRepository.save(runDirectory, run.state);

    return true;
  } catch (error) {
    run.recordGitResult(error instanceof Error ? error.message : String(error));
    await services.runRepository.save(runDirectory, run.state);

    return false;
  }
}

async function resumeGitFailure(
  runDirectory: string,
  run: DevelopmentRun,
  repositoryWorkflow: RepositoryWorkflow,
  services: DevelopmentServices,
): Promise<boolean> {
  const state = run.state;
  const step = state.gitWorkflow?.failedStep;

  if (!step) {
    return state.status !== RunStatus.Failed;
  }

  return runGitStep(
    runDirectory,
    run,
    () =>
      state.currentRole === null
        ? repositoryWorkflow.finalize(state)
        : repositoryWorkflow.createFeatureBranch(state, run.approvedFeatureId()),
    services,
  );
}

function createBranchAfterSpecification(
  runDirectory: string,
  run: DevelopmentRun,
  role: Role,
  repositoryWorkflow: RepositoryWorkflow,
  services: DevelopmentServices,
): Promise<boolean> {
  if (role !== Role.Specifier) {
    return Promise.resolve(true);
  }

  return runGitStep(
    runDirectory,
    run,
    () => repositoryWorkflow.createFeatureBranch(run.state, run.approvedFeatureId()),
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
  const run = DevelopmentRun.restore(await services.runRepository.load(runDirectory));
  const attempt = emptyAttemptState(run.state.currentRole);

  if (!(await resumeGitFailure(runDirectory, run, repositoryWorkflow, services))) {
    return run.state;
  }

  try {
    while (run.state.status === RunStatus.Running) {
      run.assertTurnAvailable();
      const accepted = await executeAgentTurn({
        runner,
        runDirectory,
        run,
        journal: specificationJournal,
        attempt,
        services,
      });
      const specificationPhase = await processSpecificationPhase({
        accepted,
        runDirectory,
        run,
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
        run,
        bootstrapper: workspaceBootstrapper,
        services,
      });
      const qualityPhase = await processQualityPhase({
        accepted,
        turn: specificationPhase.turn,
        runDirectory,
        run,
        services,
      });

      if (qualityPhase.repeatRole) {
        continue;
      }

      const completed = await persistTurnTransition({
        runDirectory,
        run,
        role: accepted.role,
        turn: qualityPhase.turn,
        services,
      });

      if (
        !(await createBranchAfterSpecification(
          runDirectory,
          run,
          accepted.role,
          repositoryWorkflow,
          services,
        ))
      ) {
        return run.state;
      }

      if (completed) {
        await runGitStep(runDirectory, run, () => repositoryWorkflow.finalize(run.state), services);

        return run.state;
      }
    }
  } catch (error) {
    await recordFailedAttempt(runDirectory, run, attempt, error, services);
    throw error;
  }

  return run.state;
}

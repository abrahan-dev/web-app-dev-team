import { AgentRunError, type AgentRunResult, type AgentRunner } from "../ports/agent-runner.ts";
import type { AgentTurn, DevelopmentRun, Role, RunState } from "../../domain/schemas.ts";
import { validateTransition } from "../../domain/workflow.ts";
import {
  type DevelopmentServices,
  type SpecificationJournal,
} from "../ports/development-services.ts";
import {
  canonicalizeNextRole,
  enrichWithObservedEvidence,
  isAgentRunResult,
  latestChangePlan,
  normalizeChangedFiles,
} from "./turn-routing.ts";

export interface AttemptState {
  activeRole: Role | null;
  startedAt: string | null;
  usage: AgentRunResult["usage"];
  executionRecorded: boolean;
}

export interface AcceptedTurn {
  role: Role;
  turn: AgentTurn;
  result: AgentRunResult | null;
}

export function emptyAttemptState(currentRole: Role | null): AttemptState {
  return {
    activeRole: currentRole,
    startedAt: null,
    usage: null,
    executionRecorded: false,
  };
}

function executionUsage(result: AgentRunResult | null): AgentRunResult["usage"] {
  return result ? result.usage : null;
}

function executionObservations(
  result: AgentRunResult | null,
  workspace: string,
): Pick<RunState["executions"][number], "commands" | "changedFiles"> {
  const observations = result?.observations;

  return {
    commands: observations ? observations.commands : [],
    changedFiles: normalizeChangedFiles(observations ? observations.changedFiles : [], workspace),
  };
}

function unpackAgentResult(raw: Awaited<ReturnType<AgentRunner["run"]>>): {
  result: AgentRunResult | null;
  turn: AgentTurn;
} {
  return isAgentRunResult(raw) ? { result: raw, turn: raw.turn } : { result: null, turn: raw };
}

export async function executeAgentTurn(options: {
  runner: AgentRunner;
  runDirectory: string;
  run: DevelopmentRun;
  journal: SpecificationJournal;
  attempt: AttemptState;
  services: DevelopmentServices;
}): Promise<AcceptedTurn> {
  const { runner, runDirectory, run, journal, attempt, services } = options;
  const state = run.state;
  const role = run.currentRole();

  attempt.activeRole = role;
  attempt.usage = null;
  attempt.executionRecorded = false;
  await journal.verify(state.workspace);
  attempt.startedAt = new Date().toISOString();
  run.startExecution(role, attempt.startedAt);
  await services.runRepository.save(runDirectory, state);
  await services.operatorLog.turnStarted(runDirectory, state, role);

  const rawResult = await runner.run({ role, state, runDirectory });
  const { result, turn: agentTurn } = unpackAgentResult(rawResult);
  let turn = enrichWithObservedEvidence(agentTurn, result, state.workspace);
  attempt.usage = result?.usage ?? null;
  await journal.verify(state.workspace);

  if (turn.role !== role) {
    throw new Error(`Invalid agent output: ${role} returned a ${turn.role} turn.`);
  }

  turn = canonicalizeNextRole(state, turn);
  validateTransition(
    role,
    turn,
    state.mode,
    latestChangePlan(state, turn),
    state.architectureReviewStatus,
  );
  run.recordExecution(
    role,
    attempt.startedAt,
    executionUsage(result),
    executionObservations(result, state.workspace),
  );
  attempt.executionRecorded = true;
  await services.runRepository.save(runDirectory, state);
  await services.operatorLog.turnCompleted(runDirectory, state, role, result?.usage ?? null);
  attempt.startedAt = null;

  return { role, turn, result };
}

export async function recordFailedAttempt(
  runDirectory: string,
  run: DevelopmentRun,
  attempt: AttemptState,
  error: unknown,
  services: DevelopmentServices,
): Promise<void> {
  const state = run.state;
  const failure = error instanceof Error ? error.message : String(error);
  const failedUsage = error instanceof AgentRunError ? error.usage : attempt.usage;
  run.recordFailedAttempt({
    role: attempt.activeRole,
    startedAt: attempt.startedAt,
    usage: failedUsage,
    executionRecorded: attempt.executionRecorded,
    failure,
  });

  await services.runRepository.save(runDirectory, state);
  await services.operatorLog.runFailure(runDirectory, state, attempt.activeRole, failure);
}

import { AgentRunError, type AgentRunResult, type AgentRunner } from "../ports/agent-runner.ts";
import type { AgentTurn, Role, RunState } from "../../domain/schemas.ts";
import { RunStatus } from "../../domain/workflow-values.ts";
import { recordTokenUsage } from "../../domain/token-usage.ts";
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

function recordExecution(
  state: RunState,
  role: Role,
  startedAt: string,
  result: AgentRunResult | null,
): void {
  const usage = executionUsage(result);
  const observations = executionObservations(result, state.workspace);
  state.turns += 1;
  state.executions.push({
    sequence: state.executions.length + 1,
    turn: state.turns,
    role,
    startedAt,
    completedAt: new Date().toISOString(),
    status: RunStatus.Completed,
    usage,
    ...observations,
  });

  if (usage) {
    recordTokenUsage(state.tokenTotals, role, usage);
  }
}

export async function executeAgentTurn(options: {
  runner: AgentRunner;
  runDirectory: string;
  state: RunState;
  journal: SpecificationJournal;
  attempt: AttemptState;
  services: DevelopmentServices;
}): Promise<AcceptedTurn> {
  const { runner, runDirectory, state, journal, attempt, services } = options;
  const role = state.currentRole;

  if (role === null) {
    throw new Error("A running development team must have a current role.");
  }

  attempt.activeRole = role;
  attempt.startedAt = new Date().toISOString();
  attempt.usage = null;
  attempt.executionRecorded = false;
  await journal.verify(state.workspace);
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
  validateTransition(role, turn, state.mode, latestChangePlan(state, turn));
  recordExecution(state, role, attempt.startedAt, result);
  attempt.executionRecorded = true;
  await services.runRepository.save(runDirectory, state);
  await services.operatorLog.turnCompleted(runDirectory, state, role, result?.usage ?? null);
  attempt.startedAt = null;

  return { role, turn, result };
}

export async function recordFailedAttempt(
  runDirectory: string,
  state: RunState,
  attempt: AttemptState,
  error: unknown,
  services: DevelopmentServices,
): Promise<void> {
  const failure = error instanceof Error ? error.message : String(error);
  state.status = RunStatus.Failed;
  state.failure = failure;
  const failedUsage = error instanceof AgentRunError ? error.usage : attempt.usage;

  if (!attempt.executionRecorded && attempt.activeRole !== null) {
    state.executions.push({
      sequence: state.executions.length + 1,
      turn: state.turns + 1,
      role: attempt.activeRole,
      startedAt: attempt.startedAt ?? new Date().toISOString(),
      completedAt: new Date().toISOString(),
      status: RunStatus.Failed,
      usage: failedUsage,
      commands: [],
      changedFiles: [],
    });

    if (failedUsage) {
      recordTokenUsage(state.tokenTotals, attempt.activeRole, failedUsage);
    }
  }

  if (attempt.activeRole !== null) {
    state.interruptions.push({
      sequence: state.interruptions.length + 1,
      role: attempt.activeRole,
      turn: state.turns + 1,
      createdAt: new Date().toISOString(),
      reason: failure,
      logPath: `logs/${attempt.activeRole}.log`,
    });
  }

  await services.runRepository.save(runDirectory, state);
  await services.operatorLog.runFailure(runDirectory, state, attempt.activeRole, failure);
}

import { isAbsolute, relative } from "node:path";
import type { AgentRunResult, AgentRunner } from "../ports/agent-runner.ts";
import {
  agentTurnSchema,
  type AgentTurn,
  type ChangePlan,
  type RunState,
} from "../../domain/schemas.ts";
import { Role } from "../../domain/roles.ts";
import { TurnDecision } from "../../domain/workflow-values.ts";
import { firstImplementationRole, plannedNextRole } from "../../domain/workflow.ts";

const codeWritingRoles = [Role.DataEngineer, Role.BackendCoder, Role.FrontendCoder] as const;
export type CodeWritingRole = (typeof codeWritingRoles)[number];

export function isCodeWritingRole(role: Role): role is CodeWritingRole {
  return codeWritingRoles.includes(role as CodeWritingRole);
}

export function isAgentRunResult(
  result: Awaited<ReturnType<AgentRunner["run"]>>,
): result is AgentRunResult {
  return "turn" in result;
}

export function normalizeChangedFiles(paths: string[], workspace: string): string[] {
  return [
    ...new Set(
      paths
        .map((path) => (isAbsolute(path) ? relative(workspace, path) : path))
        .filter((path) => path !== ".." && !path.startsWith("../")),
    ),
  ];
}

export function latestChangePlan(state: RunState, turn: AgentTurn): ChangePlan | undefined {
  if (turn.role === Role.Architect) {
    return turn.changePlan;
  }

  const architect = state.messages.findLast(
    (message) => message.turn?.role === Role.Architect,
  )?.turn;

  return architect?.role === Role.Architect ? architect.changePlan : undefined;
}

export function canonicalizeNextRole(state: RunState, turn: AgentTurn): AgentTurn {
  if (
    turn.role === Role.Architect &&
    state.architectureReviewStatus !== "pending" &&
    turn.nextRole !== Role.Specifier
  ) {
    return agentTurnSchema.parse({
      ...turn,
      nextRole: firstImplementationRole(turn.changePlan),
    });
  }

  if (
    [Role.UiDesigner, ...codeWritingRoles].includes(
      turn.role as Role.UiDesigner | CodeWritingRole,
    ) &&
    turn.nextRole !== Role.Architect
  ) {
    const plan = latestChangePlan(state, turn);

    return plan
      ? agentTurnSchema.parse({
          ...turn,
          nextRole: plannedNextRole(turn.role, plan, state.architectureReviewStatus),
        })
      : turn;
  }

  if (turn.role === Role.Qa && turn.decision === TurnDecision.Handoff && turn.failureOwner) {
    return agentTurnSchema.parse({ ...turn, nextRole: turn.failureOwner });
  }

  return turn;
}

export function enrichWithObservedEvidence(
  turn: AgentTurn,
  result: AgentRunResult | null,
  workspace: string,
): AgentTurn {
  const observations = result?.observations;

  if (!observations) {
    return turn;
  }

  const observedCommands = new Map(
    observations.commands.map(({ command, exitCode }) => [command, exitCode]),
  );

  for (const evidence of turn.evidence) {
    const claim = /^(.*): exit (\d+)$/u.exec(evidence);

    if (claim && observedCommands.get(claim[1] ?? "") !== Number(claim[2])) {
      throw new Error(`Agent evidence is not present in complete command telemetry: ${evidence}`);
    }
  }

  const changedFiles = normalizeChangedFiles(observations.changedFiles, workspace);
  const commandEvidence = observations.commands.map(
    ({ command, exitCode }) => `${command}: exit ${exitCode ?? "unknown"}`,
  );

  if (isCodeWritingRole(turn.role)) {
    return {
      ...turn,
      artifacts: [...new Set([...turn.artifacts, ...changedFiles])],
      evidence: [...new Set([...turn.evidence, ...commandEvidence])],
    };
  }

  if (turn.role === Role.Qa) {
    return {
      ...turn,
      commands: [
        ...new Set([...turn.commands, ...observations.commands.map(({ command }) => command)]),
      ],
      evidence: [...new Set([...turn.evidence, ...commandEvidence])],
    };
  }

  return turn;
}

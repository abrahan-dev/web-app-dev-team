import {
  agentTurnSchema,
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

export const qualityFailureEscalationThreshold = 3;
export const finalReviewTurnReserve = 10;

function requiresCoverage(role: Role, turn: AgentTurn): boolean {
  return isCodeWritingRole(role) || requiresFinalVerification(role, turn);
}

function requiresFinalVerification(role: Role, turn: AgentTurn): boolean {
  return role === Role.Qa && turn.decision === TurnDecision.Complete;
}

function requiresQualityGate(role: Role, turn: AgentTurn): boolean {
  return isCodeWritingRole(role) || requiresFinalVerification(role, turn);
}

function stableFailureText(value: string): string {
  return value
    .replace(/web-app-dev-team-coverage-[A-Za-z0-9]+/gu, "web-app-dev-team-coverage-ID")
    .replace(/\[\d+(?:\.\d+)?ms\]/gu, "[TIME]")
    .replace(/\b\d+(?:\.\d+)?ms\b/gu, "TIME");
}

function qualityFailureSignature(check: LocalCheck): string {
  if (check.findings?.length) {
    return JSON.stringify(
      check.findings
        .map(({ code, owner, file, metric, actual, required }) => ({
          code,
          owner,
          file,
          metric,
          actual,
          required,
        }))
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    );
  }

  return JSON.stringify({
    commands: check.commands.map(({ command, exitCode }) => ({
      command: stableFailureText(command),
      exitCode,
    })),
    details: check.details.map((detail) => stableFailureText(detail.split("\n", 1)[0] ?? detail)),
  });
}

function executionChangedFiles(state: RunState, check: LocalCheck): string[] | null {
  const execution = state.executions.findLast(
    (candidate) => candidate.role === check.role && candidate.turn === check.turn,
  );

  return execution?.changedFiles ?? null;
}

function repeatedUnchangedFailureCount(state: RunState, gate: LocalCheck): number {
  const signature = qualityFailureSignature(gate);
  const assignment = state.messages.findLast((message) => message.to === gate.role);
  let count = 0;

  for (const check of state.localChecks.toReversed()) {
    if (
      (assignment !== undefined && check.createdAt < assignment.createdAt) ||
      check.role !== gate.role ||
      check.kind !== "quality-gate" ||
      check.passed ||
      qualityFailureSignature(check) !== signature
    ) {
      break;
    }

    const changedFiles = executionChangedFiles(state, check);

    if (changedFiles === null || changedFiles.length > 0) {
      break;
    }

    count += 1;
  }

  return count;
}

function escalatedQualityTurn(turn: AgentTurn, gate: LocalCheck, failures: number): AgentTurn {
  const failure = gate.findings?.[0]?.message ?? gate.details[0]?.split("\n", 1)[0] ?? gate.summary;

  return agentTurnSchema.parse({
    ...turn,
    decision: TurnDecision.Handoff,
    nextRole: Role.Architect,
    reason: `The same local quality failure occurred ${failures} times without file changes. The architect must resolve this blocker. ${failure}`,
  });
}

function mustReserveFinalReviewTurns(state: RunState): boolean {
  return (
    state.maxTurns > finalReviewTurnReserve &&
    state.maxTurns - state.turns <= finalReviewTurnReserve
  );
}

function qualityFailureOwner(gate: LocalCheck): Role | null {
  return (
    gate.findings?.find(({ code, owner }) => code !== "command-failed" && owner !== gate.role)
      ?.owner ?? null
  );
}

function routedQualityTurn(turn: AgentTurn, gate: LocalCheck, reason: string): AgentTurn {
  const failure = gate.findings?.[0]?.message ?? gate.summary;

  return agentTurnSchema.parse({
    ...turn,
    decision: TurnDecision.Handoff,
    nextRole: Role.Architect,
    reason: `${reason} The architect must resolve this blocker. ${failure}`,
  });
}

function qualityEscalation(
  state: RunState,
  role: Role,
  turn: AgentTurn,
  gate: LocalCheck,
): TurnPhaseResult | null {
  if (!isCodeWritingRole(role)) {
    return null;
  }

  const failureOwner = qualityFailureOwner(gate);

  if (failureOwner) {
    return {
      turn: routedQualityTurn(
        turn,
        gate,
        `The deterministic failure belongs to ${failureOwner}, not ${role}.`,
      ),
      repeatRole: false,
    };
  }

  const repeatedFailures = repeatedUnchangedFailureCount(state, gate);

  if (repeatedFailures >= qualityFailureEscalationThreshold) {
    return {
      turn: escalatedQualityTurn(turn, gate, repeatedFailures),
      repeatRole: false,
    };
  }

  return mustReserveFinalReviewTurns(state)
    ? {
        turn: routedQualityTurn(
          turn,
          gate,
          `Only ${state.maxTurns - state.turns} configured turns remain.`,
        ),
        repeatRole: false,
      }
    : null;
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
  const coverageRequired = requiresCoverage(accepted.role, turn);
  const finalVerificationRequired = requiresFinalVerification(accepted.role, turn);

  if (!requiresQualityGate(accepted.role, turn)) {
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
    runScripts: finalVerificationRequired,
    runBrowserTests: finalVerificationRequired,
    runCoverage: coverageRequired,
    requireExactDependencies: state.workspaceBootstrap?.status === "created",
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
    const escalation = qualityEscalation(state, accepted.role, turn, gate);

    if (escalation) {
      return escalation;
    }

    run.repeatRole(accepted.role);
    await services.runRepository.save(runDirectory, state);

    return { turn, repeatRole: true };
  }

  await services.workspaceInventory.refresh(state.workspace, runDirectory);

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

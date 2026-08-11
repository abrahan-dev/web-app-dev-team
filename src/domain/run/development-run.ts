import type { AgentTurn } from "../agent/agent-turn.ts";
import type { SpecificationReview } from "../specification/specification.ts";
import type { Role } from "../roles.ts";
import { Role as DevelopmentRole } from "../roles.ts";
import {
  runStateSchema,
  type Handoff,
  type LocalCheck,
  type RunState,
  type TokenUsage,
  type WorkspaceBootstrap,
} from "./run-state.ts";
import { RunStatus, TurnDecision } from "../workflow-values.ts";
import { recordTokenUsage } from "../token-usage.ts";
import { extendedTurnLimit, unlimitedTurns } from "../turn-limit.ts";
import { nextImplementationRole } from "../workflow.ts";

interface ExecutionObservations {
  commands: RunState["executions"][number]["commands"];
  changedFiles: string[];
}

interface FailedAttempt {
  role: Role | null;
  startedAt: string | null;
  usage: TokenUsage | null;
  executionRecorded: boolean;
  failure: string;
}

export class DevelopmentRun {
  private constructor(private readonly value: RunState) {
    this.assertState();
  }

  static restore(value: RunState): DevelopmentRun {
    return new DevelopmentRun(runStateSchema.parse(value));
  }

  get state(): RunState {
    return this.value;
  }

  assertTurnAvailable(): void {
    if (this.value.status !== RunStatus.Running || this.value.currentRole === null) {
      throw new Error("Only a running development run can start an agent turn.");
    }

    if (this.value.maxTurns !== unlimitedTurns && this.value.turns >= this.value.maxTurns) {
      throw new Error(`Maximum turn count (${this.value.maxTurns}) reached.`);
    }
  }

  currentRole(): Role {
    if (this.value.status !== RunStatus.Running || this.value.currentRole === null) {
      throw new Error("A running development team must have a current role.");
    }

    return this.value.currentRole;
  }

  startExecution(role: Role, startedAt: string): void {
    if (role !== this.currentRole()) {
      throw new Error(`Cannot start ${role} while ${this.value.currentRole} is active.`);
    }

    if (this.value.activeExecutionStartedAt !== null) {
      throw new Error("The active role already has an execution in progress.");
    }

    this.value.activeExecutionStartedAt = startedAt;
  }

  approvedFeatureId(): string {
    const specification = this.value.specificationReviews.findLast(
      ({ publishedSpecification }) => publishedSpecification !== null,
    )?.publishedSpecification;

    if (!specification) {
      throw new Error("The Git workflow requires an approved specification.");
    }

    return specification.featureId;
  }

  nextCheckSequence(): number {
    return this.value.localChecks.length + 1;
  }

  nextReviewId(): string {
    return `${this.value.id}-specification-${String(
      this.value.specificationReviews.length + 1,
    ).padStart(4, "0")}`;
  }

  recordExecution(
    role: Role,
    startedAt: string,
    usage: TokenUsage | null,
    observations: ExecutionObservations,
  ): void {
    if (role !== this.currentRole()) {
      throw new Error(`Cannot record ${role} while ${this.value.currentRole} is active.`);
    }

    this.value.turns += 1;
    this.value.executions.push({
      sequence: this.value.executions.length + 1,
      turn: this.value.turns,
      role,
      startedAt,
      completedAt: new Date().toISOString(),
      status: RunStatus.Completed,
      usage,
      ...observations,
    });

    if (usage) {
      recordTokenUsage(this.value.tokenTotals, role, usage);
    }

    this.value.activeExecutionStartedAt = null;
  }

  recordFailedAttempt(attempt: FailedAttempt): void {
    this.value.status = RunStatus.Failed;
    this.value.failure = attempt.failure;
    this.value.activeExecutionStartedAt = null;

    if (!attempt.executionRecorded && attempt.role !== null) {
      this.value.executions.push({
        sequence: this.value.executions.length + 1,
        turn: this.value.turns + 1,
        role: attempt.role,
        startedAt: attempt.startedAt ?? new Date().toISOString(),
        completedAt: new Date().toISOString(),
        status: RunStatus.Failed,
        usage: attempt.usage,
        commands: [],
        changedFiles: [],
      });

      if (attempt.usage) {
        recordTokenUsage(this.value.tokenTotals, attempt.role, attempt.usage);
      }
    }

    if (attempt.role !== null) {
      this.appendInterruption(attempt.role, attempt.failure);
    }
  }

  recordInterruption(role: Role, reason: string): void {
    if (this.value.currentRole !== role) {
      throw new Error(`Cannot interrupt ${role} while ${this.value.currentRole} is active.`);
    }

    this.appendInterruption(role, reason);
  }

  resume(maxTurns: number): void {
    if (this.value.status !== RunStatus.Failed || this.value.currentRole === null) {
      throw new Error("Only a failed development run with a current role can resume.");
    }

    this.value.status = RunStatus.Running;
    this.value.failure = null;
    this.value.maxTurns = extendedTurnLimit(this.value.maxTurns, maxTurns);
  }

  recordCheck(check: LocalCheck): void {
    if (check.sequence !== this.nextCheckSequence()) {
      throw new Error(`Expected local check sequence ${this.nextCheckSequence()}.`);
    }

    this.value.localChecks.push(check);
  }

  recordReview(review: SpecificationReview): void {
    if (review.id !== this.nextReviewId()) {
      throw new Error(`Expected specification review ${this.nextReviewId()}.`);
    }

    this.value.specificationReviews.push(review);
  }

  recordBootstrap(bootstrap: WorkspaceBootstrap): void {
    if (this.value.workspaceBootstrap !== null) {
      throw new Error("The workspace bootstrap is already recorded.");
    }

    this.value.workspaceBootstrap = bootstrap;
  }

  repeatRole(role: Role): void {
    if (this.value.status !== RunStatus.Running) {
      throw new Error("A stopped development run cannot repeat a role.");
    }

    if (this.value.currentRole !== role) {
      throw new Error(`Only the active role ${this.value.currentRole} can repeat its work.`);
    }
  }

  transition(from: Role, turn: AgentTurn): Handoff {
    if (from !== this.currentRole() || turn.role !== from) {
      throw new Error(`Only the active role ${this.value.currentRole} can create a handoff.`);
    }

    const completing = turn.decision === TurnDecision.Complete;

    if (completing && (from !== DevelopmentRole.Qa || turn.nextRole !== null)) {
      throw new Error("Only QA can complete a run without a next role.");
    }

    if (!completing && turn.nextRole === null) {
      throw new Error("A handoff must name its next role.");
    }

    const message: Handoff = {
      id: `${this.value.id}-${String(this.value.messages.length).padStart(4, "0")}`,
      sequence: this.value.messages.length,
      from,
      to: completing ? null : turn.nextRole,
      createdAt: new Date().toISOString(),
      turn,
    };
    this.updateArchitectureReview(from, turn);
    this.value.messages.push(message);

    if (completing) {
      this.value.status = RunStatus.Completed;
      this.value.currentRole = null;
      this.value.finalSummary = turn.summary;
    } else {
      this.value.currentRole = turn.nextRole;
    }

    return message;
  }

  recordGitResult(failure: string | null): void {
    this.value.failure = failure;
    this.value.status = failure
      ? RunStatus.Failed
      : this.value.currentRole === null
        ? RunStatus.Completed
        : RunStatus.Running;
  }

  private assertState(): void {
    if (this.value.status === RunStatus.Running && this.value.currentRole === null) {
      throw new Error("A running development run must have a current role.");
    }

    if (this.value.status === RunStatus.Completed && this.value.currentRole !== null) {
      throw new Error("A completed development run cannot have a current role.");
    }

    if (this.value.activeExecutionStartedAt !== null && this.value.currentRole === null) {
      throw new Error("An execution in progress must have a current role.");
    }

    if (this.value.maxTurns !== unlimitedTurns && this.value.turns > this.value.maxTurns) {
      throw new Error("A development run cannot exceed its turn limit.");
    }

    const completedExecutions = this.value.executions.filter(
      ({ status }) => status === RunStatus.Completed,
    ).length;

    if (completedExecutions !== this.value.turns) {
      throw new Error("The turn count must equal the completed execution count.");
    }

    this.assertSequences(this.value.messages, 0, "handoff");
    this.assertSequences(this.value.executions, 1, "execution");
    this.assertSequences(this.value.localChecks, 1, "local check");
  }

  private appendInterruption(role: Role, reason: string): void {
    this.value.interruptions.push({
      sequence: this.value.interruptions.length + 1,
      role,
      turn: this.value.turns + 1,
      createdAt: new Date().toISOString(),
      reason,
      logPath: `logs/${role}.log`,
    });
  }

  private updateArchitectureReview(from: Role, turn: AgentTurn): void {
    if (turn.decision === TurnDecision.Complete || turn.nextRole === null) {
      return;
    }

    if (from === DevelopmentRole.Qa) {
      this.value.architectureReviewStatus =
        turn.nextRole === DevelopmentRole.Architect ? "pending" : "changes-requested";

      return;
    }

    if (from === DevelopmentRole.Architect && this.value.architectureReviewStatus === "pending") {
      this.value.architectureReviewStatus =
        turn.nextRole === DevelopmentRole.Qa ? "approved" : "changes-requested";

      return;
    }

    if (this.startsArchitectureReview(from, turn.nextRole)) {
      this.value.architectureReviewStatus = "pending";
    }
  }

  private startsArchitectureReview(from: Role, nextRole: Role): boolean {
    const implementationRole = [
      DevelopmentRole.DataEngineer,
      DevelopmentRole.BackendCoder,
      DevelopmentRole.FrontendCoder,
    ].includes(from);

    if (!implementationRole || nextRole !== DevelopmentRole.Architect) {
      return false;
    }

    return (
      this.value.architectureReviewStatus !== "not-started" || this.isFinalImplementationRole(from)
    );
  }

  private isFinalImplementationRole(role: Role): boolean {
    const plan = this.value.messages.findLast(
      (message) => message.turn?.role === DevelopmentRole.Architect,
    )?.turn;

    return (
      plan?.role === DevelopmentRole.Architect &&
      nextImplementationRole(role, plan.changePlan) === DevelopmentRole.Architect
    );
  }

  private assertSequences(values: Array<{ sequence: number }>, first: number, label: string): void {
    const invalid = values.findIndex(({ sequence }, index) => sequence !== index + first);

    if (invalid !== -1) {
      throw new Error(`Invalid ${label} sequence at index ${invalid}.`);
    }
  }
}

import { z } from "zod";
import { publishedSpecificationSchema } from "../specification/specification.ts";
import type { PublishedSpecification } from "../specification/specification.ts";
import { roleSchema } from "../agent/agent-turn.ts";
import { runStateSchema, type RunState, type TokenTotals } from "../run/run-state.ts";
import type { Role } from "../roles.ts";
import { RestitutionStatus, RunStatus } from "../workflow-values.ts";

export const restitutionStateSchema = z.object({
  version: z.literal(1),
  id: z.string(),
  workspace: z.string(),
  sourceSpecifications: z.string(),
  status: z.enum(RestitutionStatus),
  specifications: z.array(publishedSpecificationSchema),
  nextSequence: z.number().int().positive(),
  currentSequence: z.number().int().positive().nullable(),
  resumeRole: roleSchema.nullable(),
  completedSequences: z.array(z.number().int().positive()),
  maxTurnsPerSpecification: z.number().int().positive(),
  failure: z.string().nullable(),
  tokenTotals: runStateSchema.shape.tokenTotals,
});

export type RestitutionState = z.infer<typeof restitutionStateSchema>;

export class RestitutionProgress {
  private constructor(private readonly value: RestitutionState) {
    this.assertSequenceState();
  }

  static restore(value: RestitutionState): RestitutionProgress {
    return new RestitutionProgress(restitutionStateSchema.parse(value));
  }

  get state(): RestitutionState {
    return this.value;
  }

  begin(maxTurnsOverride?: number): boolean {
    const recoveringActiveRun =
      this.value.status === RestitutionStatus.Running && this.value.currentSequence !== null;

    if (maxTurnsOverride !== undefined) {
      this.value.maxTurnsPerSpecification = maxTurnsOverride;
    }

    this.value.status = RestitutionStatus.Running;
    this.value.failure = null;

    return recoveringActiveRun;
  }

  nextSpecification(): PublishedSpecification {
    const target = this.value.specifications[this.value.nextSequence - 1];

    if (!target || target.sequence !== this.value.nextSequence) {
      throw new Error(`Missing specification sequence ${this.value.nextSequence}.`);
    }

    return target;
  }

  startSequence(sequence: number, role: Role): void {
    if (this.value.currentSequence !== null || sequence !== this.value.nextSequence) {
      throw new Error(`Cannot start specification sequence ${sequence}.`);
    }

    this.value.currentSequence = sequence;
    this.value.resumeRole = role;
  }

  recover(role: Role | null): void {
    if (this.value.currentSequence === null) {
      throw new Error("Cannot recover without an active specification sequence.");
    }

    this.value.resumeRole = role;
  }

  interrupt(failure: string, role: Role | null, tokenTotals?: TokenTotals): void {
    this.value.status = RestitutionStatus.Interrupted;
    this.value.failure = failure;
    this.value.resumeRole = role;

    if (tokenTotals) {
      this.value.tokenTotals = tokenTotals;
    }
  }

  checkpoint(run: RunState): number {
    const sequence = this.value.currentSequence;

    if (sequence === null || run.status !== RunStatus.Completed) {
      throw new Error("Only a completed current sequence can be checkpointed.");
    }

    this.value.completedSequences.push(sequence);
    this.value.nextSequence = sequence + 1;
    this.value.currentSequence = null;
    this.value.resumeRole = null;
    this.value.failure = null;
    this.value.tokenTotals = run.tokenTotals;
    this.assertSequenceState();

    return sequence;
  }

  complete(): void {
    if (this.value.nextSequence <= this.value.specifications.length) {
      throw new Error("Cannot complete restitution while specifications remain.");
    }

    this.value.status = RestitutionStatus.Completed;
    this.value.currentSequence = null;
    this.value.resumeRole = null;
    this.value.failure = null;
  }

  private assertSequenceState(): void {
    const expectedCompleted = Array.from(
      { length: this.value.nextSequence - 1 },
      (_, index) => index + 1,
    );

    if (JSON.stringify(this.value.completedSequences) !== JSON.stringify(expectedCompleted)) {
      throw new Error("Completed restitution sequences must be contiguous and ordered.");
    }

    if (
      this.value.currentSequence !== null &&
      this.value.currentSequence !== this.value.nextSequence
    ) {
      throw new Error("The active restitution sequence must equal the next sequence.");
    }

    if (this.value.nextSequence > this.value.specifications.length + 1) {
      throw new Error("The next restitution sequence is outside the specification archive.");
    }
  }
}

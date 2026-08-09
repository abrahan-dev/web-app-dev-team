import { describe, expect, test } from "bun:test";
import { RestitutionProgress } from "../../../src/domain/schemas.ts";
import { Role } from "../../../src/domain/roles.ts";
import { emptyTokenTotals } from "../../../src/domain/token-usage.ts";
import { RestitutionStatus, RunStatus } from "../../../src/domain/workflow-values.ts";
import { restitutionStateFactory, runStateFactory } from "../../support/domain-factories.ts";

function progress(): RestitutionProgress {
  return RestitutionProgress.restore(restitutionStateFactory());
}

describe("restitution progress aggregate", () => {
  test("checkpoints only contiguous specification sequences", () => {
    const restitution = progress();

    restitution.startSequence(1, Role.Architect);
    restitution.checkpoint(runStateFactory({ status: RunStatus.Completed, currentRole: null }));
    restitution.startSequence(2, Role.Architect);
    restitution.checkpoint(runStateFactory({ status: RunStatus.Completed, currentRole: null }));
    restitution.complete();

    expect(restitution.state.status).toBe(RestitutionStatus.Completed);
    expect(restitution.state.completedSequences).toEqual([1, 2]);
    expect(restitution.state.nextSequence).toBe(3);
    expect(restitution.state.currentSequence).toBeNull();
  });

  test("rejects completion while a specification remains", () => {
    expect(() => progress().complete()).toThrow(
      "Cannot complete restitution while specifications remain",
    );
  });

  test("rejects a gap in completed specification sequences", () => {
    const invalid = progress().state;
    invalid.nextSequence = 2;

    expect(() => RestitutionProgress.restore(invalid)).toThrow(
      "Completed restitution sequences must be contiguous",
    );
  });

  test("records the active role and token totals after an interruption", () => {
    const restitution = progress();
    const totals = emptyTokenTotals();
    totals.team.totalTokens = 12;
    restitution.startSequence(1, Role.Architect);

    restitution.interrupt("Token quota exhausted.", Role.UiDesigner, totals);

    expect(restitution.state.status).toBe(RestitutionStatus.Interrupted);
    expect(restitution.state.resumeRole).toBe(Role.UiDesigner);
    expect(restitution.state.failure).toBe("Token quota exhausted.");
    expect(restitution.state.tokenTotals.team.totalTokens).toBe(12);
  });

  test("rejects an invalid sequence start and incomplete checkpoint", () => {
    const restitution = progress();

    expect(() => restitution.startSequence(2, Role.Architect)).toThrow("Cannot start");
    restitution.startSequence(1, Role.Architect);
    expect(() => restitution.checkpoint(runStateFactory())).toThrow(
      "Only a completed current sequence",
    );
  });

  test("recovers only an active sequence and applies a turn override", () => {
    const restitution = progress();

    expect(() => restitution.recover(Role.Architect)).toThrow("without an active");
    restitution.startSequence(1, Role.Architect);
    restitution.interrupt("Stopped.", Role.Architect);
    expect(restitution.begin(16)).toBe(false);
    expect(restitution.state.maxTurnsPerSpecification).toBe(16);
    expect(restitution.state.status).toBe(RestitutionStatus.Running);
    expect(restitution.state.failure).toBeNull();
  });

  test("detects an active sequence that is not next", () => {
    const invalid = restitutionStateFactory();
    invalid.currentSequence = 2;
    invalid.resumeRole = Role.Architect;

    expect(() => RestitutionProgress.restore(invalid)).toThrow(
      "active restitution sequence must equal the next sequence",
    );
  });
});

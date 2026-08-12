import type { LocalCheck, RunState } from "../../domain/schemas.ts";
import type { Role } from "../../domain/roles.ts";

export function activeQualityFailure(state: RunState, role: Role): LocalCheck | null {
  const check = state.localChecks.findLast(
    (candidate) => candidate.role === role && candidate.kind === "quality-gate",
  );

  if (!check || check.passed) {
    return null;
  }

  const assignment = state.messages.findLast((message) => message.to === role);

  return assignment && assignment.createdAt >= check.createdAt ? null : check;
}

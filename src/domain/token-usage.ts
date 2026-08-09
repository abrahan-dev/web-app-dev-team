import { roles, type Role, type TokenTotals, type TokenUsage } from "./schemas.ts";

export function emptyTokenUsage(): TokenUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
}

export function emptyTokenTotals(): TokenTotals {
  return {
    team: emptyTokenUsage(),
    byRole: Object.fromEntries(roles.map((role) => [role, emptyTokenUsage()])) as Record<
      Role,
      TokenUsage
    >,
  };
}

export function addTokenUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens: left.reasoningOutputTokens + right.reasoningOutputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

export function recordTokenUsage(totals: TokenTotals, role: Role, usage: TokenUsage): void {
  totals.team = addTokenUsage(totals.team, usage);
  totals.byRole[role] = addTokenUsage(totals.byRole[role], usage);
}

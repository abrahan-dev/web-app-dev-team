export const unlimitedTurns = 0;

export function parseTurnLimit(raw: string, name: string): number {
  if (raw.trim().toLowerCase() === "unlimited") {
    return unlimitedTurns;
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer or unlimited.`);
  }

  return value;
}

export function turnLimitLabel(value: number): string {
  return value === unlimitedTurns ? "∞" : String(value);
}

export function extendedTurnLimit(current: number, requested: number): number {
  return current === unlimitedTurns || requested === unlimitedTurns
    ? unlimitedTurns
    : Math.max(current, requested);
}

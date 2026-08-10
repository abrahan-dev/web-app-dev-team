import type { Role } from "./roles.ts";
import type { RunState } from "./run/run-state.ts";
import { RunStatus } from "./workflow-values.ts";

function timestamp(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);

  return Number.isFinite(parsed) ? parsed : null;
}

function duration(start: string | null | undefined, end: string | Date): number {
  const startTime = timestamp(start);
  const endTime = end instanceof Date ? end.getTime() : timestamp(end);

  if (startTime === null || endTime === null) {
    return 0;
  }

  return Math.max(0, endTime - startTime);
}

export function runElapsedMilliseconds(state: RunState, now = new Date()): number {
  const startedAt = state.startedAt ?? state.messages[0]?.createdAt;
  const lastMessage = state.messages.at(-1)?.createdAt;
  const lastInterruption = state.interruptions.at(-1)?.createdAt;
  const lastExecution = state.executions.at(-1)?.completedAt;
  const stoppedAt = lastInterruption ?? lastMessage ?? lastExecution;
  const end = state.status === RunStatus.Running || !stoppedAt ? now : stoppedAt;

  return duration(startedAt, end);
}

export function roleElapsedMilliseconds(state: RunState, role: Role, now = new Date()): number {
  const completed = state.executions
    .filter((execution) => execution.role === role)
    .reduce((total, execution) => total + duration(execution.startedAt, execution.completedAt), 0);
  const active = state.currentRole === role ? duration(state.activeExecutionStartedAt, now) : 0;

  return completed + active;
}

export function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
  }

  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

export function formatCompactElapsed(milliseconds: number): string {
  return formatElapsed(milliseconds).replaceAll(" ", "");
}

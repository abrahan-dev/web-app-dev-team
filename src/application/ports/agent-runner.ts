import type { AgentTurn, Role, RunState, TokenUsage } from "../../domain/schemas.ts";

export interface AgentContext {
  role: Role;
  state: RunState;
  runDirectory: string;
}

export interface AgentRunner {
  run(context: AgentContext): Promise<AgentTurn | AgentRunResult>;
}

export interface AgentRunResult {
  turn: AgentTurn;
  usage: TokenUsage | null;
  observations?: AgentObservations;
}

export interface AgentObservations {
  commands: Array<{ command: string; exitCode: number | null }>;
  changedFiles: string[];
}

export class AgentRunError extends Error {
  constructor(
    message: string,
    readonly usage: TokenUsage | null,
  ) {
    super(message);
    this.name = "AgentRunError";
  }
}

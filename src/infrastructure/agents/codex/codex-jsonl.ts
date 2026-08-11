import { appendFile } from "node:fs/promises";
import { tokenUsageSchema, type TokenUsage } from "../../../domain/schemas.ts";

type JsonObject = Record<string, unknown>;

export interface InterpretedCodexEvent {
  display: string | null;
  usage: TokenUsage | null;
  threadId: string | null;
  command: { command: string; exitCode: number | null } | null;
  changedFiles: string[];
}

function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null ? (value as JsonObject) : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function compact(value: string, limit = 500): string {
  const normalized = value.replace(/\s+/g, " ").trim();

  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

function tokenCount(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

const emptyEvent = (): InterpretedCodexEvent => ({
  display: null,
  usage: null,
  threadId: null,
  command: null,
  changedFiles: [],
});

type ItemRenderer = (item: JsonObject, completed: boolean) => string | null;

const itemRenderers: Record<string, ItemRenderer> = {
  agent_message: () => null,
  reasoning: (item) => {
    const message = text(item.text) ?? text(item.summary);

    return message ? `  THINKING  ${compact(message)}` : null;
  },
  command_execution: (item, completed) => {
    const command = text(item.command) ?? "command";
    const exitCode = item.exit_code;
    const suffix = completed && typeof exitCode === "number" ? ` · exit ${exitCode}` : "";

    return `${completed ? "  COMMAND ✓" : "  COMMAND ▶"}  ${compact(command, 300)}${suffix}`;
  },
  file_change: (item, completed) => {
    const path = text(item.path) ?? text(item.file_path) ?? "workspace files";

    return `  FILE ${completed ? "✓" : "▶"}     ${path}`;
  },
  mcp_tool_call: (item, completed) => {
    const name = text(item.name) ?? text(item.tool) ?? "tool";

    return `  TOOL ${completed ? "✓" : "▶"}     ${name}`;
  },
  web_search: (item, completed) => {
    const query = text(item.query) ?? "web search";

    return `  SEARCH ${completed ? "✓" : "▶"}   ${compact(query, 300)}`;
  },
  plan: (_item, completed) =>
    completed ? "  PLAN ✓       Plan updated" : "  PLAN ▶       Updating plan",
};

function itemDescription(item: JsonObject, completed: boolean): string | null {
  const type = text(item.type);

  if (!type) {
    return null;
  }

  const renderer = itemRenderers[type];

  return renderer ? renderer(item, completed) : completed ? `  EVENT ✓      ${type}` : null;
}

function changedFiles(item: JsonObject): string[] {
  const changes = Array.isArray(item.changes) ? item.changes : [];

  return [
    text(item.path) ?? text(item.file_path),
    ...changes.map((change) => {
      const value = object(change);

      return text(value?.path) ?? text(value?.file_path);
    }),
  ].filter((path): path is string => path !== null);
}

function interpretItemEvent(event: JsonObject, completed: boolean): InterpretedCodexEvent {
  const item = object(event.item) ?? {};
  const itemType = text(item.type);
  const commandText = itemType === "command_execution" ? text(item.command) : null;

  return {
    display: itemDescription(item, completed),
    usage: null,
    threadId: null,
    command:
      completed && commandText
        ? {
            command: commandText,
            exitCode: typeof item.exit_code === "number" ? item.exit_code : null,
          }
        : null,
    changedFiles: itemType === "file_change" ? changedFiles(item) : [],
  };
}

function interpretCompletedTurn(event: JsonObject): InterpretedCodexEvent {
  const raw = object(event.usage) ?? {};
  const inputTokens = number(raw.input_tokens);
  const outputTokens = number(raw.output_tokens);
  const usage = tokenUsageSchema.parse({
    inputTokens,
    cachedInputTokens: number(raw.cached_input_tokens),
    outputTokens,
    reasoningOutputTokens: number(raw.reasoning_output_tokens),
    totalTokens: inputTokens + outputTokens,
  });

  return {
    display: `  CODEX ✓      ${tokenCount(usage.totalTokens)} tokens (${tokenCount(usage.inputTokens)} input · ${tokenCount(usage.cachedInputTokens)} cached · ${tokenCount(usage.outputTokens)} output)`,
    usage,
    threadId: null,
    command: null,
    changedFiles: [],
  };
}

function interpretFailedTurn(event: JsonObject): InterpretedCodexEvent {
  const error = object(event.error);
  const message = text(event.message) ?? text(error?.message) ?? "Codex execution failed";

  return {
    display: `  CODEX ✗      ${compact(message)}`,
    usage: null,
    threadId: null,
    command: null,
    changedFiles: [],
  };
}

type EventInterpreter = (event: JsonObject) => InterpretedCodexEvent;

const eventInterpreters: Record<string, EventInterpreter> = {
  "thread.started": (event) => ({
    display: null,
    usage: null,
    threadId: text(event.thread_id),
    command: null,
    changedFiles: [],
  }),
  "turn.started": () => ({
    display: "  CODEX ▶      Agent execution started",
    usage: null,
    threadId: null,
    command: null,
    changedFiles: [],
  }),
  "item.started": (event) => interpretItemEvent(event, false),
  "item.completed": (event) => interpretItemEvent(event, true),
  "turn.completed": interpretCompletedTurn,
  "turn.failed": interpretFailedTurn,
  error: interpretFailedTurn,
};

export function interpretCodexEvent(value: unknown): InterpretedCodexEvent {
  const event = object(value);
  const interpreter = event ? eventInterpreters[text(event.type) ?? ""] : undefined;

  return interpreter && event ? interpreter(event) : emptyEvent();
}

export interface CodexTelemetry {
  usage: TokenUsage | null;
  threadId: string | null;
  commands: Array<{
    command: string;
    exitCode: number | null;
    startedAt?: string;
    durationMs?: number;
    outputBytes?: number;
  }>;
  changedFiles: string[];
}

interface CommandEventDetails {
  eventType: string | null;
  id: string | null;
  item: JsonObject | null;
}

interface CommandTiming {
  startedAt: string;
  started: number;
}

function commandEventDetails(value: unknown): CommandEventDetails {
  const event = object(value);
  const item = object(event?.item);
  const command = text(item?.type) === "command_execution" ? text(item?.command) : null;

  return {
    eventType: text(event?.type),
    id: text(item?.id) ?? command,
    item,
  };
}

function recordCommandStart(
  details: CommandEventDetails,
  commandStarts: Map<string, CommandTiming>,
): void {
  if (details.eventType === "item.started" && details.id) {
    commandStarts.set(details.id, {
      startedAt: new Date().toISOString(),
      started: performance.now(),
    });
  }
}

function commandOutput(item: JsonObject | null): string | undefined {
  if (typeof item?.aggregated_output === "string") {
    return item.aggregated_output;
  }

  return typeof item?.output === "string" ? item.output : undefined;
}

function completedCommand(
  interpreted: InterpretedCodexEvent,
  details: CommandEventDetails,
  commandStarts: Map<string, CommandTiming>,
): CodexTelemetry["commands"][number] | null {
  if (!interpreted.command) {
    return null;
  }

  const timing = details.id ? commandStarts.get(details.id) : undefined;
  const output = commandOutput(details.item);

  return {
    ...interpreted.command,
    ...(timing
      ? {
          startedAt: timing.startedAt,
          durationMs: Math.round(performance.now() - timing.started),
        }
      : {}),
    ...(output === undefined ? {} : { outputBytes: new TextEncoder().encode(output).byteLength }),
  };
}

async function appendEventDisplay(
  logPath: string,
  interpreted: InterpretedCodexEvent,
  command: CodexTelemetry["commands"][number] | null,
): Promise<void> {
  if (!interpreted.display) {
    return;
  }

  const duration = command?.durationMs;
  await appendFile(
    logPath,
    `${interpreted.display}${duration === undefined ? "" : ` · ${duration}ms`}\n`,
  );
}

export async function consumeCodexJsonl(
  stream: ReadableStream<Uint8Array>,
  logPath: string,
  onFirstEvent?: () => Promise<void>,
): Promise<CodexTelemetry> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let usage: TokenUsage | null = null;
  let threadId: string | null = null;
  const commands: CodexTelemetry["commands"] = [];
  const changedFiles = new Set<string>();
  const commandStarts = new Map<string, CommandTiming>();
  let firstEventSeen = false;

  async function announceFirstEvent(): Promise<void> {
    if (firstEventSeen) {
      return;
    }

    firstEventSeen = true;
    await onFirstEvent?.();
  }

  async function consumeLine(line: string): Promise<void> {
    if (!line.trim()) {
      return;
    }

    try {
      await announceFirstEvent();
      const value = JSON.parse(line);
      const details = commandEventDetails(value);
      recordCommandStart(details, commandStarts);
      const interpreted = interpretCodexEvent(value);
      const command = completedCommand(interpreted, details, commandStarts);
      await appendEventDisplay(logPath, interpreted, command);

      usage = interpreted.usage ?? usage;
      threadId = interpreted.threadId ?? threadId;

      if (command) {
        commands.push(command);
        commandStarts.delete(details.id ?? "");
      }

      for (const path of interpreted.changedFiles) {
        changedFiles.add(path);
      }
    } catch {
      await appendFile(logPath, "  CODEX !      Unrecognized JSONL event\n");
    }
  }

  while (true) {
    const { done, value } = await reader.read();
    pending += decoder.decode(value, { stream: !done });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";

    for (const line of lines) {
      await consumeLine(line);
    }

    if (done) {
      await consumeLine(pending);

      return { usage, threadId, commands, changedFiles: [...changedFiles] };
    }
  }
}

import { appendFile } from "node:fs/promises";
import { tokenUsageSchema, type TokenUsage } from "../../../domain/schemas.ts";

type JsonObject = Record<string, unknown>;

export interface InterpretedCodexEvent {
  display: string | null;
  usage: TokenUsage | null;
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
    display: `  CODEX ✓      ${tokenCount(usage.totalTokens)} tokens (${tokenCount(usage.inputTokens)} input · ${tokenCount(usage.outputTokens)} output)`,
    usage,
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
    command: null,
    changedFiles: [],
  };
}

type EventInterpreter = (event: JsonObject) => InterpretedCodexEvent;

const eventInterpreters: Record<string, EventInterpreter> = {
  "turn.started": () => ({
    display: "  CODEX ▶      Agent execution started",
    usage: null,
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
  commands: Array<{ command: string; exitCode: number | null }>;
  changedFiles: string[];
}

export async function consumeCodexJsonl(
  stream: ReadableStream<Uint8Array>,
  logPath: string,
): Promise<CodexTelemetry> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let usage: TokenUsage | null = null;
  const commands: CodexTelemetry["commands"] = [];
  const changedFiles = new Set<string>();

  async function consumeLine(line: string): Promise<void> {
    if (!line.trim()) {
      return;
    }

    try {
      const interpreted = interpretCodexEvent(JSON.parse(line));

      if (interpreted.display) {
        await appendFile(logPath, `${interpreted.display}\n`);
      }

      usage = interpreted.usage ?? usage;

      if (interpreted.command) {
        commands.push(interpreted.command);
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

      return { usage, commands, changedFiles: [...changedFiles] };
    }
  }
}

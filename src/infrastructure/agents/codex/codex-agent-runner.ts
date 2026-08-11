import { appendFile, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  architectTurnSchema,
  backendCoderTurnSchema,
  dataEngineerTurnSchema,
  frontendCoderTurnSchema,
  qaTurnSchema,
  specifierTurnSchema,
  uiDesignerTurnSchema,
  type AgentTurn,
} from "../../../domain/schemas.ts";
import { Role } from "../../../domain/roles.ts";
import {
  AgentRunError,
  type AgentContext,
  type AgentRunner,
} from "../../../application/ports/agent-runner.ts";
import {
  buildAgentPrompt,
  consecutiveQualityFailures,
  roleExecutionMetadata,
  type RoleExecutionMetadata,
} from "../prompt-builder.ts";
import { consumeCodexJsonl } from "./codex-jsonl.ts";
import { agentSchemasRoot } from "../../../package-paths.ts";

interface CodexProcess {
  stdin: {
    write(value: string): unknown;
    end(): unknown;
  };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
}

export type CodexProcessSpawner = (command: string[], workspace: string) => CodexProcess;
export type AgentPromptBuilder = (
  context: AgentContext,
  execution: RoleExecutionMetadata,
) => Promise<string>;
export const modelReasoningEfforts = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export type ModelReasoningEffort = (typeof modelReasoningEfforts)[number];

export interface CodexModelProfile {
  model?: string;
  reasoningEffort: ModelReasoningEffort;
}

export function parseModelReasoningEffort(
  value: string,
  settingName = "WEB_APP_DEV_TEAM_MODEL_REASONING_EFFORT",
): ModelReasoningEffort {
  if (modelReasoningEfforts.includes(value as ModelReasoningEffort)) {
    return value as ModelReasoningEffort;
  }

  throw new Error(`${settingName} must be one of: ${modelReasoningEfforts.join(", ")}.`);
}

function usesPlannerProfile(role: Role): boolean {
  return role === Role.Specifier || role === Role.Architect;
}

export function codexModelProfile(
  role: Role,
  environment: NodeJS.ProcessEnv = process.env,
): CodexModelProfile {
  if (usesPlannerProfile(role)) {
    const effort =
      environment.WEB_APP_DEV_TEAM_PLANNER_MODEL_REASONING_EFFORT ??
      environment.WEB_APP_DEV_TEAM_MODEL_REASONING_EFFORT ??
      "high";

    return {
      model: environment.WEB_APP_DEV_TEAM_PLANNER_MODEL ?? environment.WEB_APP_DEV_TEAM_MODEL,
      reasoningEffort: parseModelReasoningEffort(
        effort,
        "WEB_APP_DEV_TEAM_PLANNER_MODEL_REASONING_EFFORT",
      ),
    };
  }

  return {
    model: environment.WEB_APP_DEV_TEAM_MODEL,
    reasoningEffort: parseModelReasoningEffort(
      environment.WEB_APP_DEV_TEAM_MODEL_REASONING_EFFORT ?? "high",
    ),
  };
}

async function savedSessionId(runDirectory: string, role: Role): Promise<string | null> {
  try {
    const value = await readFile(resolve(runDirectory, `${role}-codex-session.txt`), "utf8");

    return value.trim() || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function assignmentStartedAfterLastExecution(context: AgentContext): boolean {
  const execution = context.state.executions.findLast(
    (candidate) => candidate.role === context.role,
  );
  const assignment = context.state.messages.findLast((message) => message.to === context.role);

  return Boolean(execution && assignment && assignment.createdAt > execution.completedAt);
}

async function selectSession(context: AgentContext): Promise<{
  savedId: string | null;
  sessionId: string | null;
}> {
  const savedId = await savedSessionId(context.runDirectory, context.role);

  return {
    savedId,
    sessionId:
      savedId &&
      !assignmentStartedAfterLastExecution(context) &&
      consecutiveQualityFailures(context) < 2
        ? savedId
        : null,
  };
}

async function discardReplacedSession(
  sessionPath: string,
  savedId: string | null,
  sessionId: string | null,
): Promise<void> {
  if (savedId && sessionId === null) {
    await rm(sessionPath, { force: true });
  }
}

function commonArguments(
  schemaPath: string,
  outputPath: string,
  reasoningEffort: ModelReasoningEffort,
  model?: string,
): string[] {
  const arguments_ = [
    "--skip-git-repo-check",
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputPath,
    "--json",
    "--config",
    `model_reasoning_effort="${reasoningEffort}"`,
  ];

  if (model) {
    arguments_.push("--model", model);
  }

  return arguments_;
}

function codexArguments(options: {
  sessionId: string | null;
  role: Role;
  workspace: string;
  schemaPath: string;
  outputPath: string;
  reasoningEffort: ModelReasoningEffort;
  model?: string;
}): string[] {
  const common = commonArguments(
    options.schemaPath,
    options.outputPath,
    options.reasoningEffort,
    options.model,
  );

  if (options.sessionId) {
    return ["exec", "resume", ...common, options.sessionId, "-"];
  }

  return [
    "exec",
    ...common,
    "--sandbox",
    options.role === Role.Specifier ||
    options.role === Role.Architect ||
    options.role === Role.UiDesigner
      ? "read-only"
      : "workspace-write",
    "--cd",
    options.workspace,
    "--color",
    "never",
    "-",
  ];
}

const spawnCodexProcess: CodexProcessSpawner = (command, workspace) =>
  Bun.spawn(command, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    cwd: workspace,
  });

async function pipeToLog(stream: ReadableStream<Uint8Array>, logPath: string): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      const remaining = decoder.decode();

      if (remaining) {
        await appendFile(logPath, remaining);
      }

      break;
    }

    await appendFile(logPath, decoder.decode(value, { stream: true }));
  }
}

export class CodexAgentRunner implements AgentRunner {
  constructor(
    private readonly spawn: CodexProcessSpawner = spawnCodexProcess,
    private readonly promptBuilder: AgentPromptBuilder = buildAgentPrompt,
  ) {}

  async run(context: AgentContext) {
    const { role, state, runDirectory } = context;
    const logPath = resolve(runDirectory, "logs", `${role}.log`);
    const outputPath = resolve(runDirectory, `${state.turns}-${role}-output.json`);
    const schemaPath = resolve(agentSchemasRoot, `${role}-output.schema.json`);
    const sessionPath = resolve(runDirectory, `${role}-codex-session.txt`);
    const { savedId, sessionId } = await selectSession(context);
    const { model, reasoningEffort } = codexModelProfile(role);
    const promptStarted = performance.now();
    await appendFile(logPath, "  STARTUP ▶    Preparing role instructions and workspace context\n");
    const prompt = await this.promptBuilder(
      context,
      roleExecutionMetadata(context, sessionId !== null),
    );
    const promptBytes = new TextEncoder().encode(prompt).byteLength;
    await appendFile(
      logPath,
      `  STARTUP ✓    Agent prompt ready · ${promptBytes} bytes · ${Math.round(performance.now() - promptStarted)}ms\n`,
    );
    const args = codexArguments({
      sessionId,
      role,
      workspace: state.workspace,
      schemaPath,
      outputPath,
      reasoningEffort,
      model,
    });

    await discardReplacedSession(sessionPath, savedId, sessionId);

    await appendFile(
      logPath,
      `  STARTUP ▶    ${sessionId ? "Resuming Codex session" : "Starting Codex CLI"}\n`,
    );
    const child = this.spawn(["codex", ...args], state.workspace);
    const cliStarted = performance.now();
    child.stdin.write(prompt);
    child.stdin.end();
    await appendFile(logPath, "  STARTUP …    Waiting for the first Codex event\n");

    const [telemetry] = await Promise.all([
      consumeCodexJsonl(child.stdout, logPath, () =>
        appendFile(
          logPath,
          `  STARTUP ✓    First Codex event · ${Math.round(performance.now() - cliStarted)}ms\n`,
        ),
      ),
      pipeToLog(child.stderr, logPath),
    ]);
    const exitCode = await child.exited;

    if (telemetry.threadId) {
      await writeFile(sessionPath, `${telemetry.threadId}\n`, "utf8");
    }

    if (exitCode !== 0) {
      throw new AgentRunError(
        `${role} exited with code ${exitCode}. See ${logPath}.`,
        telemetry.usage,
      );
    }

    try {
      const raw = await readFile(outputPath, "utf8");
      const schemas: Record<Role, { parse(value: unknown): AgentTurn }> = {
        [Role.Specifier]: specifierTurnSchema,
        [Role.Architect]: architectTurnSchema,
        [Role.UiDesigner]: uiDesignerTurnSchema,
        [Role.DataEngineer]: dataEngineerTurnSchema,
        [Role.BackendCoder]: backendCoderTurnSchema,
        [Role.FrontendCoder]: frontendCoderTurnSchema,
        [Role.Qa]: qaTurnSchema,
      };

      return {
        turn: schemas[role].parse(JSON.parse(raw)),
        usage: telemetry.usage,
        observations: {
          commands: telemetry.commands,
          changedFiles: telemetry.changedFiles,
        },
      };
    } catch (error) {
      throw new AgentRunError(
        `${role} returned invalid structured output: ${error instanceof Error ? error.message : String(error)}`,
        telemetry.usage,
      );
    }
  }
}

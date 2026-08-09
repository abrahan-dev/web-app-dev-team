import { appendFile, readFile } from "node:fs/promises";
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
import { buildAgentPrompt } from "../prompt-builder.ts";
import { consumeCodexJsonl } from "./codex-jsonl.ts";

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
export type AgentPromptBuilder = (context: AgentContext) => Promise<string>;

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
    const schemaPath = resolve(
      import.meta.dir,
      "../../../../assets/agents/output-schemas",
      `${role}-output.schema.json`,
    );
    const model = process.env.WEB_APP_DEV_TEAM_MODEL;
    const args = [
      "exec",
      "--ephemeral",
      "--sandbox",
      role === Role.Specifier || role === Role.Architect || role === Role.UiDesigner
        ? "read-only"
        : "workspace-write",
      "--cd",
      state.workspace,
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath,
      "--color",
      "never",
      "--json",
    ];

    if (model) {
      args.push("--model", model);
    }

    args.push("-");
    const child = this.spawn(["codex", ...args], state.workspace);
    child.stdin.write(await this.promptBuilder(context));
    child.stdin.end();

    const [telemetry] = await Promise.all([
      consumeCodexJsonl(child.stdout, logPath),
      pipeToLog(child.stderr, logPath),
    ]);
    const exitCode = await child.exited;

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

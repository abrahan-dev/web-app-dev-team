import { afterEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Role } from "../../../../src/domain/roles.ts";
import {
  AgentRunError,
  type AgentContext,
} from "../../../../src/application/ports/agent-runner.ts";
import {
  CodexAgentRunner,
  type CodexProcessSpawner,
} from "../../../../src/infrastructure/agents/codex/codex-agent-runner.ts";
import { backendHandoffFactory, runStateFactory } from "../../../support/domain-factories.ts";
import { TemporaryWorkspaceManager } from "../../../support/temporary-workspaces.ts";

const temporary = new TemporaryWorkspaceManager();
const originalModel = process.env.WEB_APP_DEV_TEAM_MODEL;

afterEach(async () => {
  await temporary.cleanup();

  if (originalModel === undefined) {
    delete process.env.WEB_APP_DEV_TEAM_MODEL;
  } else {
    process.env.WEB_APP_DEV_TEAM_MODEL = originalModel;
  }
});

function stream(value: string): ReadableStream<Uint8Array> {
  return new Blob([value]).stream();
}

async function context(): Promise<AgentContext> {
  const workspace = await temporary.create("codex-agent-workspace-");
  const runDirectory = await temporary.create("codex-agent-run-");
  await mkdir(resolve(runDirectory, "logs"), { recursive: true });

  return {
    role: Role.BackendCoder,
    state: runStateFactory({ workspace }),
    runDirectory,
  };
}

function processSpawner(options: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  commands?: string[][];
  prompts?: string[];
}): CodexProcessSpawner {
  return (command) => {
    options.commands?.push(command);

    return {
      stdin: {
        write(value) {
          options.prompts?.push(value);
        },
        end() {},
      },
      stdout: stream(options.stdout ?? ""),
      stderr: stream(options.stderr ?? ""),
      exited: Promise.resolve(options.exitCode ?? 0),
    };
  };
}

describe("Codex agent runner", () => {
  test("builds the command and returns validated observations", async () => {
    const agentContext = await context();
    await Bun.write(
      resolve(agentContext.runDirectory, "0-backend-coder-output.json"),
      JSON.stringify(backendHandoffFactory()),
    );
    const commands: string[][] = [];
    const prompts: string[] = [];
    process.env.WEB_APP_DEV_TEAM_MODEL = "test-model";
    const stdout = [
      JSON.stringify({
        type: "item.completed",
        item: { type: "command_execution", command: "bun test", exit_code: 0 },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "file_change", path: "src/domain/order.ts" },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 8, output_tokens: 2 },
      }),
    ].join("\n");
    const runner = new CodexAgentRunner(
      processSpawner({ stdout, commands, prompts }),
      async () => "TEST PROMPT",
    );

    const result = await runner.run(agentContext);

    expect("turn" in result && result.turn.role).toBe(Role.BackendCoder);
    expect("usage" in result && result.usage?.totalTokens).toBe(10);
    expect("observations" in result && result.observations).toEqual({
      commands: [{ command: "bun test", exitCode: 0 }],
      changedFiles: ["src/domain/order.ts"],
    });
    expect(commands[0]).toContain("--model");
    expect(commands[0]).toContain("test-model");
    expect(commands[0]).toContain("workspace-write");
    expect(prompts).toEqual(["TEST PROMPT"]);
  });

  test("reports a nonzero process exit with token usage", async () => {
    const agentContext = await context();
    const runner = new CodexAgentRunner(
      processSpawner({
        exitCode: 7,
        stdout: JSON.stringify({
          type: "turn.completed",
          usage: { input_tokens: 8, output_tokens: 2 },
        }),
      }),
      async () => "TEST PROMPT",
    );

    try {
      await runner.run(agentContext);
      throw new Error("Expected the agent run to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentRunError);
      expect((error as AgentRunError).usage?.totalTokens).toBe(10);
      expect((error as Error).message).toContain("exited with code 7");
    }
  });

  test("rejects invalid structured output", async () => {
    const agentContext = await context();
    await Bun.write(resolve(agentContext.runDirectory, "0-backend-coder-output.json"), "{}");
    const runner = new CodexAgentRunner(processSpawner({}), async () => "TEST PROMPT");

    expect(runner.run(agentContext)).rejects.toThrow("invalid structured output");
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Role } from "../../../../src/domain/roles.ts";
import { RunStatus, TurnDecision } from "../../../../src/domain/workflow-values.ts";
import {
  AgentRunError,
  type AgentContext,
} from "../../../../src/application/ports/agent-runner.ts";
import {
  codexModelProfile,
  CodexAgentRunner,
  type CodexProcessSpawner,
} from "../../../../src/infrastructure/agents/codex/codex-agent-runner.ts";
import { backendHandoffFactory, runStateFactory } from "../../../support/domain-factories.ts";
import { TemporaryWorkspaceManager } from "../../../support/temporary-workspaces.ts";

const temporary = new TemporaryWorkspaceManager();
const originalModel = process.env.WEB_APP_DEV_TEAM_MODEL;
const originalReasoningEffort = process.env.WEB_APP_DEV_TEAM_MODEL_REASONING_EFFORT;
const originalPlannerModel = process.env.WEB_APP_DEV_TEAM_PLANNER_MODEL;
const originalPlannerReasoningEffort = process.env.WEB_APP_DEV_TEAM_PLANNER_MODEL_REASONING_EFFORT;

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

afterEach(async () => {
  await temporary.cleanup();

  restoreEnvironment("WEB_APP_DEV_TEAM_MODEL", originalModel);
  restoreEnvironment("WEB_APP_DEV_TEAM_MODEL_REASONING_EFFORT", originalReasoningEffort);
  restoreEnvironment("WEB_APP_DEV_TEAM_PLANNER_MODEL", originalPlannerModel);
  restoreEnvironment(
    "WEB_APP_DEV_TEAM_PLANNER_MODEL_REASONING_EFFORT",
    originalPlannerReasoningEffort,
  );
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
  test("selects planner and execution model profiles by role", () => {
    const environment: NodeJS.ProcessEnv = {
      WEB_APP_DEV_TEAM_MODEL: "execution-model",
      WEB_APP_DEV_TEAM_MODEL_REASONING_EFFORT: "medium",
      WEB_APP_DEV_TEAM_PLANNER_MODEL: "planner-model",
      WEB_APP_DEV_TEAM_PLANNER_MODEL_REASONING_EFFORT: "xhigh",
    };

    expect(codexModelProfile(Role.Specifier, environment)).toEqual({
      model: "planner-model",
      reasoningEffort: "xhigh",
    });
    expect(codexModelProfile(Role.Architect, environment)).toEqual({
      model: "planner-model",
      reasoningEffort: "xhigh",
    });
    expect(codexModelProfile(Role.BackendCoder, environment)).toEqual({
      model: "execution-model",
      reasoningEffort: "medium",
    });
  });

  test("uses the execution profile when planner values are absent", () => {
    expect(
      codexModelProfile(Role.Specifier, {
        WEB_APP_DEV_TEAM_MODEL: "execution-model",
        WEB_APP_DEV_TEAM_MODEL_REASONING_EFFORT: "high",
      }),
    ).toEqual({ model: "execution-model", reasoningEffort: "high" });
  });

  test("builds the command and returns validated observations", async () => {
    const agentContext = await context();
    await Bun.write(
      resolve(agentContext.runDirectory, "0-backend-coder-output.json"),
      JSON.stringify(backendHandoffFactory()),
    );
    const commands: string[][] = [];
    const prompts: string[] = [];
    process.env.WEB_APP_DEV_TEAM_MODEL = "test-model";
    process.env.WEB_APP_DEV_TEAM_MODEL_REASONING_EFFORT = "xhigh";
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
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
      async (_context, execution) => {
        expect(execution).toMatchObject({
          roleTurn: 1,
          initialRoleTurn: true,
          newCodexSession: true,
          codexSessionResumed: false,
          recoveryAttempt: false,
        });

        return "TEST PROMPT";
      },
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
    expect(commands[0]).toContain("--config");
    expect(commands[0]).toContain('model_reasoning_effort="xhigh"');
    expect(commands[0]).toContain("--skip-git-repo-check");
    expect(commands[0]).toContain("workspace-write");
    expect(commands[0]).not.toContain("--ephemeral");
    expect(prompts).toEqual(["TEST PROMPT"]);
    expect(
      await readFile(resolve(agentContext.runDirectory, "backend-coder-codex-session.txt"), "utf8"),
    ).toBe("thread-123\n");
    const log = await readFile(
      resolve(agentContext.runDirectory, "logs", "backend-coder.log"),
      "utf8",
    );
    expect(log).toContain("STARTUP ▶    Preparing role instructions and workspace context");
    expect(log).toContain("STARTUP ✓    Agent prompt ready");
    expect(log).toContain("bytes");
    expect(log).toContain("STARTUP ▶    Starting Codex CLI");
    expect(log).toContain("STARTUP …    Waiting for the first Codex event");
    expect(log).toContain("STARTUP ✓    First Codex event");
  });

  test("resumes the saved session for a later role turn", async () => {
    const agentContext = await context();
    await Bun.write(
      resolve(agentContext.runDirectory, "backend-coder-codex-session.txt"),
      "thread-123\n",
    );
    await Bun.write(
      resolve(agentContext.runDirectory, "0-backend-coder-output.json"),
      JSON.stringify(backendHandoffFactory()),
    );
    const commands: string[][] = [];
    const runner = new CodexAgentRunner(
      processSpawner({
        commands,
        stdout: JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      }),
      async (_context, execution) => {
        expect(execution).toMatchObject({
          roleTurn: 1,
          initialRoleTurn: true,
          newCodexSession: false,
          codexSessionResumed: true,
          recoveryAttempt: false,
        });

        return "CORRECTION PROMPT";
      },
    );

    await runner.run(agentContext);

    expect(commands[0]?.slice(0, 3)).toEqual(["codex", "exec", "resume"]);
    expect(commands[0]).toContain("thread-123");
    expect(commands[0]).not.toContain("--cd");
    expect(commands[0]).not.toContain("--sandbox");
  });

  test("starts a fresh session for work routed back by QA", async () => {
    const agentContext = await context();
    agentContext.state.turns = 1;
    agentContext.state.executions.push({
      sequence: 1,
      turn: 1,
      role: Role.BackendCoder,
      startedAt: "2026-08-11T10:00:00.000Z",
      completedAt: "2026-08-11T10:01:00.000Z",
      status: RunStatus.Completed,
      usage: null,
      commands: [],
      changedFiles: [],
    });
    agentContext.state.messages.push({
      id: "qa-correction",
      sequence: 1,
      from: Role.Qa,
      to: Role.BackendCoder,
      createdAt: "2026-08-11T10:02:00.000Z",
      turn: {
        role: Role.Qa,
        summary: "Backend correction required.",
        scenariosTested: [],
        commands: ["bun test"],
        failures: ["The endpoint returns 500."],
        failureOwner: Role.BackendCoder,
        artifacts: [],
        evidence: ["bun test: exit 1"],
        decision: TurnDecision.Handoff,
        nextRole: Role.BackendCoder,
        reason: "Correct the endpoint.",
      },
    });
    await Bun.write(
      resolve(agentContext.runDirectory, "backend-coder-codex-session.txt"),
      "thread-old\n",
    );
    await Bun.write(
      resolve(agentContext.runDirectory, "1-backend-coder-output.json"),
      JSON.stringify(backendHandoffFactory()),
    );
    const commands: string[][] = [];
    const prompts: string[] = [];
    const runner = new CodexAgentRunner(
      processSpawner({
        commands,
        prompts,
        stdout: JSON.stringify({ type: "thread.started", thread_id: "thread-new" }),
      }),
    );

    await runner.run(agentContext);

    expect(commands[0]?.slice(0, 2)).toEqual(["codex", "exec"]);
    expect(commands[0]).not.toContain("resume");
    expect(commands[0]).not.toContain("thread-old");
    expect(prompts[0]).toContain("focused correction assignment");
    expect(
      await readFile(resolve(agentContext.runDirectory, "backend-coder-codex-session.txt"), "utf8"),
    ).toBe("thread-new\n");
  });

  test("starts a compact fresh session after one quality failure", async () => {
    const agentContext = await context();
    agentContext.state.turns = 1;
    agentContext.state.executions.push({
      sequence: 1,
      turn: 1,
      role: Role.BackendCoder,
      startedAt: "2026-08-11T10:00:00.000Z",
      completedAt: "2026-08-11T10:01:00.000Z",
      status: RunStatus.Completed,
      usage: null,
      commands: [],
      changedFiles: [],
    });
    agentContext.state.localChecks.push({
      sequence: 1,
      turn: 1,
      role: Role.BackendCoder,
      kind: "quality-gate",
      createdAt: "2026-08-11T10:01:30.000Z",
      passed: false,
      summary: "Complexity failed.",
      details: ["createOrder has complexity 11."],
      commands: [],
    });
    await Bun.write(
      resolve(agentContext.runDirectory, "backend-coder-codex-session.txt"),
      "thread-old\n",
    );
    await Bun.write(
      resolve(agentContext.runDirectory, "1-backend-coder-output.json"),
      JSON.stringify(backendHandoffFactory()),
    );
    const commands: string[][] = [];
    const prompts: string[] = [];
    const runner = new CodexAgentRunner(
      processSpawner({
        commands,
        prompts,
        stdout: JSON.stringify({ type: "thread.started", thread_id: "thread-new" }),
      }),
    );

    await runner.run(agentContext);

    expect(commands[0]?.slice(0, 2)).toEqual(["codex", "exec"]);
    expect(commands[0]).not.toContain("resume");
    expect(prompts[0]).toContain("focused correction assignment");
    expect(prompts[0]).toContain("Consecutive quality failures: 1");
    expect(prompts[0]).toContain("createOrder has complexity 11");
    expect(prompts[0]).not.toContain("Deterministic workspace bootstrap:");
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

  test("rejects an unsupported model reasoning effort", async () => {
    process.env.WEB_APP_DEV_TEAM_MODEL_REASONING_EFFORT = "extreme";
    const runner = new CodexAgentRunner(processSpawner({}), async () => "TEST PROMPT");

    expect(runner.run(await context())).rejects.toThrow(
      "WEB_APP_DEV_TEAM_MODEL_REASONING_EFFORT must be one of",
    );
  });
});

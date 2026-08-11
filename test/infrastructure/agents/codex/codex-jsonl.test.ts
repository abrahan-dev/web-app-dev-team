import { afterEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  consumeCodexJsonl,
  interpretCodexEvent,
} from "../../../../src/infrastructure/agents/codex/codex-jsonl.ts";
import { TemporaryWorkspaceManager } from "../../../support/temporary-workspaces.ts";

const temporary = new TemporaryWorkspaceManager();

afterEach(() => temporary.cleanup());

describe("Codex JSONL rendering", () => {
  test("extracts exact turn usage without double-counting token subsets", () => {
    const result = interpretCodexEvent({
      type: "turn.completed",
      usage: {
        input_tokens: 24_763,
        cached_input_tokens: 24_448,
        output_tokens: 122,
        reasoning_output_tokens: 20,
      },
    });

    expect(result.usage).toEqual({
      inputTokens: 24_763,
      cachedInputTokens: 24_448,
      outputTokens: 122,
      reasoningOutputTokens: 20,
      totalTokens: 24_885,
    });
    expect(result.display).toContain("24,885 tokens");
    expect(result.display).toContain("24,448 cached");
  });

  test("shows operational events but leaves final agent JSON to the handoff renderer", () => {
    expect(
      interpretCodexEvent({
        type: "item.started",
        item: { type: "command_execution", command: "bun test" },
      }).display,
    ).toContain("COMMAND");
    expect(
      interpretCodexEvent({
        type: "item.completed",
        item: { type: "agent_message", text: '{"role":"coder"}' },
      }).display,
    ).toBeNull();
  });

  test("extracts completed commands and changed files as deterministic observations", () => {
    expect(
      interpretCodexEvent({
        type: "item.completed",
        item: { type: "command_execution", command: "bun test", exit_code: 0 },
      }).command,
    ).toEqual({ command: "bun test", exitCode: 0 });
    expect(
      interpretCodexEvent({
        type: "item.completed",
        item: {
          type: "file_change",
          changes: [{ path: "src/domain/order.ts" }, { path: "test/domain/order.test.ts" }],
        },
      }).changedFiles,
    ).toEqual(["src/domain/order.ts", "test/domain/order.test.ts"]);
  });

  test("extracts the persistent Codex thread ID", () => {
    expect(interpretCodexEvent({ type: "thread.started", thread_id: "thread-123" }).threadId).toBe(
      "thread-123",
    );
  });

  test.each([
    ["reasoning", { type: "reasoning", summary: "Inspect the state." }, "THINKING"],
    ["MCP tool", { type: "mcp_tool_call", name: "create_pull_request" }, "TOOL"],
    ["web search", { type: "web_search", query: "Bun documentation" }, "SEARCH"],
    ["plan", { type: "plan" }, "PLAN"],
  ])("renders a completed %s event", (_label, item, expected) => {
    expect(interpretCodexEvent({ type: "item.completed", item }).display).toContain(expected);
  });

  test("consumes JSONL, deduplicates files and reports malformed lines", async () => {
    const root = await temporary.create("codex-jsonl-");
    const logPath = resolve(root, "agent.log");
    const lines = [
      "not-json",
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "file_change", path: "src/order.ts" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "file_change", path: "src/order.ts" },
      }),
      JSON.stringify({ type: "turn.failed", error: { message: "quota exhausted" } }),
    ].join("\n");

    const telemetry = await consumeCodexJsonl(new Blob([lines]).stream(), logPath);
    const log = await readFile(logPath, "utf8");

    expect(telemetry.changedFiles).toEqual(["src/order.ts"]);
    expect(telemetry.threadId).toBe("thread-123");
    expect(log).toContain("Unrecognized JSONL event");
    expect(log).toContain("Agent execution started");
    expect(log).toContain("quota exhausted");
  });

  test("records command timing and output size when Codex supplies command output", async () => {
    const root = await temporary.create("codex-jsonl-command-timing-");
    const logPath = resolve(root, "agent.log");
    const lines = [
      JSON.stringify({
        type: "item.started",
        item: { id: "command-1", type: "command_execution", command: "bun test" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          id: "command-1",
          type: "command_execution",
          command: "bun test",
          exit_code: 0,
          aggregated_output: "ok",
        },
      }),
    ].join("\n");

    const telemetry = await consumeCodexJsonl(new Blob([lines]).stream(), logPath);

    expect(telemetry.commands[0]).toMatchObject({
      command: "bun test",
      exitCode: 0,
      outputBytes: 2,
    });
    expect(telemetry.commands[0]?.startedAt).toBeString();
    expect(telemetry.commands[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(await readFile(logPath, "utf8")).toContain("ms");
  });
});

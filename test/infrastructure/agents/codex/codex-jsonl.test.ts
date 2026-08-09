import { describe, expect, test } from "bun:test";
import { interpretCodexEvent } from "../../../../src/infrastructure/agents/codex/codex-jsonl.ts";

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
});

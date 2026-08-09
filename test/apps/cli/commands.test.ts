import { afterEach, describe, expect, test } from "bun:test";
import { CliArguments, parseMaxTurns } from "../../../src/apps/cli/commands.ts";

const originalMaxTurns = process.env.WEB_APP_DEV_TEAM_MAX_TURNS;

afterEach(() => {
  if (originalMaxTurns === undefined) {
    delete process.env.WEB_APP_DEV_TEAM_MAX_TURNS;
  } else {
    process.env.WEB_APP_DEV_TEAM_MAX_TURNS = originalMaxTurns;
  }
});

describe("CLI arguments", () => {
  test("parses commands, flags and required values", () => {
    const arguments_ = new CliArguments([
      "bun",
      "index.ts",
      "demo",
      "--prompt",
      "Build it",
      "--detach",
    ]);

    expect(arguments_.command).toBe("demo");
    expect(arguments_.optional("--prompt")).toBe("Build it");
    expect(arguments_.required("--prompt")).toBe("Build it");
    expect(arguments_.has("--detach")).toBe(true);
    expect(() => arguments_.required("--workspace")).toThrow(
      "Missing required argument --workspace",
    );
  });

  test("keeps max-turn precedence and validation explicit", () => {
    process.env.WEB_APP_DEV_TEAM_MAX_TURNS = "20";

    expect(new CliArguments(["bun", "index.ts", "demo"]).maxTurns()).toBe(20);
    expect(new CliArguments(["bun", "index.ts", "demo", "--max-turns", "8"]).maxTurns()).toBe(8);
    expect(() => parseMaxTurns("0")).toThrow("must be a positive integer");
  });
});

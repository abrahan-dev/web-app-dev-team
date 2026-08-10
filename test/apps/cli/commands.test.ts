import { afterEach, describe, expect, test } from "bun:test";
import {
  CliArguments,
  helpText,
  packageVersion,
  parseMaxTurns,
  runCli,
  specificationsDirectory,
  tokenSummary,
  type CommandHandlers,
} from "../../../src/apps/cli/commands.ts";
import { emptyTokenTotals } from "../../../src/domain/token-usage.ts";
import { expectedPackageVersion } from "../../support/package-metadata.ts";

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
    delete process.env.WEB_APP_DEV_TEAM_MAX_TURNS;
    expect(new CliArguments(["bun", "index.ts", "demo"]).maxTurns()).toBe(100);

    process.env.WEB_APP_DEV_TEAM_MAX_TURNS = "20";

    expect(new CliArguments(["bun", "index.ts", "demo"]).maxTurns()).toBe(20);
    expect(new CliArguments(["bun", "index.ts", "demo", "--max-turns", "8"]).maxTurns()).toBe(8);
    expect(parseMaxTurns("unlimited")).toBe(0);
    expect(() => parseMaxTurns("0")).toThrow("must be a positive integer or unlimited");
    expect(() => parseMaxTurns("1.5")).toThrow("must be a positive integer or unlimited");
    expect(() => parseMaxTurns("invalid")).toThrow("must be a positive integer or unlimited");
  });

  test("dispatches every public command", async () => {
    const calls: string[] = [];
    const names = [
      "--help",
      "--version",
      "attach",
      "configure",
      "doctor",
      "run",
      "status",
      "git-resume",
      "restore:status",
      "restore-status",
      "restore-resume",
      "restore",
      "restore:resume",
      "git:resume",
      "resume",
      "tmux",
      "demo",
    ];
    const handlers = Object.fromEntries(
      names.map((name) => [
        name,
        async (arguments_: CliArguments) => {
          calls.push(arguments_.command);
        },
      ]),
    ) as CommandHandlers;

    for (const name of names) {
      await runCli(["bun", "index.ts", name], handlers);
    }

    expect(calls).toEqual(names);
    expect(runCli(["bun", "index.ts", "unknown"], handlers)).rejects.toThrow(
      "Unknown command unknown",
    );
  });

  test("uses run by default and formats paths and token totals", async () => {
    let command = "";
    await runCli(["bun", "index.ts"], {
      run: async (arguments_) => {
        command = arguments_.command;
      },
    });
    const totals = emptyTokenTotals();
    totals.team.totalTokens = 12_345;

    expect(command).toBe("run");
    expect(specificationsDirectory("/tmp/specifications/manifest.json")).toBe(
      "/tmp/specifications",
    );
    expect(specificationsDirectory("/tmp/specifications")).toBe("/tmp/specifications");
    expect(tokenSummary(totals)).toContain("team 12,345");
  });

  test("provides package help and version", async () => {
    expect(helpText).toContain("web-app-dev-team run");
    expect(helpText).toContain("web-app-dev-team doctor");
    expect(helpText).toContain("web-app-dev-team configure");
    expect(helpText).toContain("web-app-dev-team restore:status");
    expect(helpText).not.toContain("web-app-dev-team status --restore-dir");
    expect(helpText).toContain("Create secure user configuration");
    expect(helpText).toContain("Build one feature");
    expect(helpText.indexOf("web-app-dev-team configure")).toBeLessThan(
      helpText.indexOf("web-app-dev-team doctor"),
    );
    expect(helpText.indexOf("web-app-dev-team doctor")).toBeLessThan(
      helpText.indexOf("web-app-dev-team run"),
    );
    expect(await packageVersion()).toBe(expectedPackageVersion);
  });
});

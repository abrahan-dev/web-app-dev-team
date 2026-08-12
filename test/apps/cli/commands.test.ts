import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  CliArguments,
  cancelRun,
  ensureWorkspaceDirectory,
  helpText,
  packageVersion,
  parseMaxTurns,
  runCli,
  specificationsDirectory,
  tokenSummary,
  type CommandHandlers,
} from "../../../src/apps/cli/commands.ts";
import { emptyTokenTotals } from "../../../src/domain/token-usage.ts";
import { Role } from "../../../src/domain/roles.ts";
import { expectedPackageVersion } from "../../support/package-metadata.ts";
import { TemporaryWorkspaceManager } from "../../support/temporary-workspaces.ts";
import { refreshWorkspaceFacts } from "../../../src/infrastructure/workspace/workspace-inspector.ts";
import {
  createRunState,
  loadRunState,
} from "../../../src/infrastructure/persistence/file-run-store.ts";
import { RunStatus } from "../../../src/domain/workflow-values.ts";

const originalMaxTurns = process.env.WEB_APP_DEV_TEAM_MAX_TURNS;
const temporary = new TemporaryWorkspaceManager();

afterEach(async () => {
  if (originalMaxTurns === undefined) {
    delete process.env.WEB_APP_DEV_TEAM_MAX_TURNS;
  } else {
    process.env.WEB_APP_DEV_TEAM_MAX_TURNS = originalMaxTurns;
  }

  await temporary.cleanup();
});

describe("CLI arguments", () => {
  test("creates a missing workspace directory without changing an existing one", async () => {
    const parent = await temporary.create("web-app-dev-team-cli-");
    const workspace = resolve(parent, "new", "application");

    await ensureWorkspaceDirectory(workspace);
    await ensureWorkspaceDirectory(workspace);

    expect((await stat(workspace)).isDirectory()).toBe(true);
  });

  test("rejects a workspace path that is an existing file", async () => {
    const parent = await temporary.create("web-app-dev-team-cli-file-");
    const workspace = resolve(parent, "application");
    await writeFile(workspace, "not a directory");

    await expect(ensureWorkspaceDirectory(workspace)).rejects.toThrow();
  });

  test("records a graceful operator cancellation", async () => {
    const workspace = await temporary.create("web-app-dev-team-cancel-");
    const created = await createRunState({
      prompt: "Build it.",
      workspace,
      maxTurns: 12,
    });

    const cancelled = await cancelRun(created.runDirectory, "SIGINT");

    expect(cancelled.status).toBe(RunStatus.Cancelled);
    expect(cancelled.cancellation).toMatchObject({
      requestedBy: "operator",
      signal: "SIGINT",
      activeRole: Role.Specifier,
      lastCompletedTurn: 0,
    });
    expect((await loadRunState(created.runDirectory)).status).toBe(RunStatus.Cancelled);
  });

  test("runs the hidden deterministic role check", async () => {
    const workspace = await temporary.create("web-app-dev-team-role-check-");
    const runDirectory = resolve(workspace, ".web-app-dev-team/runs/check");
    const source = resolve(workspace, "src/contexts/orders/domain/order.ts");
    const testPath = resolve(workspace, "test/contexts/orders/domain/order.test.ts");
    await mkdir(resolve(source, ".."), { recursive: true });
    await mkdir(resolve(testPath, ".."), { recursive: true });
    await mkdir(runDirectory, { recursive: true });
    await writeFile(resolve(workspace, "bun.lock"), "");
    await writeFile(
      resolve(workspace, "package.json"),
      JSON.stringify({ scripts: { "test:coverage": "bun test --coverage" } }),
    );
    await writeFile(resolve(workspace, "bunfig.toml"), "[test]\ncoverageThreshold = 1\n");
    await writeFile(source, 'export const orderId = (): string => "order-1";\n');
    await writeFile(
      testPath,
      'import { expect, test } from "bun:test";\nimport { orderId } from "../../../../src/contexts/orders/domain/order.ts";\ntest("creates an ID", () => expect(orderId()).toBe("order-1"));\n',
    );
    await refreshWorkspaceFacts(workspace, runDirectory);

    await runCli([
      "bun",
      "index.ts",
      "role-check",
      "--workspace",
      workspace,
      "--run-dir",
      runDirectory,
      "--role",
      Role.BackendCoder,
    ]);

    expect(process.exitCode).not.toBe(1);
  });

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
      "role-check",
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

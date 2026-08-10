import { expect, test } from "bun:test";
import { Role } from "../../../src/domain/roles.ts";
import type { CommandRunner } from "../../../src/infrastructure/terminal/tmux.ts";
import {
  assertTmuxInstalled,
  BunCommandRunner,
  launchTmux,
  type TerminalSpawnOptions,
} from "../../../src/infrastructure/terminal/tmux.ts";

test("requires tmux before creating a dashboard run", () => {
  expect(() => assertTmuxInstalled(null)).toThrow(
    "tmux is required for the dashboard but is not installed",
  );
  expect(() => assertTmuxInstalled("/usr/local/bin/tmux")).not.toThrow();
});

test("gives tmux access to the current terminal", async () => {
  let receivedOptions: TerminalSpawnOptions | undefined;
  const runner = new BunCommandRunner((_command, options) => {
    receivedOptions = options;

    return { exited: Promise.resolve(0) };
  });

  await runner.run(["tmux", "attach-session", "-t", "test"]);

  expect(receivedOptions).toEqual({
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
});

test("builds seven role panes, a wide summary pane, and a hidden orchestrator", async () => {
  const commands: string[][] = [];
  const runner: CommandRunner = {
    run(command: string[]): Promise<void> {
      commands.push(command);

      return Promise.resolve();
    },
  };

  await launchTmux({
    runner,
    runDirectory: "/tmp/run with spaces",
    workspace: "/tmp/project with spaces",
    detach: true,
  });

  expect(commands.filter((command) => command[1] === "split-window")).toHaveLength(7);
  expect(commands.some((command) => command.includes("orchestrator"))).toBeTrue();
  expect(commands.some((command) => command[1] === "attach-session")).toBeFalse();
  expect(
    commands.some((command) => command.includes("pane-border-status") && command.includes("top")),
  ).toBeTrue();
  expect(commands.some((command) => command.includes("pane-border-format"))).toBeTrue();
  expect(
    commands.some((command) => command.includes("mouse") && command.includes("on")),
  ).toBeTrue();
  expect(
    commands.some((command) => command.includes("history-limit") && command.includes("5000")),
  ).toBeTrue();
  expect(
    commands.some(
      (command) =>
        command.includes("resize-pane") && command.some((value) => value.includes("{bottom-left}")),
    ),
  ).toBeTrue();
  const combined = commands.flat().join("\n");
  expect(combined).toContain(Role.Specifier);
  expect(combined).toContain(Role.Architect);
  expect(combined).toContain(Role.UiDesigner);
  expect(combined).toContain(Role.DataEngineer);
  expect(combined).toContain(Role.BackendCoder);
  expect(combined).toContain(Role.FrontendCoder);
  expect(combined).toContain(Role.Qa);
  expect(combined).toContain("'/tmp/run with spaces'");
  expect(combined).toContain("dist/cli.js");
  expect(combined).toContain("dist/watch-role.js");
  expect(combined).toContain("dist/watch-summary.js");
});

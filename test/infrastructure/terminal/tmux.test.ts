import { expect, test } from "bun:test";
import { Role } from "../../../src/domain/roles.ts";
import type { CommandRunner } from "../../../src/infrastructure/terminal/tmux.ts";
import { assertTmuxInstalled, launchTmux } from "../../../src/infrastructure/terminal/tmux.ts";

test("requires tmux before creating a dashboard run", () => {
  expect(() => assertTmuxInstalled(null)).toThrow(
    "tmux is required for the dashboard but is not installed",
  );
  expect(() => assertTmuxInstalled("/usr/local/bin/tmux")).not.toThrow();
});

test("builds one tiled seven-pane agents window and a hidden orchestrator", async () => {
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

  expect(commands.filter((command) => command[1] === "split-window")).toHaveLength(6);
  expect(commands.some((command) => command.includes("orchestrator"))).toBeTrue();
  expect(commands.some((command) => command[1] === "attach-session")).toBeFalse();
  const combined = commands.flat().join("\n");
  expect(combined).toContain(Role.Specifier);
  expect(combined).toContain(Role.Architect);
  expect(combined).toContain(Role.UiDesigner);
  expect(combined).toContain(Role.DataEngineer);
  expect(combined).toContain(Role.BackendCoder);
  expect(combined).toContain(Role.FrontendCoder);
  expect(combined).toContain(Role.Qa);
  expect(combined).toContain("'/tmp/run with spaces'");
});

import { Role } from "../../domain/schemas.ts";
import { cliEntryPath, roleWatcherPath, summaryWatcherPath } from "../../package-paths.ts";
import { paneBorderFormat } from "./active-role-accent.ts";

export function assertTmuxInstalled(tmuxPath: string | null = Bun.which("tmux")): void {
  if (tmuxPath === null) {
    throw new Error(
      "tmux is required for the dashboard but is not installed. Install tmux and try again.",
    );
  }
}

export interface CommandRunner {
  run(command: string[]): Promise<void>;
}

export interface TerminalProcess {
  exited: Promise<number>;
}

export interface TerminalSpawnOptions {
  stdin: "inherit";
  stdout: "inherit";
  stderr: "inherit";
}

export type TerminalProcessSpawner = (
  command: string[],
  options: TerminalSpawnOptions,
) => TerminalProcess;

const spawnTerminalProcess: TerminalProcessSpawner = (command, options) =>
  Bun.spawn(command, options);

export class BunCommandRunner implements CommandRunner {
  constructor(private readonly spawn: TerminalProcessSpawner = spawnTerminalProcess) {}

  async run(command: string[]): Promise<void> {
    const process = this.spawn(command, {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await process.exited;

    if (exitCode !== 0) {
      throw new Error(`${command[0]} exited with code ${exitCode}.`);
    }
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function watcherCommand(runDirectory: string, role: string): string {
  return ["bun", "run", roleWatcherPath, runDirectory, role].map(shellQuote).join(" ");
}

function summaryCommand(runDirectory: string): string {
  return ["bun", "run", summaryWatcherPath, runDirectory].map(shellQuote).join(" ");
}

const dashboardPaneSizes = [
  { pane: 0, direction: "-x", size: "33%" },
  { pane: 3, direction: "-x", size: "33%" },
  { pane: 0, direction: "-y", size: "33%" },
  { pane: 1, direction: "-y", size: "33%" },
  { pane: 3, direction: "-y", size: "33%" },
  { pane: 4, direction: "-y", size: "33%" },
  { pane: 6, direction: "-y", size: "33%" },
] as const;

function dashboardResizeCommand(session: string): string {
  return dashboardPaneSizes
    .map(
      ({ pane, direction, size }) =>
        `resize-pane -t ${shellQuote(`${session}:agents.${pane}`)} ${direction} ${size}`,
    )
    .join(" ; ");
}

export async function launchTmux(options: {
  runner: CommandRunner;
  runDirectory: string;
  workspace: string;
  detach: boolean;
  controllerCommand?: (session: string) => string[];
}): Promise<string> {
  const session = `web-app-dev-team-${Date.now()}`;

  await options.runner.run([
    "tmux",
    "new-session",
    "-d",
    "-s",
    session,
    "-n",
    "agents",
    "-c",
    options.workspace,
    watcherCommand(options.runDirectory, Role.Specifier),
  ]);

  await options.runner.run([
    "tmux",
    "set-option",
    "-w",
    "-t",
    `${session}:agents`,
    "pane-base-index",
    "0",
  ]);

  const splitRole = async (
    direction: "-h" | "-v",
    percentage: string,
    role: Role,
  ): Promise<void> => {
    await options.runner.run([
      "tmux",
      "split-window",
      "-t",
      `${session}:agents`,
      direction,
      "-p",
      percentage,
      "-c",
      options.workspace,
      watcherCommand(options.runDirectory, role),
    ]);
  };

  await splitRole("-h", "67", Role.Architect);
  await splitRole("-h", "50", Role.UiDesigner);

  await options.runner.run([
    "tmux",
    "split-window",
    "-t",
    `${session}:agents`,
    "-v",
    "-p",
    "67",
    "-c",
    options.workspace,
    summaryCommand(options.runDirectory),
  ]);

  await options.runner.run(["tmux", "select-pane", "-t", `${session}:agents`, "-L"]);
  await splitRole("-v", "67", Role.BackendCoder);
  await splitRole("-v", "50", Role.Qa);

  await options.runner.run(["tmux", "select-pane", "-t", `${session}:agents`, "-L"]);
  await splitRole("-v", "67", Role.DataEngineer);
  await splitRole("-v", "50", Role.FrontendCoder);

  for (const { pane, direction, size } of dashboardPaneSizes) {
    await options.runner.run([
      "tmux",
      "resize-pane",
      "-t",
      `${session}:agents.${pane}`,
      direction,
      size,
    ]);
  }

  await options.runner.run([
    "tmux",
    "set-hook",
    "-t",
    session,
    "client-attached",
    dashboardResizeCommand(session),
  ]);
  await options.runner.run([
    "tmux",
    "set-hook",
    "-t",
    session,
    "client-resized",
    dashboardResizeCommand(session),
  ]);

  await options.runner.run(["tmux", "set-option", "-t", session, "mouse", "on"]);
  await options.runner.run([
    "tmux",
    "set-option",
    "-w",
    "-t",
    `${session}:agents`,
    "history-limit",
    "5000",
  ]);

  await options.runner.run([
    "tmux",
    "set-option",
    "-w",
    "-t",
    `${session}:agents`,
    "pane-border-status",
    "top",
  ]);
  await options.runner.run([
    "tmux",
    "set-option",
    "-w",
    "-t",
    `${session}:agents`,
    "pane-border-style",
    "fg=colour250",
  ]);
  await options.runner.run([
    "tmux",
    "set-option",
    "-w",
    "-t",
    `${session}:agents`,
    "pane-active-border-style",
    "fg=colour250",
  ]);
  await options.runner.run([
    "tmux",
    "set-option",
    "-w",
    "-t",
    `${session}:agents`,
    "pane-border-format",
    paneBorderFormat,
  ]);

  const controllerCommand = options.controllerCommand?.(session) ?? [
    "bun",
    "run",
    cliEntryPath,
    "resume",
    "--run-dir",
    options.runDirectory,
    "--tmux-session",
    session,
  ];
  await options.runner.run([
    "tmux",
    "new-window",
    "-d",
    "-t",
    session,
    "-n",
    "orchestrator",
    "-c",
    options.workspace,
    controllerCommand.map(shellQuote).join(" "),
  ]);
  await options.runner.run(["tmux", "select-window", "-t", `${session}:agents`]);

  if (!options.detach) {
    await options.runner.run(["tmux", "attach-session", "-t", session]);
  }

  return session;
}

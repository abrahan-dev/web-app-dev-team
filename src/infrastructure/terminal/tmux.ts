import { resolve } from "node:path";
import { roles } from "../../domain/schemas.ts";

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

export class BunCommandRunner implements CommandRunner {
  async run(command: string[]): Promise<void> {
    const process = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
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
  const script = resolve(import.meta.dir, "watch-role.ts");

  return ["bun", "run", script, runDirectory, role].map(shellQuote).join(" ");
}

export async function launchTmux(options: {
  runner: CommandRunner;
  runDirectory: string;
  workspace: string;
  detach: boolean;
  controllerCommand?: (session: string) => string[];
}): Promise<string> {
  const session = `web-app-dev-team-${Date.now()}`;
  const [first, ...rest] = roles;

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
    watcherCommand(options.runDirectory, first),
  ]);

  for (const role of rest) {
    await options.runner.run([
      "tmux",
      "split-window",
      "-t",
      `${session}:agents`,
      "-c",
      options.workspace,
      watcherCommand(options.runDirectory, role),
    ]);
    await options.runner.run(["tmux", "select-layout", "-t", `${session}:agents`, "tiled"]);
  }

  const cli = resolve(import.meta.dir, "../index.ts");
  const controllerCommand = options.controllerCommand?.(session) ?? [
    "bun",
    "run",
    cli,
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

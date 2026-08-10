import { basename, dirname, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { CodexAgentRunner } from "../../infrastructure/agents/codex/codex-agent-runner.ts";
import { ScriptedAgentRunner } from "../../infrastructure/agents/scripted/scripted-agent-runner.ts";
import type { TokenTotals } from "../../domain/schemas.ts";
import { createRepositoryWorkflow } from "../../infrastructure/git/config.ts";
import { runDevelopmentTeam } from "../../application/development/run-development-team.ts";
import { developmentServices } from "../../infrastructure/development-services.ts";
import { createRunState, loadRunState } from "../../infrastructure/persistence/file-run-store.ts";
import { AutomaticSpecificationReviewer } from "../../application/ports/specification-reviewer.ts";
import {
  createRestitution,
  loadRestitutionState,
  runRestitution,
} from "../../infrastructure/restitution/specification-restitution.ts";
import { RestitutionStatus, RunStatus } from "../../domain/workflow-values.ts";
import {
  FileSpecificationJournal,
  InMemorySpecificationJournal,
} from "../../infrastructure/persistence/file-specification-journal.ts";
import { DeterministicWorkspaceBootstrapper } from "../../infrastructure/workspace/workspace-bootstrapper.ts";
import {
  assertTmuxInstalled,
  BunCommandRunner,
  launchTmux,
} from "../../infrastructure/terminal/tmux.ts";
import { TerminalSpecificationReviewer } from "./terminal-specification-reviewer.ts";
import { cliEntryPath, packageJsonPath } from "../../package-paths.ts";
import { inspectSystem, renderDoctorChecks } from "./system-doctor.ts";
import { loadConfiguration } from "./configuration-loader.ts";
import { configureUser } from "./user-configurator.ts";

export type CommandHandler = (arguments_: CliArguments) => Promise<void>;
export type CommandHandlers = Record<string, CommandHandler>;

export class CliArguments {
  constructor(private readonly values: string[]) {}

  get command(): string {
    return this.values[2] ?? "run";
  }

  has(name: string): boolean {
    return this.values.includes(name);
  }

  optional(name: string): string | undefined {
    const index = this.values.indexOf(name);

    return index === -1 ? undefined : this.values[index + 1];
  }

  required(name: string): string {
    const value = this.optional(name);

    if (!value) {
      throw new Error(`Missing required argument ${name}.`);
    }

    return value;
  }

  maxTurns(): number {
    return parseMaxTurns(
      this.optional("--max-turns") ?? process.env.WEB_APP_DEV_TEAM_MAX_TURNS ?? "12",
    );
  }
}

export const helpText = `Web App Dev Team
Build web applications with specialized Codex roles.

Normal flow:
  web-app-dev-team configure
    Create secure user configuration and set the runtime options.

  web-app-dev-team doctor [--workspace <path>]
    Check the platform, required tools, authentication, and optional workspace.

  web-app-dev-team run --workspace <path> --prompt <task> [--detach]
    Build one feature in a new or existing application.

  web-app-dev-team attach --session <name>
    Open a detached development or restitution session.

Recovery:
  web-app-dev-team git-resume --run-dir <path>
    Retry Git delivery without repeating completed agent work.

Restitution:
  web-app-dev-team restore --workspace <path> --specs-path <path>
    Rebuild a project from approved specifications.

  web-app-dev-team restore:resume --restore-dir <path> [--max-turns <count>]
    Continue an interrupted restitution.

  web-app-dev-team restore:status --restore-dir <path>
    Show restitution progress without changing it.

General:
  web-app-dev-team --help
    Show this help text.

  web-app-dev-team --version
    Show the installed package version.

Requirements:
  Bun, tmux, Git, an authenticated Codex CLI, and the GitHub MCP server.

Run data:
  <workspace>/.web-app-dev-team/runs/<run-id>/`;

export async function packageVersion(): Promise<string> {
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { version?: unknown };

  if (typeof packageJson.version !== "string") {
    throw new Error("package.json has no valid version.");
  }

  return packageJson.version;
}

export function parseMaxTurns(raw: string): number {
  const parsed = Number(raw);

  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--max-turns must be a positive integer; got ${raw}.`);
  }

  return parsed;
}

export function tokenSummary(totals: TokenTotals): string {
  const count = (value: number): string => new Intl.NumberFormat("en-US").format(value);

  return [
    `team ${count(totals.team.totalTokens)}`,
    ...Object.entries(totals.byRole).map(([role, usage]) => `${role} ${count(usage.totalTokens)}`),
  ].join(" · ");
}

function printGitSummary(
  result: Awaited<ReturnType<typeof runDevelopmentTeam>>,
  runDirectory: string,
): void {
  const git = result.gitWorkflow;

  if (!git) {
    return;
  }

  console.log(`Git: ${git.status}.`);
  console.log(`Branch: ${git.featureBranch ?? "none"}.`);
  console.log(`Pull request: ${git.pullRequestUrl ?? "none"}.`);

  if (git.failure) {
    console.log(`Git failure: ${git.failure}`);
    console.log(`Retry: web-app-dev-team git-resume --run-dir ${runDirectory}`);
    process.exitCode = 1;
  }
}

async function executeRun(runDirectory: string, demo = false, tmuxSession?: string): Promise<void> {
  const commandRunner = new BunCommandRunner();
  const repositoryWorkflow = createRepositoryWorkflow();
  const result = await runDevelopmentTeam(
    demo ? new ScriptedAgentRunner() : new CodexAgentRunner(),
    runDirectory,
    demo
      ? new AutomaticSpecificationReviewer()
      : new TerminalSpecificationReviewer(commandRunner, tmuxSession),
    demo ? new InMemorySpecificationJournal() : new FileSpecificationJournal(),
    developmentServices,
    new DeterministicWorkspaceBootstrapper(),
    demo ? undefined : repositoryWorkflow,
  );
  console.log(`\n✓ Development team ${result.status} after ${result.turns} turns.`);
  console.log(result.finalSummary ?? result.failure ?? "No summary available.");
  console.log(`Tokens: ${tokenSummary(result.tokenTotals)}`);
  console.log(`State: ${resolve(runDirectory, "state.json")}`);

  printGitSummary(result, runDirectory);
}

export function specificationsDirectory(path: string): string {
  const absolute = resolve(path);

  return basename(absolute) === "manifest.json" ? dirname(absolute) : absolute;
}

async function executeRestitution(
  directory: string,
  tmuxSession?: string,
  maxTurnsOverride?: number,
): Promise<void> {
  const result = await runRestitution(
    directory,
    new CodexAgentRunner(),
    new FileSpecificationJournal(),
    maxTurnsOverride,
  );
  console.log(
    `\n${result.status === RestitutionStatus.Completed ? "✓" : "!"} Restitution ${result.status}.`,
  );
  console.log(
    `${result.completedSequences.length}/${result.specifications.length} specifications completed.`,
  );
  console.log(`Tokens: ${tokenSummary(result.tokenTotals)}`);

  if (result.failure) {
    console.log(`Reason: ${result.failure}`);
    console.log(
      `Pending sequence: ${result.currentSequence ?? "unknown"}; resume agent: ${result.resumeRole ?? "unknown"}.`,
    );
    console.log(`Resume with: web-app-dev-team restore:resume --restore-dir ${directory}`);
  }

  if (tmuxSession) {
    await new BunCommandRunner().run([
      "tmux",
      "select-window",
      "-t",
      `${tmuxSession}:orchestrator`,
    ]);
  }
}

async function restoreStatus(arguments_: CliArguments): Promise<void> {
  const directory = resolve(arguments_.required("--restore-dir"));
  const state = await loadRestitutionState(directory);
  let currentRole = state.resumeRole;
  let currentTokenTotals = state.tokenTotals;

  if (state.currentSequence !== null) {
    try {
      const currentRun = await loadRunState(directory);
      currentRole = currentRun.currentRole;
      currentTokenTotals = currentRun.tokenTotals;
    } catch {
      // The controller can stop while it initializes the current specification.
    }
  }

  console.log(`Restitution: ${state.status}`);
  console.log(
    `Progress: ${state.completedSequences.length}/${state.specifications.length} specifications completed.`,
  );
  console.log(`Current sequence: ${state.currentSequence ?? "none"}.`);
  console.log(`Current agent: ${currentRole ?? "none"}.`);
  console.log(`Last failure: ${state.failure ?? "none"}.`);
  console.log(`Tokens: ${tokenSummary(currentTokenTotals)}.`);
  console.log(`Progress log: ${resolve(directory, "progress.log")}`);
}

async function restoreResume(arguments_: CliArguments): Promise<void> {
  await executeRestitution(
    resolve(arguments_.required("--restore-dir")),
    arguments_.optional("--tmux-session"),
    arguments_.optional("--max-turns")
      ? parseMaxTurns(arguments_.required("--max-turns"))
      : undefined,
  );
}

async function launchRestitution(arguments_: CliArguments, resuming: boolean): Promise<void> {
  assertTmuxInstalled();
  const existingDirectory = resuming ? arguments_.required("--restore-dir") : undefined;
  let directory: string;
  let workspace: string;

  if (existingDirectory) {
    directory = resolve(existingDirectory);
    workspace = (await loadRestitutionState(directory)).workspace;
  } else {
    workspace = resolve(arguments_.required("--workspace"));
    const created = await createRestitution({
      workspace,
      specificationsDirectory: specificationsDirectory(arguments_.required("--specs-path")),
      maxTurnsPerSpecification: arguments_.maxTurns(),
    });
    directory = created.directory;
  }

  const maxTurnsOverride = arguments_.optional("--max-turns");
  const session = await launchTmux({
    runner: new BunCommandRunner(),
    runDirectory: directory,
    workspace,
    detach: arguments_.has("--detach"),
    controllerCommand: (tmuxSession) => {
      const controller = [
        "bun",
        "run",
        cliEntryPath,
        "restore-resume",
        "--restore-dir",
        directory,
        "--tmux-session",
        tmuxSession,
      ];

      if (existingDirectory && maxTurnsOverride) {
        controller.push("--max-turns", maxTurnsOverride);
      }

      return controller;
    },
  });
  console.log(`tmux session: ${session}`);
}

async function resume(arguments_: CliArguments): Promise<void> {
  await executeRun(
    resolve(arguments_.required("--run-dir")),
    false,
    arguments_.optional("--tmux-session"),
  );
}

async function doctor(arguments_: CliArguments): Promise<void> {
  const checks = await inspectSystem(arguments_.optional("--workspace"));

  console.log(renderDoctorChecks(checks));

  if (checks.some(({ status }) => status === "FAIL")) {
    process.exitCode = 1;
  }
}

async function attach(arguments_: CliArguments): Promise<void> {
  assertTmuxInstalled();
  await new BunCommandRunner().run([
    "tmux",
    "attach-session",
    "-t",
    arguments_.required("--session"),
  ]);
}

async function printVersion(): Promise<void> {
  console.log(await packageVersion());
}

async function printHelp(): Promise<void> {
  console.log(helpText);
}

async function startDevelopment(arguments_: CliArguments, demo: boolean): Promise<void> {
  const workspace = resolve(
    demo
      ? (arguments_.optional("--workspace") ?? process.cwd())
      : arguments_.required("--workspace"),
  );
  const prompt =
    arguments_.optional("--prompt") ?? (demo ? "Add a generic feature using TDD." : undefined);

  if (!prompt) {
    throw new Error('Provide the task with --prompt "...". It may describe any software feature.');
  }

  if (!demo) {
    assertTmuxInstalled();
  }

  const repositoryWorkflow = createRepositoryWorkflow();
  const gitWorkflow = demo ? null : await repositoryWorkflow.prepare(workspace);
  const created = await createRunState({
    prompt,
    workspace,
    maxTurns: arguments_.maxTurns(),
    gitWorkflow,
  });

  if (!demo) {
    const session = await launchTmux({
      runner: new BunCommandRunner(),
      runDirectory: created.runDirectory,
      workspace,
      detach: arguments_.has("--detach"),
    });
    console.log(`tmux session: ${session}`);

    return;
  }

  await executeRun(created.runDirectory, true);
  const state = await loadRunState(created.runDirectory);

  if (state.status !== RunStatus.Completed) {
    process.exitCode = 1;
  }
}

const commandHandlers: CommandHandlers = {
  "--help": printHelp,
  "--version": printVersion,
  attach,
  configure: () => configureUser(),
  doctor,
  help: printHelp,
  run: (arguments_) => startDevelopment(arguments_, false),
  status: restoreStatus,
  "git-resume": resume,
  "restore:status": restoreStatus,
  "restore-status": restoreStatus,
  "restore-resume": restoreResume,
  restore: (arguments_) => launchRestitution(arguments_, false),
  "restore:resume": (arguments_) => launchRestitution(arguments_, true),
  "git:resume": resume,
  resume,
  tmux: (arguments_) => startDevelopment(arguments_, false),
  demo: (arguments_) => startDevelopment(arguments_, true),
};

export async function runCli(
  values = process.argv,
  handlers: CommandHandlers = commandHandlers,
): Promise<void> {
  const arguments_ = new CliArguments(values);
  await loadConfiguration({
    workspace: resolve(arguments_.optional("--workspace") ?? process.cwd()),
  });
  const handler = handlers[arguments_.command];

  if (!handler) {
    throw new Error(
      `Unknown command ${arguments_.command}. Use --help to list the available commands.`,
    );
  }

  await handler(arguments_);
}

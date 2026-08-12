import { mkdir, readFile, rename } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { roles, runStateSchema, type RunState } from "../../domain/schemas.ts";
import { Role } from "../../domain/roles.ts";
import { RunStatus } from "../../domain/workflow-values.ts";
import { emptyTokenTotals } from "../../domain/token-usage.ts";

export const stateFileName = "state.json";

function safeId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
}

export async function createRunState(options: {
  prompt: string;
  workspace: string;
  runsRoot?: string;
  maxTurns: number;
  gitWorkflow?: RunState["gitWorkflow"];
}): Promise<{ runDirectory: string; state: RunState }> {
  const id = `${Date.now()}-${safeId(options.prompt) || "task"}`;
  const startedAt = new Date().toISOString();
  const runDirectory = resolve(
    options.runsRoot ?? options.workspace,
    ".web-app-dev-team",
    "runs",
    id,
  );
  const state = runStateSchema.parse({
    version: 4,
    id,
    startedAt,
    activeExecutionStartedAt: null,
    prompt: options.prompt,
    workspace: resolve(options.workspace),
    status: RunStatus.Running,
    currentRole: Role.Specifier,
    turns: 0,
    maxTurns: options.maxTurns,
    messages: [
      {
        id: `${id}-0000`,
        sequence: 0,
        from: "user",
        to: Role.Specifier,
        createdAt: startedAt,
        turn: null,
      },
    ],
    specificationReviews: [],
    finalSummary: null,
    failure: null,
    cancellation: null,
    mode: "delivery",
    targetSpecification: null,
    interruptions: [],
    tokenTotals: emptyTokenTotals(),
    executions: [],
    localChecks: [],
    workspaceBootstrap: null,
    gitWorkflow: options.gitWorkflow ?? null,
  });

  await mkdir(resolve(runDirectory, "logs"), { recursive: true });
  await Promise.all(
    [...roles.map((role) => `${role}.log`), "summary.log"].map((log) =>
      Bun.write(resolve(runDirectory, "logs", log), ""),
    ),
  );
  await saveRunState(runDirectory, state);

  return { runDirectory, state };
}

export async function loadRunState(runDirectory: string): Promise<RunState> {
  const raw = await readFile(resolve(runDirectory, stateFileName), "utf8");

  return runStateSchema.parse(JSON.parse(raw));
}

export async function saveRunState(runDirectory: string, state: RunState): Promise<void> {
  const validated = runStateSchema.parse(state);
  const path = resolve(runDirectory, stateFileName);
  const temporaryPath = resolve(runDirectory, `.${basename(path)}.tmp`);

  await Bun.write(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`);
  await rename(temporaryPath, path);
}

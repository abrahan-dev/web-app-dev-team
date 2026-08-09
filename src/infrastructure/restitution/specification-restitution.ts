import { access, appendFile, copyFile, mkdir, readFile, readdir, rename } from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { AgentRunner } from "../../application/ports/agent-runner.ts";
import {
  DevelopmentRun,
  RestitutionProgress,
  restitutionStateSchema,
  roles,
  runStateSchema,
  type PublishedSpecification,
  type RestitutionState,
  type RunState,
} from "../../domain/schemas.ts";
import { Role } from "../../domain/roles.ts";
import { emptyTokenTotals } from "../../domain/token-usage.ts";
import {
  RestitutionStatus,
  RunStatus,
  SpecificationReviewDecision,
  TurnDecision,
} from "../../domain/workflow-values.ts";
import { runDevelopmentTeam } from "../../application/development/run-development-team.ts";
import { loadRunState, saveRunState } from "../persistence/file-run-store.ts";
import { AutomaticSpecificationReviewer } from "../../application/ports/specification-reviewer.ts";
import {
  FileSpecificationJournal,
  loadVerifiedSpecificationArchive,
} from "../persistence/file-specification-journal.ts";
import type { SpecificationJournal } from "../../application/ports/development-services.ts";
import { developmentServices } from "../development-services.ts";
import { DeterministicWorkspaceBootstrapper } from "../workspace/workspace-bootstrapper.ts";

const restitutionStateFile = "restitution.json";

function safeId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);

    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function installSpecificationArchive(
  sourceDirectory: string,
  workspace: string,
): Promise<PublishedSpecification[]> {
  const source = resolve(sourceDirectory);
  const target = resolve(workspace, "specifications");
  const sourceManifest = await loadVerifiedSpecificationArchive(source);

  if (source === target) {
    return sourceManifest.specifications;
  }

  const targetManifestPath = resolve(target, "manifest.json");

  if (await exists(targetManifestPath)) {
    const targetManifest = await loadVerifiedSpecificationArchive(target);

    if (
      JSON.stringify(targetManifest.specifications) !==
      JSON.stringify(sourceManifest.specifications)
    ) {
      throw new Error(
        `The target already contains a different specification journal at ${target}.`,
      );
    }

    return targetManifest.specifications;
  }

  if (await exists(target)) {
    const entries = await readdir(target);

    if (entries.length > 0) {
      throw new Error(`Refusing to replace the non-empty directory ${target} without a manifest.`);
    }
  }

  await mkdir(target, { recursive: true });

  for (const specification of sourceManifest.specifications) {
    const fileName = basename(specification.path);
    const temporaryPath = resolve(target, `.${fileName}.tmp`);
    await copyFile(resolve(source, fileName), temporaryPath);
    await rename(temporaryPath, resolve(target, fileName));
  }

  const temporaryManifest = resolve(target, ".manifest.json.tmp");
  await copyFile(resolve(source, "manifest.json"), temporaryManifest);
  await rename(temporaryManifest, targetManifestPath);
  await new FileSpecificationJournal().verify(workspace);

  return sourceManifest.specifications;
}

export async function saveRestitutionState(
  directory: string,
  state: RestitutionState,
): Promise<void> {
  const validated = restitutionStateSchema.parse(state);
  const path = resolve(directory, restitutionStateFile);
  const temporaryPath = resolve(directory, `.${restitutionStateFile}.tmp`);
  await Bun.write(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`);
  await rename(temporaryPath, path);
}

export async function loadRestitutionState(directory: string): Promise<RestitutionState> {
  return restitutionStateSchema.parse(
    JSON.parse(await readFile(resolve(directory, restitutionStateFile), "utf8")),
  );
}

export async function createRestitution(options: {
  workspace: string;
  specificationsDirectory: string;
  maxTurnsPerSpecification: number;
  runsRoot?: string;
}): Promise<{ directory: string; state: RestitutionState }> {
  const workspace = resolve(options.workspace);
  const sourceSpecifications = resolve(options.specificationsDirectory);
  const specifications = await installSpecificationArchive(sourceSpecifications, workspace);
  const id = `${Date.now()}-${safeId(basename(sourceSpecifications)) || "specifications"}`;
  const directory = resolve(options.runsRoot ?? workspace, ".web-app-dev-team", "restitutions", id);
  const progress = RestitutionProgress.restore(
    restitutionStateSchema.parse({
      version: 1,
      id,
      workspace,
      sourceSpecifications,
      status: RestitutionStatus.Running,
      specifications,
      nextSequence: 1,
      currentSequence: null,
      resumeRole: null,
      completedSequences: [],
      maxTurnsPerSpecification: options.maxTurnsPerSpecification,
      failure: null,
      tokenTotals: emptyTokenTotals(),
    }),
  );
  const state = progress.state;

  await mkdir(resolve(directory, "logs"), { recursive: true });
  await mkdir(resolve(directory, "results"), { recursive: true });
  await Promise.all(roles.map((role) => Bun.write(resolve(directory, "logs", `${role}.log`), "")));
  await Bun.write(resolve(directory, "progress.log"), "");
  await saveRestitutionState(directory, state);

  return { directory, state };
}

async function createSequenceRun(
  directory: string,
  restitution: RestitutionState,
  target: PublishedSpecification,
): Promise<RunState> {
  const content = await readFile(resolve(restitution.workspace, target.path), "utf8");
  const runId = `${restitution.id}-sequence-${String(target.sequence).padStart(6, "0")}`;
  const specification = {
    role: Role.Specifier,
    featureId: target.featureId,
    summary: `Approved specification ${target.sequence}: ${target.featureId}.`,
    specification: content,
    assumptions: [],
    outOfScope: [],
    artifacts: [target.path],
    evidence: [`SHA-256: ${target.sha256}`],
    decision: TurnDecision.Handoff,
    nextRole: Role.Architect,
    reason: "This specification was approved in the source journal.",
  };
  const state = runStateSchema.parse({
    version: 4,
    id: runId,
    prompt: `Restore specification ${target.sequence} (${target.featureId}) in sequence.`,
    workspace: restitution.workspace,
    status: RunStatus.Running,
    currentRole: Role.Architect,
    turns: 0,
    maxTurns: restitution.maxTurnsPerSpecification,
    messages: [
      {
        id: `${runId}-0000`,
        sequence: 0,
        from: "user",
        to: Role.Architect,
        createdAt: new Date().toISOString(),
        turn: null,
      },
    ],
    specificationReviews: [
      {
        id: target.sourceReviewId,
        createdAt: target.createdAt,
        specification,
        decision: SpecificationReviewDecision.Approved,
        feedback: null,
        publishedSpecification: target,
      },
    ],
    finalSummary: null,
    failure: null,
    mode: "restitution",
    targetSpecification: target,
    interruptions: [],
    tokenTotals: restitution.tokenTotals,
    executions: [],
    localChecks: [],
    workspaceBootstrap: null,
  });

  await Promise.all(
    roles.map((role) =>
      appendFile(
        resolve(directory, "logs", `${role}.log`),
        `\n=== RESTITUTION SEQUENCE ${target.sequence}: ${target.featureId} ===\n`,
      ),
    ),
  );
  await saveRunState(directory, state);

  return state;
}

async function checkpointSequence(
  directory: string,
  progress: RestitutionProgress,
  run: RunState,
): Promise<void> {
  const sequence = progress.state.currentSequence;

  if (sequence === null) {
    throw new Error("A restitution checkpoint requires an active sequence.");
  }

  const resultPath = resolve(directory, "results", `${String(sequence).padStart(6, "0")}.json`);
  await Bun.write(resultPath, `${JSON.stringify(run, null, 2)}\n`);
  progress.checkpoint(run);
  await saveRestitutionState(directory, progress.state);
}

async function reportProgress(directory: string, message: string): Promise<void> {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  await appendFile(resolve(directory, "progress.log"), `${line}\n`);
  await Promise.all(
    roles.map((role) => appendFile(resolve(directory, "logs", `${role}.log`), `\n${line}\n`)),
  );
}

async function beginRestitution(
  directory: string,
  maxTurnsOverride?: number,
): Promise<{ progress: RestitutionProgress; recoveringActiveRun: boolean }> {
  const progress = RestitutionProgress.restore(await loadRestitutionState(directory));
  const recoveringActiveRun = progress.begin(maxTurnsOverride);
  const restitution = progress.state;
  await saveRestitutionState(directory, restitution);
  await reportProgress(
    directory,
    `Restitution running: ${restitution.completedSequences.length}/${restitution.specifications.length} specifications completed.`,
  );

  return { progress, recoveringActiveRun };
}

async function verifyJournalBeforeSequence(
  directory: string,
  progress: RestitutionProgress,
  target: PublishedSpecification,
  journal: SpecificationJournal,
): Promise<boolean> {
  const restitution = progress.state;

  try {
    await journal.verify(restitution.workspace);

    return true;
  } catch (error) {
    progress.interrupt(error instanceof Error ? error.message : String(error), null);
    await saveRestitutionState(directory, restitution);
    await reportProgress(
      directory,
      `Restitution interrupted before sequence ${target.sequence}: ${restitution.failure}`,
    );

    return false;
  }
}

async function recoverUncleanRun(
  directory: string,
  progress: RestitutionProgress,
  target: PublishedSpecification,
  state: RunState,
): Promise<RunState> {
  const restitution = progress.state;
  const run = DevelopmentRun.restore(state);

  if (run.state.currentRole !== null) {
    run.recordInterruption(
      run.state.currentRole,
      "The restitution controller stopped before this turn completed.",
    );
    await saveRunState(directory, run.state);
  }

  progress.recover(run.state.currentRole);
  await saveRestitutionState(directory, restitution);
  await reportProgress(
    directory,
    `[${target.sequence}/${restitution.specifications.length}] Recovering ${target.featureId} at agent ${run.state.currentRole ?? "unknown"} after an unclean stop.`,
  );

  return run.state;
}

async function resumeFailedRun(
  directory: string,
  progress: RestitutionProgress,
  target: PublishedSpecification,
  state: RunState,
): Promise<RunState> {
  const restitution = progress.state;
  const run = DevelopmentRun.restore(state);

  if (run.state.currentRole === null) {
    throw new Error(`Sequence ${target.sequence} has no resumable agent role.`);
  }

  run.resume(restitution.maxTurnsPerSpecification);
  await saveRunState(directory, run.state);
  progress.recover(run.state.currentRole);
  await saveRestitutionState(directory, restitution);
  await reportProgress(
    directory,
    `[${target.sequence}/${restitution.specifications.length}] Resuming ${target.featureId} at agent ${run.state.currentRole}.`,
  );

  return run.state;
}

async function startSequenceRun(
  directory: string,
  progress: RestitutionProgress,
  target: PublishedSpecification,
): Promise<RunState> {
  const restitution = progress.state;

  await reportProgress(
    directory,
    `[${target.sequence}/${restitution.specifications.length}] Starting ${target.featureId}; ${restitution.completedSequences.length} completed.`,
  );
  const run = await createSequenceRun(directory, restitution, target);
  progress.startSequence(target.sequence, Role.Architect);
  await saveRestitutionState(directory, restitution);

  return run;
}

async function prepareSequenceRun(
  directory: string,
  progress: RestitutionProgress,
  target: PublishedSpecification,
  recoveringActiveRun: boolean,
): Promise<RunState> {
  const restitution = progress.state;

  if (restitution.currentSequence !== target.sequence) {
    return startSequenceRun(directory, progress, target);
  }

  let run = await loadRunState(directory);

  if (recoveringActiveRun && run.status === RunStatus.Running) {
    run = await recoverUncleanRun(directory, progress, target, run);
  }

  if (run.status === RunStatus.Failed) {
    run = await resumeFailedRun(directory, progress, target, run);
  }

  return run;
}

async function interruptSequence(
  directory: string,
  progress: RestitutionProgress,
  target: PublishedSpecification,
  error: unknown,
): Promise<void> {
  const failedRun = await loadRunState(directory);
  const failure = error instanceof Error ? error.message : String(error);
  progress.interrupt(failure, failedRun.currentRole, failedRun.tokenTotals);
  const restitution = progress.state;
  await saveRestitutionState(directory, restitution);
  await reportProgress(
    directory,
    `[${target.sequence}/${restitution.specifications.length}] Interrupted ${target.featureId} at agent ${failedRun.currentRole ?? "unknown"}: ${restitution.failure}`,
  );
}

async function executeSequence(
  directory: string,
  progress: RestitutionProgress,
  target: PublishedSpecification,
  run: RunState,
  runner: AgentRunner,
  journal: SpecificationJournal,
): Promise<RunState | null> {
  if (run.status === RunStatus.Completed) {
    return run;
  }

  try {
    return await runDevelopmentTeam(
      runner,
      directory,
      new AutomaticSpecificationReviewer(),
      journal,
      developmentServices,
      new DeterministicWorkspaceBootstrapper(),
    );
  } catch (error) {
    await interruptSequence(directory, progress, target, error);

    return null;
  }
}

async function finishRestitution(directory: string, progress: RestitutionProgress): Promise<void> {
  progress.complete();
  const restitution = progress.state;
  await saveRestitutionState(directory, restitution);
  await reportProgress(
    directory,
    `Restitution completed: ${restitution.specifications.length}/${restitution.specifications.length} specifications implemented and verified by QA.`,
  );
}

export async function runRestitution(
  directory: string,
  runner: AgentRunner,
  journal: SpecificationJournal = new FileSpecificationJournal(),
  maxTurnsOverride?: number,
): Promise<RestitutionState> {
  const { progress, recoveringActiveRun } = await beginRestitution(directory, maxTurnsOverride);
  const restitution = progress.state;

  while (restitution.nextSequence <= restitution.specifications.length) {
    const target = progress.nextSpecification();

    if (!(await verifyJournalBeforeSequence(directory, progress, target, journal))) {
      return restitution;
    }

    const preparedRun = await prepareSequenceRun(directory, progress, target, recoveringActiveRun);
    const run = await executeSequence(directory, progress, target, preparedRun, runner, journal);

    if (!run) {
      return restitution;
    }

    await checkpointSequence(directory, progress, run);
    await reportProgress(
      directory,
      `[${target.sequence}/${restitution.specifications.length}] Completed ${target.featureId}; ${restitution.completedSequences.length}/${restitution.specifications.length} done.`,
    );
  }

  await finishRestitution(directory, progress);

  return restitution;
}

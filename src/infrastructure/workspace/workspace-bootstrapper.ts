import { access, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  changePlanSchema,
  type ChangePlan,
  type LocalCommandResult,
  type WorkspaceBootstrap,
} from "../../domain/schemas.ts";
import type { WorkspaceBootstrapper } from "../../application/ports/development-services.ts";
import { runLocalCommand } from "../quality/quality-gate.ts";
import { webAppTemplate, webAppTemplateVersion } from "./templates/web-app.ts";

const allowedMetadata = new Set([".DS_Store", ".git", ".web-app-dev-team", "specifications"]);
const markerRelativePath = ".web-app-dev-team/bootstrap.json";

function validationCommands(plan: ChangePlan): string[][] {
  return [
    ["bun", "install"],
    ...(plan.frontendRequired ? [["bunx", "playwright", "install", "chromium"]] : []),
    ["bun", "run", "format:check"],
    ["bun", "run", "lint"],
    ["bun", "run", "typecheck"],
    ["bun", "run", "test"],
  ];
}

export type BootstrapCommandRunner = (
  command: string[],
  workspace: string,
) => Promise<LocalCommandResult>;

interface BootstrapMarker {
  status: "in-progress" | "complete";
  plan: ChangePlan;
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

function surfaces(plan: ChangePlan): Array<"backend" | "frontend"> {
  return [
    ...(plan.backendRequired ? (["backend"] as const) : []),
    ...(plan.frontendRequired ? (["frontend"] as const) : []),
  ];
}

function resultBase(plan: ChangePlan) {
  return {
    template: "web-app" as const,
    templateVersion: webAppTemplateVersion,
    applicationName: plan.applicationName,
    contexts: plan.contexts,
    surfaces: surfaces(plan),
    persistence: plan.dataRequired,
    createdAt: new Date().toISOString(),
  };
}

function skippedBootstrap(plan: ChangePlan, reason: string): WorkspaceBootstrap {
  return {
    ...resultBase(plan),
    status: "skipped",
    reason,
    createdFiles: [],
    commands: [],
  };
}

function markerContent(plan: ChangePlan, status: BootstrapMarker["status"]): string {
  return `${JSON.stringify(
    {
      template: "web-app",
      templateVersion: webAppTemplateVersion,
      status,
      changePlan: plan,
    },
    null,
    2,
  )}\n`;
}

async function readBootstrapMarker(path: string): Promise<BootstrapMarker | null> {
  if (!(await exists(path))) {
    return null;
  }

  const marker = JSON.parse(await readFile(path, "utf8")) as {
    template?: unknown;
    templateVersion?: unknown;
    status?: unknown;
    changePlan?: unknown;
  };

  if (marker.template !== "web-app" || marker.templateVersion !== webAppTemplateVersion) {
    throw new Error(
      `Workspace bootstrap marker ${markerRelativePath} names an unsupported template.`,
    );
  }

  return {
    status: marker.status === "complete" ? "complete" : "in-progress",
    plan: changePlanSchema.parse(marker.changePlan),
  };
}

function managedTopLevelEntries(template: Record<string, string>): Set<string> {
  return new Set([
    ...Object.keys(template).map((path) => path.split("/")[0] ?? path),
    "bun.lock",
    "bun.lockb",
    "node_modules",
  ]);
}

async function createBootstrapMarker(path: string, plan: ChangePlan): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, markerContent(plan, "in-progress"), {
    encoding: "utf8",
    flag: "wx",
  });
}

async function completeBootstrapMarker(path: string, plan: ChangePlan): Promise<void> {
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, markerContent(plan, "complete"), "utf8");
  await rename(temporaryPath, path);
}

async function validateTemplateFiles(
  workspace: string,
  template: Record<string, string>,
): Promise<void> {
  for (const [path, content] of Object.entries(template)) {
    const absolute = resolve(workspace, path);

    if (!(await exists(absolute))) {
      throw new Error(`Workspace bootstrap validation failed: ${path} is missing.`);
    }

    if ((await readFile(absolute, "utf8")) !== content) {
      throw new Error(`Workspace bootstrap validation failed: ${path} changed.`);
    }
  }
}

async function materializeTemplate(
  workspace: string,
  template: Record<string, string>,
): Promise<string[]> {
  const createdFiles: string[] = [];

  for (const path of Object.keys(template).sort()) {
    const absolute = resolve(workspace, path);

    if (await exists(absolute)) {
      if ((await readFile(absolute, "utf8")) !== template[path]) {
        throw new Error(`Workspace bootstrap refuses to overwrite ${path}.`);
      }

      continue;
    }

    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, template[path] ?? "", {
      encoding: "utf8",
      flag: "wx",
    });
    createdFiles.push(path);
  }

  await validateTemplateFiles(workspace, template);

  return createdFiles;
}

async function installedLockFile(workspace: string): Promise<string | null> {
  if (await exists(resolve(workspace, "bun.lock"))) {
    return "bun.lock";
  }

  return (await exists(resolve(workspace, "bun.lockb"))) ? "bun.lockb" : null;
}

async function runBootstrapValidation(
  workspace: string,
  plan: ChangePlan,
  runCommand: BootstrapCommandRunner,
): Promise<{ commands: LocalCommandResult[]; createdLockFile: string | null }> {
  const lockBeforeCommands = await installedLockFile(workspace);
  const commands: LocalCommandResult[] = [];

  for (const command of validationCommands(plan)) {
    const result = await runCommand(command, workspace);
    commands.push(result);

    if (result.exitCode !== 0) {
      throw new Error(`Workspace bootstrap command failed (${result.command}): ${result.output}`);
    }
  }

  const lockFile = await installedLockFile(workspace);

  if (!lockFile) {
    throw new Error("Workspace bootstrap validation failed: Bun created no lockfile.");
  }

  return {
    commands,
    createdLockFile: lockBeforeCommands ? null : lockFile,
  };
}

function interruptedPlanMatches(marker: BootstrapMarker | null, plan: ChangePlan): boolean {
  return !marker || JSON.stringify(marker.plan) === JSON.stringify(plan);
}

export class DeterministicWorkspaceBootstrapper implements WorkspaceBootstrapper {
  constructor(private readonly runCommand: BootstrapCommandRunner = runLocalCommand) {}

  async bootstrap(workspace: string, plan: ChangePlan): Promise<WorkspaceBootstrap> {
    const template = webAppTemplate(plan);
    const projectEntries = (await readdir(workspace)).filter(
      (entry) => !allowedMetadata.has(entry),
    );
    const markerPath = resolve(workspace, markerRelativePath);
    const marker = await readBootstrapMarker(markerPath);
    const managedEntries = managedTopLevelEntries(template);
    const unmanagedEntries = projectEntries.filter((entry) => !managedEntries.has(entry));

    if (marker?.status === "complete") {
      return skippedBootstrap(
        plan,
        `Workspace was already initialized by template v${webAppTemplateVersion}.`,
      );
    }

    if (
      projectEntries.length > 0 &&
      (marker?.status !== "in-progress" || unmanagedEntries.length > 0)
    ) {
      return skippedBootstrap(
        plan,
        `Existing project content detected: ${projectEntries.sort().join(", ")}.`,
      );
    }

    if (!interruptedPlanMatches(marker, plan)) {
      throw new Error(
        `Workspace bootstrap marker ${markerRelativePath} does not match the interrupted change plan.`,
      );
    }

    if (!marker) {
      await createBootstrapMarker(markerPath, plan);
    }

    const createdFiles = await materializeTemplate(workspace, template);
    const validation = await runBootstrapValidation(workspace, plan, this.runCommand);

    if (validation.createdLockFile) {
      createdFiles.push(validation.createdLockFile);
      createdFiles.sort();
    }

    await completeBootstrapMarker(markerPath, plan);

    return {
      ...resultBase(plan),
      status: "created",
      reason: `Created, installed and locally validated template v${webAppTemplateVersion}.`,
      createdFiles,
      commands: validation.commands,
    };
  }
}

export class NoopWorkspaceBootstrapper implements WorkspaceBootstrapper {
  bootstrap(workspace: string, plan: ChangePlan): Promise<WorkspaceBootstrap> {
    return Promise.resolve(skippedBootstrap(plan, `Bootstrap disabled for ${workspace}.`));
  }
}

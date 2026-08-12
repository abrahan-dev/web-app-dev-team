import { readFile, readdir, rename } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { z } from "zod";
import type { WorkspaceFacts } from "../../application/ports/development-services.ts";
import { checkArchitecture } from "../quality/architecture-guard.ts";

const workspaceFactsSchema = z.object({
  workspace: z.string(),
  workspaceKind: z.enum(["new", "existing"]),
  packageManager: z.enum(["bun", "npm", "pnpm", "yarn", "unknown"]),
  scripts: z.record(z.string(), z.string()),
  sourceRoots: z.array(z.string()),
  testRoots: z.array(z.string()),
  topLevelDirectories: z.array(z.string()),
  configFiles: z.array(z.string()),
  migrationFiles: z.array(z.string()).default([]),
  architectureBaseline: z.array(z.string()),
  coverageThresholds: z
    .object({
      functions: z.number(),
      lines: z.number(),
      statements: z.number(),
    })
    .nullable()
    .optional(),
});

async function coverageThresholds(
  workspace: string,
): Promise<WorkspaceFacts["coverageThresholds"]> {
  try {
    const config = Bun.TOML.parse(await readFile(resolve(workspace, "bunfig.toml"), "utf8")) as {
      test?: { coverageThreshold?: unknown };
    };
    const value = config.test?.coverageThreshold;

    if (typeof value === "number") {
      return { functions: value, lines: value, statements: value };
    }

    if (!value || typeof value !== "object") {
      return null;
    }

    const values = value as Record<string, unknown>;

    return typeof values.functions === "number" &&
      typeof values.lines === "number" &&
      typeof values.statements === "number"
      ? {
          functions: values.functions,
          lines: values.lines,
          statements: values.statements,
        }
      : null;
  } catch {
    return null;
  }
}

async function packageScripts(workspace: string): Promise<Record<string, string>> {
  try {
    const parsed = JSON.parse(await readFile(resolve(workspace, "package.json"), "utf8")) as {
      scripts?: unknown;
    };

    return z.record(z.string(), z.string()).catch({}).parse(parsed.scripts);
  } catch {
    return {};
  }
}

async function migrationFiles(workspace: string): Promise<string[]> {
  const root = resolve(workspace, "drizzle");

  try {
    return (await readdir(root, { recursive: true }))
      .filter((path) => /(?:\.sql|meta\/[^/]+\.json)$/u.test(path))
      .map((path) => relative(workspace, resolve(root, path)))
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

export async function inspectWorkspace(workspace: string): Promise<WorkspaceFacts> {
  const directoryEntries = await readdir(workspace, { withFileTypes: true });
  const entries = directoryEntries.map(({ name }) => name).sort();
  const internalEntries = new Set([".DS_Store", ".git", ".web-app-dev-team", "node_modules"]);
  const projectEntries = entries.filter((name) => !internalEntries.has(name));
  const topLevelDirectories = directoryEntries
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => name)
    .sort();
  const has = (name: string): boolean => entries.includes(name);
  const packageManager =
    has("bun.lock") || has("bun.lockb")
      ? "bun"
      : has("pnpm-lock.yaml")
        ? "pnpm"
        : has("yarn.lock")
          ? "yarn"
          : has("package-lock.json")
            ? "npm"
            : "unknown";
  const sourceRoots = ["src", "apps", "packages"].filter((name) =>
    topLevelDirectories.includes(name),
  );
  const testRoots = ["tests", "test", "e2e"].filter((name) => topLevelDirectories.includes(name));
  const configFiles = entries.filter((entry) =>
    /^(?:tsconfig.*\.json|eslint\.config\.|\.eslintrc|vite\.config\.|playwright\.config\.|cucumber\.)/.test(
      entry,
    ),
  );

  return workspaceFactsSchema.parse({
    workspace,
    workspaceKind: projectEntries.length === 0 ? "new" : "existing",
    packageManager,
    scripts: await packageScripts(workspace),
    sourceRoots,
    testRoots,
    topLevelDirectories,
    configFiles,
    migrationFiles: await migrationFiles(workspace),
    architectureBaseline: await checkArchitecture(workspace),
    coverageThresholds: await coverageThresholds(workspace),
  });
}

export async function loadWorkspaceFacts(
  workspace: string,
  runDirectory: string,
): Promise<WorkspaceFacts> {
  const path = resolve(runDirectory, "workspace-facts.json");

  try {
    return workspaceFactsSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    const facts = await inspectWorkspace(workspace);
    const temporary = `${path}.tmp`;
    await Bun.write(temporary, `${JSON.stringify(facts, null, 2)}\n`);
    await rename(temporary, path);

    return facts;
  }
}

export async function refreshWorkspaceFacts(
  workspace: string,
  runDirectory: string,
): Promise<WorkspaceFacts> {
  const path = resolve(runDirectory, "workspace-facts.json");
  const facts = await inspectWorkspace(workspace);
  const temporary = `${path}.tmp`;
  await Bun.write(temporary, `${JSON.stringify(facts, null, 2)}\n`);
  await rename(temporary, path);

  return facts;
}

export function describeWorkspaceFacts(facts: WorkspaceFacts): string {
  const scripts = Object.keys(facts.scripts).sort().join(", ") || "none";

  return [
    `Workspace kind: ${facts.workspaceKind}`,
    `Package manager: ${facts.packageManager}`,
    `Source roots: ${facts.sourceRoots.join(", ") || "none detected"}`,
    `Test roots: ${facts.testRoots.join(", ") || "none detected"}`,
    `Available scripts: ${scripts}`,
    `Config files: ${facts.configFiles.join(", ") || "none detected"}`,
    `Migration files: ${facts.migrationFiles.join(", ") || "none detected"}`,
    `Top-level directories: ${facts.topLevelDirectories.join(", ") || "none"}`,
    `Pre-existing architecture violations: ${facts.architectureBaseline.length}`,
    `Coverage thresholds: ${facts.coverageThresholds ? `${facts.coverageThresholds.functions}/${facts.coverageThresholds.lines}/${facts.coverageThresholds.statements}` : "none"}`,
  ].join("\n");
}

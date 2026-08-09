import { readFile, readdir, rename } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import type { WorkspaceFacts } from "../../application/ports/development-services.ts";
import { checkArchitecture } from "../quality/architecture-guard.ts";

const workspaceFactsSchema = z.object({
  workspace: z.string(),
  packageManager: z.enum(["bun", "npm", "pnpm", "yarn", "unknown"]),
  scripts: z.record(z.string(), z.string()),
  sourceRoots: z.array(z.string()),
  testRoots: z.array(z.string()),
  topLevelDirectories: z.array(z.string()),
  configFiles: z.array(z.string()),
  architectureBaseline: z.array(z.string()),
});

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

export async function inspectWorkspace(workspace: string): Promise<WorkspaceFacts> {
  const directoryEntries = await readdir(workspace, { withFileTypes: true });
  const entries = directoryEntries.map(({ name }) => name).sort();
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
    packageManager,
    scripts: await packageScripts(workspace),
    sourceRoots,
    testRoots,
    topLevelDirectories,
    configFiles,
    architectureBaseline: await checkArchitecture(workspace),
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
    `Package manager: ${facts.packageManager}`,
    `Source roots: ${facts.sourceRoots.join(", ") || "none detected"}`,
    `Test roots: ${facts.testRoots.join(", ") || "none detected"}`,
    `Available scripts: ${scripts}`,
    `Config files: ${facts.configFiles.join(", ") || "none detected"}`,
    `Top-level directories: ${facts.topLevelDirectories.join(", ") || "none"}`,
    `Pre-existing architecture violations: ${facts.architectureBaseline.length}`,
  ].join("\n");
}

import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { circularDependencies } from "./architecture/dependency-graph.ts";
import {
  importRuleViolations,
  importedSpecifiers,
  layer,
  mirroredSourcePath,
  sourceRuleViolations,
} from "./architecture/rules.ts";

const sourcePatterns = [
  "src/**/*.{ts,tsx,js,jsx,mjs,cjs}",
  "apps/*/src/**/*.{ts,tsx,js,jsx,mjs,cjs}",
  "packages/*/src/**/*.{ts,tsx,js,jsx,mjs,cjs}",
];
const testPatterns = [
  "test/**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}",
  "tests/**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}",
  "apps/*/test/**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}",
  "apps/*/tests/**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}",
  "packages/*/test/**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}",
  "packages/*/tests/**/*.{test,spec}.{ts,tsx,js,jsx,mjs,cjs}",
];

async function scan(workspace: string, patterns: string[], absolute: boolean): Promise<string[]> {
  const matches = await Promise.all(
    patterns.map((pattern) =>
      Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: workspace, absolute, onlyFiles: true })),
    ),
  );

  return [...new Set(matches.flat())];
}

function resolveLocalImport(from: string, specifier: string, files: Set<string>): string | null {
  if (!specifier.startsWith(".")) {
    return null;
  }

  const base = resolve(from, "..", specifier);
  const candidates = [
    base,
    ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].map((extension) => `${base}${extension}`),
    ...[".ts", ".tsx", ".js", ".jsx"].map((extension) => resolve(base, `index${extension}`)),
  ];

  return candidates.find((candidate) => files.has(candidate)) ?? null;
}

async function analyzeSourceFile(
  workspace: string,
  file: string,
  files: Set<string>,
): Promise<{ dependencies: string[]; violations: string[] }> {
  const source = await readFile(file, "utf8");
  const sourcePath = relative(workspace, file);
  const sourceLayer = layer(sourcePath);
  const dependencies: string[] = [];
  const violations = sourceRuleViolations(sourcePath, source, sourceLayer);

  for (const specifier of importedSpecifiers(source)) {
    const target = resolveLocalImport(file, specifier, files);

    if (target) {
      dependencies.push(target);
    }

    const targetLayer = target ? layer(relative(workspace, target)) : layer(specifier);
    violations.push(...importRuleViolations(sourcePath, sourceLayer, targetLayer, specifier));
  }

  return { dependencies, violations };
}

function cycleViolations(workspace: string, graph: Map<string, string[]>): string[] {
  return circularDependencies(graph).map(
    (cycle) =>
      `Circular dependency: ${cycle.map((file) => relative(workspace, file)).join(" -> ")}.`,
  );
}

async function testMirrorViolations(
  workspace: string,
  sourceFiles: Set<string>,
): Promise<string[]> {
  const testFiles = await scan(workspace, testPatterns, false);
  const violations: string[] = [];

  for (const testFile of testFiles) {
    const sourcePath = mirroredSourcePath(testFile);

    if (sourcePath && !sourceFiles.has(resolve(workspace, sourcePath))) {
      violations.push(`${testFile}: does not mirror an existing production path (${sourcePath}).`);
    }
  }

  return violations;
}

export async function checkArchitecture(workspace: string): Promise<string[]> {
  const sourceFileList = await scan(workspace, sourcePatterns, true);
  const sourceFiles = new Set(sourceFileList);
  const graph = new Map<string, string[]>();
  const violations: string[] = [];

  for (const file of sourceFileList) {
    const analysis = await analyzeSourceFile(workspace, file, sourceFiles);
    graph.set(file, analysis.dependencies);
    violations.push(...analysis.violations);
  }

  violations.push(...cycleViolations(workspace, graph));
  violations.push(...(await testMirrorViolations(workspace, sourceFiles)));

  return Array.from(new Set(violations)).sort();
}

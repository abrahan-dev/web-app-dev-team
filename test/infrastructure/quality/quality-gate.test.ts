import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Role } from "../../../src/domain/roles.ts";
import {
  runLocalCommand,
  runQualityGate,
} from "../../../src/infrastructure/quality/quality-gate.ts";
import { inspectWorkspace } from "../../../src/infrastructure/workspace/workspace-inspector.ts";
import { TemporaryWorkspaceManager } from "../../support/temporary-workspaces.ts";

const temporary = new TemporaryWorkspaceManager();

afterEach(async () => {
  await temporary.cleanup();
});

async function workspace(scripts: Record<string, string>): Promise<string> {
  const path = await temporary.create("web-app-dev-team-quality-gate-");
  await writeFile(resolve(path, "bun.lock"), "");
  await writeFile(resolve(path, "package.json"), JSON.stringify({ scripts }));

  return path;
}

describe("local quality gate commands", () => {
  test("checks cyclomatic complexity only in files changed by the coder", async () => {
    const root = await workspace({});
    await mkdir(resolve(root, "src"), { recursive: true });
    const legacy = resolve(root, "src", "legacy.ts");
    const changed = resolve(root, "src", "changed.ts");
    const complex = `export function decide(values: boolean[]): number {
  let result = 0;
  ${Array.from({ length: 11 }, (_, index) => `if (values[${index}]) result += 1;`).join("\n  ")}
  return result;
}\n`;
    await writeFile(legacy, complex);
    await writeFile(changed, "export const changed = true;\n");
    const facts = await inspectWorkspace(root);

    const unrelated = await runQualityGate({
      workspace: root,
      facts,
      changedFiles: ["src/changed.ts"],
      turn: 1,
      sequence: 1,
      role: Role.BackendCoder,
    });
    const legacyChanged = await runQualityGate({
      workspace: root,
      facts,
      changedFiles: [legacy],
      turn: 2,
      sequence: 2,
      role: Role.BackendCoder,
    });

    expect(unrelated.passed).toBe(true);
    expect(legacyChanged.passed).toBe(false);
    expect(legacyChanged.details.some((value) => value.includes("complexity"))).toBe(true);
  });

  test("runs only recognized scripts in deterministic order", async () => {
    const root = await workspace({
      build: "bun -e \"console.log('build should not run')\"",
      "test:e2e": "bun -e \"console.log('e2e ok')\"",
      "test:coverage": "bun -e \"console.log('coverage ok')\"",
      lint: "bun -e \"console.log('lint ok')\"",
      typecheck: "bun -e \"console.log('types ok')\"",
    });

    const result = await runQualityGate({
      workspace: root,
      facts: await inspectWorkspace(root),
      changedFiles: [],
      turn: 1,
      sequence: 1,
      role: Role.BackendCoder,
      runCoverage: true,
    });

    expect(result.passed).toBe(true);
    expect(result.commands.map(({ command }) => command)).toEqual([
      "bun run lint",
      "bun run typecheck",
      "bun run test:e2e",
      "bun run test:coverage",
    ]);
    expect(result.commands.map(({ exitCode }) => exitCode)).toEqual([0, 0, 0, 0]);
    expect(result.commands[0]?.output).toContain("lint ok");
    expect(result.commands[1]?.output).toContain("types ok");
    expect(result.commands[2]?.output).toContain("e2e ok");
    expect(result.commands[3]?.output).toContain("coverage ok");
  });

  test("keeps browser scripts for the final gate only", async () => {
    const root = await workspace({
      test: "bun -e \"console.log('unit ok')\"",
      "test:e2e": "bun -e \"console.log('e2e must not run')\"",
    });

    const result = await runQualityGate({
      workspace: root,
      facts: await inspectWorkspace(root),
      changedFiles: [],
      turn: 1,
      sequence: 1,
      role: Role.BackendCoder,
      runBrowserTests: false,
    });

    expect(result.commands.map(({ command }) => command)).toEqual(["bun run test"]);
  });

  test("runs coverage alone and fails when its script is missing", async () => {
    const coveredRoot = await workspace({
      test: "bun -e \"console.log('test must not run')\"",
      "test:coverage": "bun -e \"console.log('coverage only')\"",
    });
    const covered = await runQualityGate({
      workspace: coveredRoot,
      facts: await inspectWorkspace(coveredRoot),
      changedFiles: [],
      turn: 1,
      sequence: 1,
      role: Role.FrontendCoder,
      runScripts: false,
      runCoverage: true,
    });
    const missingRoot = await workspace({ test: "bun test" });
    const missing = await runQualityGate({
      workspace: missingRoot,
      facts: await inspectWorkspace(missingRoot),
      changedFiles: [],
      turn: 1,
      sequence: 1,
      role: Role.Qa,
      runScripts: false,
      runCoverage: true,
    });

    expect(covered.commands.map(({ command }) => command)).toEqual(["bun run test:coverage"]);
    expect(covered.passed).toBe(true);
    expect(missing.passed).toBe(false);
    expect(missing.details).toContain(
      "Coverage is required, but package.json has no test:coverage script.",
    );
  });

  test("does not run unit tests twice when coverage is required", async () => {
    const root = await workspace({
      test: "bun -e \"console.log('duplicate unit run')\"",
      "test:coverage": "bun -e \"console.log('coverage includes unit tests')\"",
    });
    const result = await runQualityGate({
      workspace: root,
      facts: await inspectWorkspace(root),
      changedFiles: [],
      turn: 1,
      sequence: 1,
      role: Role.FrontendCoder,
      runCoverage: true,
    });

    expect(result.commands.map(({ command }) => command)).toEqual(["bun run test:coverage"]);
  });

  test("fails when Bun reports coverage below the configured limit", async () => {
    const root = await workspace({ "test:coverage": "bun test --coverage" });
    await mkdir(resolve(root, "src"), { recursive: true });
    await mkdir(resolve(root, "test"), { recursive: true });
    await writeFile(
      resolve(root, "bunfig.toml"),
      "[test]\ncoverageSkipTestFiles = true\ncoverageThreshold = 1\n",
    );
    await writeFile(
      resolve(root, "src", "classify.ts"),
      'export const classify = (value: boolean): string => value ? "yes" : "no";\nexport const untested = (): string => "untested";\n',
    );
    await writeFile(
      resolve(root, "test", "classify.test.ts"),
      'import { expect, test } from "bun:test";\nimport { classify } from "../src/classify.ts";\ntest("classifies true", () => expect(classify(true)).toBe("yes"));\n',
    );

    const result = await runQualityGate({
      workspace: root,
      facts: await inspectWorkspace(root),
      changedFiles: ["src/classify.ts"],
      turn: 1,
      sequence: 1,
      role: Role.BackendCoder,
      runScripts: false,
      runCoverage: true,
    });

    expect(result.passed).toBe(false);
    expect(result.commands).toMatchObject([{ command: "bun run test:coverage", exitCode: 1 }]);
    expect(result.details[0]).toContain("bun run test:coverage exited 1");
  });

  test("records a failing script and its diagnostic output", async () => {
    const root = await workspace({
      test: "bun -e \"console.error('deliberate failure'); process.exit(3)\"",
    });

    const result = await runQualityGate({
      workspace: root,
      facts: await inspectWorkspace(root),
      changedFiles: [],
      turn: 1,
      sequence: 1,
      role: Role.BackendCoder,
    });

    expect(result.passed).toBe(false);
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]?.exitCode).toBe(3);
    expect(result.details[0]).toContain("bun run test exited 3");
    expect(result.details[0]).toContain("deliberate failure");
  });

  test("turns an unavailable executable into a reportable command failure", async () => {
    const root = await workspace({});

    const result = await runLocalCommand(["web-app-dev-team-command-that-does-not-exist"], root);

    expect(result.exitCode).toBe(127);
    expect(result.output.length).toBeGreaterThan(0);
  });
});

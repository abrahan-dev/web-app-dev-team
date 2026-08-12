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
  test("records command duration and output size", async () => {
    const root = await workspace({});
    const result = await runLocalCommand(["bun", "-e", 'console.log("timed")'], root);

    expect(result.exitCode).toBe(0);
    expect(result.startedAt).toBeString();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.outputBytes).toBeGreaterThan(0);
  });

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
      "openapi:generate": "bun -e \"console.log('openapi ok')\"",
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
      "bun run openapi:generate",
      "bun run lint",
      "bun run typecheck",
      "bun run test:e2e",
      "bun run test:coverage",
    ]);
    expect(result.commands.map(({ exitCode }) => exitCode)).toEqual([0, 0, 0, 0, 0]);
    expect(result.commands[0]?.output).toContain("openapi ok");
    expect(result.commands[1]?.output).toContain("lint ok");
    expect(result.commands[2]?.output).toContain("types ok");
    expect(result.commands[3]?.output).toContain("e2e ok");
    expect(result.commands[4]?.output).toContain("coverage ok");
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

  test("merges project and role coverage patterns for coder-owned tests", async () => {
    const root = await workspace({ "test:coverage": "bun test --coverage" });
    const dataTest = "test/contexts/accounts/infrastructure/persistence/database.test.ts";
    const frontendTest = "test/apps/operations/frontend/app.test.tsx";
    await writeFile(
      resolve(root, "bunfig.toml"),
      '[test]\ncoveragePathIgnorePatterns = [\n  "src/contexts/accounts/infrastructure/persistence/schema.ts",\n]\ncoverageThreshold = 1\n',
    );
    await mkdir(resolve(root, dataTest, ".."), { recursive: true });
    await mkdir(resolve(root, frontendTest, ".."), { recursive: true });
    await mkdir(resolve(root, "src/contexts/accounts/infrastructure/persistence"), {
      recursive: true,
    });
    await mkdir(resolve(root, "src/contexts/accounts/domain"), { recursive: true });
    await writeFile(
      resolve(root, "src/contexts/accounts/infrastructure/persistence/database.ts"),
      'export const covered = (): string => "covered";\n',
    );
    await writeFile(
      resolve(root, "src/contexts/accounts/infrastructure/persistence/schema.ts"),
      'export const ignoredSchema = (): string => "schema";\n',
    );
    await writeFile(
      resolve(root, "src/contexts/accounts/domain/uncovered.ts"),
      'export const otherRoleCode = (): string => "domain";\n',
    );
    await writeFile(
      resolve(root, dataTest),
      'import { expect, test } from "bun:test";\nimport { covered } from "../../../../../src/contexts/accounts/infrastructure/persistence/database.ts";\nimport { ignoredSchema } from "../../../../../src/contexts/accounts/infrastructure/persistence/schema.ts";\nimport { otherRoleCode } from "../../../../../src/contexts/accounts/domain/uncovered.ts";\nvoid ignoredSchema;\nvoid otherRoleCode;\ntest("covers persistence", () => expect(covered()).toBe("covered"));\n',
    );
    await writeFile(
      resolve(root, frontendTest),
      'import { expect, test } from "bun:test";\ntest("passes", () => expect(true).toBe(true));\n',
    );

    const data = await runQualityGate({
      workspace: root,
      facts: await inspectWorkspace(root),
      changedFiles: [],
      turn: 1,
      sequence: 1,
      role: Role.DataEngineer,
      runScripts: false,
      runCoverage: true,
    });
    const qa = await runQualityGate({
      workspace: root,
      facts: await inspectWorkspace(root),
      changedFiles: [],
      turn: 2,
      sequence: 2,
      role: Role.Qa,
      runScripts: false,
      runCoverage: true,
    });

    expect(data.commands[0]?.command).toContain("bun --config=");
    expect(data.commands[0]?.command).toEndWith(` test --coverage ${dataTest}`);
    expect(data.details).toEqual([]);
    expect(qa.commands[0]?.command).toBe("bun run test:coverage");
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
    expect(result.details.some((detail) => detail.includes("bun run test:coverage exited 1"))).toBe(
      true,
    );
    expect(result.findings).toContainEqual({
      code: "coverage-below-threshold",
      owner: Role.BackendCoder,
      file: "src/classify.ts",
      metric: "functions",
      actual: 50,
      required: 100,
      message: "src/classify.ts has 50% functions coverage. The required value is 100%.",
    });
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

  test("rejects package ranges in a generated workspace", async () => {
    const root = await workspace({});
    await writeFile(
      resolve(root, "package.json"),
      JSON.stringify({ dependencies: { zod: "^4.4.3" } }),
    );

    const result = await runQualityGate({
      workspace: root,
      facts: await inspectWorkspace(root),
      changedFiles: [],
      turn: 1,
      sequence: 1,
      role: Role.BackendCoder,
      requireExactDependencies: true,
    });

    expect(result.details).toContain(
      "package.json must pin zod to one exact semantic version; received ^4.4.3.",
    );
  });

  test("detects runtime files missing from a coverage report", async () => {
    const root = await workspace({
      "test:coverage":
        "bun -e 'console.log(\"src/contexts/orders/domain/covered.ts | 100 | 100 | 100\")'",
    });
    const directory = resolve(root, "src/contexts/orders/domain");
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, "covered.ts"), "export const covered = () => true;\n");
    await writeFile(resolve(directory, "missing.ts"), "export const missing = () => true;\n");

    const result = await runQualityGate({
      workspace: root,
      facts: await inspectWorkspace(root),
      changedFiles: [],
      turn: 1,
      sequence: 1,
      role: Role.BackendCoder,
      runScripts: false,
      runCoverage: true,
    });

    expect(result.details).toContain(
      "src/contexts/orders/domain/missing.ts contains runtime code but does not appear in the coverage report.",
    );
  });

  test("requires a browser-only reason for coverage ignores", async () => {
    const root = await workspace({});
    const path = resolve(root, "src/apps/example/frontend/focus.ts");
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, "/* istanbul ignore next */\nexport const focus = () => true;\n");

    const result = await runQualityGate({
      workspace: root,
      facts: await inspectWorkspace(root),
      changedFiles: [path],
      turn: 1,
      sequence: 1,
      role: Role.FrontendCoder,
    });

    expect(result.details).toContain(
      "src/apps/example/frontend/focus.ts:1 coverage ignore needs a browser-only justification.",
    );
  });

  test("rejects a coverage threshold reduction", async () => {
    const root = await workspace({});
    await writeFile(
      resolve(root, "bunfig.toml"),
      "[test]\ncoverageThreshold = { lines = 0.9, functions = 0.9, statements = 0.9 }\n",
    );
    const facts = await inspectWorkspace(root);
    await writeFile(
      resolve(root, "bunfig.toml"),
      "[test]\ncoverageThreshold = { lines = 0.8, functions = 0.8, statements = 0.8 }\n",
    );

    const result = await runQualityGate({
      workspace: root,
      facts,
      changedFiles: ["bunfig.toml"],
      turn: 1,
      sequence: 1,
      role: Role.BackendCoder,
    });

    expect(result.passed).toBe(false);
    expect(
      result.findings?.filter(({ code }) => code === "coverage-threshold-reduced"),
    ).toHaveLength(3);
    expect(result.details).toContain(
      "bunfig.toml reduced the functions coverage threshold from 90% to 80%.",
    );
  });
});

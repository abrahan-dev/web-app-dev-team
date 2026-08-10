import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import type { LocalCheck, LocalCommandResult } from "../../domain/schemas.ts";
import type {
  QualityGateOptions,
  WorkspaceFacts,
} from "../../application/ports/development-services.ts";
import { checkArchitecture } from "./architecture-guard.ts";

function maxComplexity(): number {
  const raw = process.env.WEB_APP_DEV_TEAM_MAX_COMPLEXITY ?? "10";
  const value = Number(raw);

  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`WEB_APP_DEV_TEAM_MAX_COMPLEXITY must be positive; got ${raw}.`);
  }

  return value;
}

function commandFor(manager: WorkspaceFacts["packageManager"], script: string): string[] {
  if (manager === "npm") {
    return ["npm", "run", script];
  }

  if (manager === "pnpm") {
    return ["pnpm", "run", script];
  }

  if (manager === "yarn") {
    return ["yarn", script];
  }

  return ["bun", "run", script];
}

export async function runLocalCommand(
  command: string[],
  workspace: string,
): Promise<LocalCommandResult> {
  try {
    const child = Bun.spawn(command, {
      cwd: workspace,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const output = `${stdout}${stderr}`.trim();

    return {
      command: command.join(" "),
      exitCode,
      output: output.length <= 4_000 ? output : `${output.slice(-4_000)}\n…output truncated`,
    };
  } catch (error) {
    return {
      command: command.join(" "),
      exitCode: 127,
      output: error instanceof Error ? error.message : String(error),
    };
  }
}

async function complexityViolations(workspace: string, changedFiles: string[]): Promise<string[]> {
  const candidates = [
    ...new Set(
      changedFiles
        .map((file) => (isAbsolute(file) ? file : resolve(workspace, file)))
        .filter((file) => {
          const path = relative(workspace, file);

          return (
            !path.startsWith("..") && /(?:^|\/)src\//.test(path) && /\.(?:[cm]?[jt]sx?)$/.test(path)
          );
        }),
    ),
  ];
  const existence = await Promise.all(candidates.map((file) => Bun.file(file).exists()));
  const files = candidates.filter((_, index) => existence[index]);
  const linter = new Linter({ configType: "flat" });
  const threshold = maxComplexity();
  const violations: string[] = [];

  for (const file of files) {
    const messages = linter.verify(
      await readFile(file, "utf8"),
      [
        {
          files: ["**/*.{ts,tsx,js,jsx,mjs,cjs}"],
          languageOptions: {
            parser: tseslint.parser,
            parserOptions: { ecmaVersion: "latest", sourceType: "module" },
          },
          rules: { complexity: ["error", { max: threshold }] },
        },
      ],
      { filename: relative(workspace, file) },
    );

    for (const message of messages.filter(
      ({ ruleId, fatal }) => ruleId === "complexity" || fatal,
    )) {
      violations.push(
        `${file.slice(workspace.length + 1)}:${message.line}:${message.column} ${message.message}`,
      );
    }
  }

  return violations;
}

export async function runQualityGate(options: QualityGateOptions): Promise<LocalCheck> {
  const preferredScripts = [
    "format:check",
    "lint",
    "typecheck",
    "test",
    "test:integration",
    "test:e2e",
    "test:playwright",
  ];
  let selectedScripts =
    options.runScripts === false
      ? []
      : preferredScripts.filter((script) => Object.hasOwn(options.facts.scripts, script));
  const browserScripts = new Set(["test:e2e", "test:playwright"]);

  if (options.runBrowserTests === false) {
    selectedScripts = selectedScripts.filter((script) => !browserScripts.has(script));
  }

  const coverageScriptExists = Object.hasOwn(options.facts.scripts, "test:coverage");

  if (options.runCoverage && coverageScriptExists) {
    selectedScripts = selectedScripts.filter((script) => script !== "test");
    selectedScripts.push("test:coverage");
  }

  const commands: LocalCommandResult[] = [];

  for (const script of selectedScripts) {
    commands.push(
      await runLocalCommand(commandFor(options.facts.packageManager, script), options.workspace),
    );
  }

  const currentArchitecture =
    process.env.WEB_APP_DEV_TEAM_ARCHITECTURE_GUARD === "off"
      ? []
      : await checkArchitecture(options.workspace);
  const baseline = new Set(options.facts.architectureBaseline);
  const details = [
    ...(options.runCoverage && !coverageScriptExists
      ? ["Coverage is required, but package.json has no test:coverage script."]
      : []),
    ...currentArchitecture.filter((violation) => !baseline.has(violation)),
    ...(await complexityViolations(options.workspace, options.changedFiles)),
    ...commands
      .filter(({ exitCode }) => exitCode !== 0)
      .map(
        ({ command, exitCode, output }) =>
          `${command} exited ${exitCode}${output ? `:\n${output}` : "."}`,
      ),
  ];

  return {
    sequence: options.sequence,
    turn: options.turn,
    role: options.role,
    kind: "quality-gate",
    createdAt: new Date().toISOString(),
    passed: details.length === 0,
    summary:
      details.length === 0
        ? `Quality gate passed (${commands.length} commands, complexity <= ${maxComplexity()}).`
        : `Quality gate failed with ${details.length} issue(s).`,
    details,
    commands,
  };
}

import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import type { LocalCheck, LocalCommandResult } from "../../domain/schemas.ts";
import { Role } from "../../domain/roles.ts";
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

function roleOwnsPath(role: Role, path: string): boolean {
  if (role === Role.DataEngineer) {
    return /(?:^|\/)contexts\/[^/]+\/infrastructure\/persistence(?:\/|\.|$)/.test(path);
  }

  if (role === Role.FrontendCoder) {
    return /(?:^|\/)apps\/[^/]+\/frontend(?:\/|\.|$)/.test(path);
  }

  if (role === Role.BackendCoder) {
    return (
      /(?:^|\/)apps\/[^/]+\/backend(?:\/|\.|$)/.test(path) ||
      /(?:^|\/)contexts\/[^/]+\/(?:application|domain)(?:\/|\.|$)/.test(path) ||
      /(?:^|\/)contexts\/[^/]+\/infrastructure\/(?!persistence(?:\/|\.|$))/.test(path)
    );
  }

  return false;
}

async function roleCoverageTests(workspace: string, role: Role): Promise<string[]> {
  if (![Role.DataEngineer, Role.BackendCoder, Role.FrontendCoder].includes(role)) {
    return [];
  }

  try {
    const entries = await readdir(resolve(workspace, "test"), { recursive: true });

    return entries
      .filter((path) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) && roleOwnsPath(role, path))
      .map((path) => `test/${path}`)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function sourceFiles(workspace: string): Promise<string[]> {
  try {
    return (await readdir(resolve(workspace, "src"), { recursive: true }))
      .filter((path) => /\.[cm]?[jt]sx?$/.test(path))
      .map((path) => `src/${path}`)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

export async function roleOwnedSourceFiles(workspace: string, role: Role): Promise<string[]> {
  return (await sourceFiles(workspace)).filter((path) => roleOwnsPath(role, path));
}

async function roleCoverageIgnorePatterns(workspace: string, role: Role): Promise<string[]> {
  return (await sourceFiles(workspace)).filter((path) => !roleOwnsPath(role, path));
}

interface ScriptExecution {
  command: string[];
  cleanup: () => Promise<void>;
}

function configuredCoveragePatterns(source: string): string[] | null {
  try {
    const config = Bun.TOML.parse(source) as {
      test?: { coveragePathIgnorePatterns?: unknown };
    };
    const value = config.test?.coveragePathIgnorePatterns;

    if (value === undefined) {
      return [];
    }

    if (typeof value === "string") {
      return [value];
    }

    return Array.isArray(value) && value.every((pattern) => typeof pattern === "string")
      ? value
      : null;
  } catch {
    return null;
  }
}

interface TomlQuoteState {
  quote: string;
  escaped: boolean;
}

function consumeQuotedCharacter(state: TomlQuoteState, character: string): boolean {
  if (!state.quote) {
    return false;
  }

  if (state.quote === '"' && character === "\\" && !state.escaped) {
    state.escaped = true;
  } else if (character === state.quote && !state.escaped) {
    state.quote = "";
  } else {
    state.escaped = false;
  }

  return true;
}

function arrayValueEnd(source: string, start: number): number | null {
  const state: TomlQuoteState = { quote: "", escaped: false };

  for (let index = source.indexOf("[", start); index >= 0 && index < source.length; index += 1) {
    const character = source[index] ?? "";

    if (consumeQuotedCharacter(state, character)) {
      continue;
    }

    if (character === '"' || character === "'") {
      state.quote = character;
    } else if (character === "#") {
      index = source.indexOf("\n", index);

      if (index === -1) {
        return null;
      }
    } else if (character === "]") {
      return index + 1;
    }
  }

  return null;
}

function coverageValueEnd(source: string, start: number): number | null {
  if (source[start] === "[") {
    return arrayValueEnd(source, start);
  }

  const newline = source.indexOf("\n", start);

  return newline === -1 ? source.length : newline;
}

function scopedCoverageConfig(source: string, rolePatterns: string[]): string | null {
  const configured = configuredCoveragePatterns(source);
  const header = /^\[test\][ \t]*(?:#.*)?$/m.exec(source);

  if (!configured || !header) {
    return null;
  }

  const patterns = [...new Set([...configured, ...rolePatterns])];
  const setting = `coveragePathIgnorePatterns = ${JSON.stringify(patterns)}`;
  const sectionStart = header.index + header[0].length;
  const remaining = source.slice(sectionStart);
  const nextHeader = /^\[[^\]]+\][ \t]*(?:#.*)?$/m.exec(remaining);
  const sectionEnd = nextHeader ? sectionStart + nextHeader.index : source.length;
  const section = source.slice(sectionStart, sectionEnd);
  const assignment = /^coveragePathIgnorePatterns[ \t]*=[ \t]*/m.exec(section);

  if (!assignment) {
    return `${source.slice(0, sectionStart)}\n${setting}${source.slice(sectionStart)}`;
  }

  const assignmentStart = sectionStart + assignment.index;
  const valueEnd = coverageValueEnd(source, assignmentStart + assignment[0].length);

  return valueEnd === null
    ? null
    : `${source.slice(0, assignmentStart)}${setting}${source.slice(valueEnd)}`;
}

async function scopedCoverageExecution(
  options: QualityGateOptions,
  tests: string[],
): Promise<ScriptExecution | null> {
  if (
    options.facts.packageManager !== "bun" ||
    options.facts.scripts["test:coverage"] !== "bun test --coverage" ||
    tests.length === 0
  ) {
    return null;
  }

  const patterns = await roleCoverageIgnorePatterns(options.workspace, options.role);

  if (patterns.length === 0) {
    return null;
  }

  try {
    const source = await readFile(resolve(options.workspace, "bunfig.toml"), "utf8");
    const scoped = scopedCoverageConfig(source, patterns);

    if (!scoped) {
      return null;
    }

    const directory = await mkdtemp(join(tmpdir(), "web-app-dev-team-coverage-"));
    const config = resolve(directory, "bunfig.toml");
    await writeFile(config, scoped, "utf8");

    return {
      command: ["bun", `--config=${config}`, "test", "--coverage", ...tests],
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

async function scriptCommand(
  options: QualityGateOptions,
  script: string,
): Promise<ScriptExecution> {
  const command = commandFor(options.facts.packageManager, script);
  const noCleanup = (): Promise<void> => Promise.resolve();

  if (script !== "test:coverage" || options.facts.packageManager !== "bun") {
    return { command, cleanup: noCleanup };
  }

  const tests = await roleCoverageTests(options.workspace, options.role);

  return (
    (await scopedCoverageExecution(options, tests)) ?? {
      command: [...command, ...tests],
      cleanup: noCleanup,
    }
  );
}

export async function runLocalCommand(
  command: string[],
  workspace: string,
): Promise<LocalCommandResult> {
  const startedAt = new Date().toISOString();
  const started = performance.now();

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
      startedAt,
      durationMs: Math.round(performance.now() - started),
      outputBytes: new TextEncoder().encode(output).byteLength,
    };
  } catch (error) {
    const output = error instanceof Error ? error.message : String(error);

    return {
      command: command.join(" "),
      exitCode: 127,
      output,
      startedAt,
      durationMs: Math.round(performance.now() - started),
      outputBytes: new TextEncoder().encode(output).byteLength,
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
    const execution = await scriptCommand(options, script);

    try {
      commands.push(await runLocalCommand(execution.command, options.workspace));
    } finally {
      await execution.cleanup();
    }
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

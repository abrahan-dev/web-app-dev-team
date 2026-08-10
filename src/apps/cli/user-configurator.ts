import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { GitHubMcpPullRequestPublisher } from "../../infrastructure/git/github-mcp-publisher.ts";
import { parseMcpArguments } from "../../infrastructure/git/config.ts";
import { parseEnvironmentFile } from "./configuration-loader.ts";
import { installLinuxGithubMcp } from "./github-mcp-installer.ts";

const releasesUrl = "https://github.com/github/github-mcp-server/releases";

export interface ConfigureDependencies {
  architecture?: string;
  environment?: NodeJS.ProcessEnv;
  home?: string;
  installLinux?: (architecture: string, home: string) => Promise<string>;
  log?: (message: string) => void;
  platform?: string;
  prompt?: (question: string) => Promise<string>;
  promptSecret?: (question: string) => Promise<string>;
  run?: (command: string[]) => number;
  verify?: (command: string) => Promise<void>;
  which?: (command: string) => string | null;
}

interface NormalizedDependencies {
  architecture: string;
  environment: NodeJS.ProcessEnv;
  home: string;
  installLinux: (architecture: string, home: string) => Promise<string>;
  log: (message: string) => void;
  platform: string;
  prompt: (question: string) => Promise<string>;
  promptSecret: (question: string) => Promise<string>;
  run: (command: string[]) => number;
  verify: (command: string) => Promise<void>;
  which: (command: string) => string | null;
}

interface ConfigurationSetting {
  defaultValue: string;
  description: string;
  label: string;
  name: string;
  validate: (value: string) => void;
}

function validatePositiveInteger(name: string, value: string): void {
  const number = Number(value);

  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

const configurationSettings: ConfigurationSetting[] = [
  {
    defaultValue: "gpt-5.6-luna",
    description: "The model runs each specialized Codex role.",
    label: "Codex model",
    name: "WEB_APP_DEV_TEAM_MODEL",
    validate: (value) => {
      if (!/^[A-Za-z0-9._-]+$/u.test(value)) {
        throw new Error("WEB_APP_DEV_TEAM_MODEL has invalid characters.");
      }
    },
  },
  {
    defaultValue: "12",
    description: "The turn limit stops a run after this number of agent turns.",
    label: "Maximum turns",
    name: "WEB_APP_DEV_TEAM_MAX_TURNS",
    validate: (value) => validatePositiveInteger("WEB_APP_DEV_TEAM_MAX_TURNS", value),
  },
  {
    defaultValue: "10",
    description: "The complexity limit applies to each changed function.",
    label: "Maximum cyclomatic complexity",
    name: "WEB_APP_DEV_TEAM_MAX_COMPLEXITY",
    validate: (value) => validatePositiveInteger("WEB_APP_DEV_TEAM_MAX_COMPLEXITY", value),
  },
  {
    defaultValue: "on",
    description: "The architecture guard checks layer boundaries and dependency rules.",
    label: "Architecture guard (on/off)",
    name: "WEB_APP_DEV_TEAM_ARCHITECTURE_GUARD",
    validate: (value) => {
      if (value !== "on" && value !== "off") {
        throw new Error("WEB_APP_DEV_TEAM_ARCHITECTURE_GUARD must be on or off.");
      }
    },
  },
];

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return "";
    }

    throw error;
  }
}

function setEnvironmentValue(content: string, name: string, value: string): string {
  const lines = content ? content.replace(/\n$/u, "").split(/\r?\n/u) : [];
  const pattern = new RegExp(`^(?:export\\s+)?${name}=`, "u");
  const index = lines.findIndex((line) => pattern.test(line.trim()));
  const assignment = `${name}=${value}`;

  if (index === -1) {
    lines.push(assignment);
  } else {
    lines[index] = assignment;
  }

  return `${lines.join("\n")}\n`;
}

async function writeSecureConfiguration(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await writeFile(temporaryPath, content, { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, path);
}

function isYes(answer: string): boolean {
  return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
}

async function terminalPrompt(question: string): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });

  try {
    return await terminal.question(question);
  } finally {
    terminal.close();
  }
}

async function terminalSecret(question: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("configure requires an interactive terminal.");
  }

  process.stdout.write(question);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return await new Promise<string>((resolveSecret, reject) => {
    let secret = "";

    const finish = (error?: Error): void => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(wasRaw);
      process.stdout.write("\n");

      if (error) {
        reject(error);
      } else {
        resolveSecret(secret);
      }
    };

    const onData = (data: Buffer): void => {
      for (const byte of data) {
        if (byte === 3) {
          finish(new Error("Configuration cancelled."));

          return;
        }

        if (byte === 10 || byte === 13) {
          finish();

          return;
        }

        if (byte === 8 || byte === 127) {
          secret = secret.slice(0, -1);
        } else if (byte >= 32 && byte <= 126) {
          secret += String.fromCharCode(byte);
        }
      }
    };

    process.stdin.on("data", onData);
  });
}

function validateToken(token: string): string {
  const value = token.trim();

  if (!value || !/^[A-Za-z0-9_]+$/u.test(value)) {
    throw new Error("The GitHub token has invalid characters.");
  }

  return value;
}

async function configureToken(
  content: string,
  prompt: (question: string) => Promise<string>,
  promptSecret: (question: string) => Promise<string>,
): Promise<{ content: string; token: string }> {
  const current = parseEnvironmentFile(content).GITHUB_PERSONAL_ACCESS_TOKEN;

  if (current && !isYes(await prompt("A GitHub token exists. Replace it? [y/N] "))) {
    return { content, token: current };
  }

  const token = validateToken(await promptSecret("GitHub personal access token: "));

  return {
    content: setEnvironmentValue(content, "GITHUB_PERSONAL_ACCESS_TOKEN", token),
    token,
  };
}

async function configureRuntimeSettings(
  content: string,
  environment: NodeJS.ProcessEnv,
  prompt: (question: string) => Promise<string>,
  log: (message: string) => void,
): Promise<string> {
  const current = parseEnvironmentFile(content);
  let updated = content;

  for (const setting of configurationSettings) {
    const defaultValue = current[setting.name] ?? environment[setting.name] ?? setting.defaultValue;
    log(setting.description);
    const answer = (await prompt(`${setting.label} [${defaultValue}]: `)).trim();
    const value = answer || defaultValue;
    setting.validate(value);
    updated = setEnvironmentValue(updated, setting.name, value);
    environment[setting.name] = value;
  }

  return updated;
}

async function installMissingServer(
  dependencies: Required<
    Pick<
      ConfigureDependencies,
      "architecture" | "home" | "installLinux" | "platform" | "prompt" | "run" | "which"
    >
  >,
): Promise<string | null> {
  if (!isYes(await dependencies.prompt("Install the GitHub MCP server now? [y/N] "))) {
    return null;
  }

  if (dependencies.platform === "darwin") {
    if (!dependencies.which("brew")) {
      throw new Error(`Homebrew is required for automatic installation. See ${releasesUrl}.`);
    }

    if (dependencies.run(["brew", "install", "github-mcp-server"]) !== 0) {
      throw new Error("Homebrew could not install the GitHub MCP server.");
    }

    return dependencies.which("github-mcp-server") ?? "github-mcp-server";
  }

  if (dependencies.platform === "linux") {
    return await dependencies.installLinux(dependencies.architecture, dependencies.home);
  }

  throw new Error(`Automatic GitHub MCP installation does not support ${dependencies.platform}.`);
}

function defaultRun(command: string[]): number {
  return Bun.spawnSync(command, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).exitCode;
}

async function defaultVerify(command: string): Promise<void> {
  const publisher = new GitHubMcpPullRequestPublisher({
    command,
    arguments_: parseMcpArguments(
      process.env.WEB_APP_DEV_TEAM_GITHUB_MCP_ARGS ?? '["stdio","--tools=create_pull_request"]',
    ),
  });
  await publisher.verify();
}

function normalizeRuntime(
  options: ConfigureDependencies,
): Pick<
  NormalizedDependencies,
  "architecture" | "environment" | "home" | "platform" | "run" | "which"
> {
  return {
    architecture: options.architecture ?? process.arch,
    environment: options.environment ?? process.env,
    home: options.home ?? homedir(),
    platform: options.platform ?? process.platform,
    run: options.run ?? defaultRun,
    which: options.which ?? ((command: string) => Bun.which(command)),
  };
}

function normalizeInteraction(
  options: ConfigureDependencies,
): Pick<NormalizedDependencies, "installLinux" | "log" | "prompt" | "promptSecret" | "verify"> {
  return {
    installLinux:
      options.installLinux ??
      ((architecture: string, selectedHome: string) =>
        installLinuxGithubMcp({ architecture, home: selectedHome })),
    log: options.log ?? console.log,
    prompt: options.prompt ?? terminalPrompt,
    promptSecret: options.promptSecret ?? terminalSecret,
    verify: options.verify ?? defaultVerify,
  };
}

export async function configureUser(options: ConfigureDependencies = {}): Promise<void> {
  const dependencies: NormalizedDependencies = {
    ...normalizeRuntime(options),
    ...normalizeInteraction(options),
  };
  const configPath = resolve(dependencies.home, ".config/web-app-dev-team/config.env");
  const configured = await configureToken(
    await readOptional(configPath),
    dependencies.prompt,
    dependencies.promptSecret,
  );
  configured.content = await configureRuntimeSettings(
    configured.content,
    dependencies.environment,
    dependencies.prompt,
    dependencies.log,
  );
  await writeSecureConfiguration(configPath, configured.content);
  dependencies.environment.GITHUB_PERSONAL_ACCESS_TOKEN = configured.token;
  let command = dependencies.environment.WEB_APP_DEV_TEAM_GITHUB_MCP_COMMAND ?? "github-mcp-server";

  if (!dependencies.which(command)) {
    const installedCommand = await installMissingServer({
      architecture: dependencies.architecture,
      home: dependencies.home,
      installLinux: dependencies.installLinux,
      platform: dependencies.platform,
      prompt: dependencies.prompt,
      run: dependencies.run,
      which: dependencies.which,
    });

    if (!installedCommand) {
      dependencies.log(
        `GitHub MCP server was not installed. Install it before you use the app: ${releasesUrl}.`,
      );
      dependencies.log(`Configuration saved in ${configPath}.`);

      return;
    }

    command = installedCommand;
    dependencies.environment.WEB_APP_DEV_TEAM_GITHUB_MCP_COMMAND = installedCommand;
    configured.content = setEnvironmentValue(
      configured.content,
      "WEB_APP_DEV_TEAM_GITHUB_MCP_COMMAND",
      installedCommand,
    );
    await writeSecureConfiguration(configPath, configured.content);
  }

  await dependencies.verify(command);
  dependencies.log(`Configuration saved in ${configPath}.`);
  dependencies.log("GitHub MCP server validation passed.");
}

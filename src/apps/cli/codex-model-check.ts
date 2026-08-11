interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CodexCatalogRunner = (command: string[]) => CommandResult;

export interface CodexModelCheck {
  compatible: boolean;
  detail: string;
}

export interface NamedCodexModelCheck extends CodexModelCheck {
  name: string;
}

interface ConfiguredCodexModel {
  model?: string;
  name: string;
}

const runCatalogCommand: CodexCatalogRunner = (command) => {
  const result = Bun.spawnSync(command, { stderr: "pipe", stdout: "pipe" });

  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};

function configuredCodexModels(environment: NodeJS.ProcessEnv): ConfiguredCodexModel[] {
  return [
    {
      model: environment.WEB_APP_DEV_TEAM_MODEL,
      name: "Codex execution model",
    },
    {
      model: environment.WEB_APP_DEV_TEAM_PLANNER_MODEL ?? environment.WEB_APP_DEV_TEAM_MODEL,
      name: "Codex planner model",
    },
  ];
}

function modelCheck(model: string | undefined, supportedModels: Set<string>): CodexModelCheck {
  if (!model) {
    return {
      compatible: true,
      detail: "Codex will select its recommended model.",
    };
  }

  return supportedModels.has(model)
    ? { compatible: true, detail: `${model} is supported.` }
    : {
        compatible: false,
        detail: `${model} requires a newer Codex CLI. Run: npm install --global @openai/codex@latest`,
      };
}

export function checkCodexModels(
  models: ConfiguredCodexModel[],
  runner: CodexCatalogRunner = runCatalogCommand,
): NamedCodexModelCheck[] {
  if (models.every(({ model }) => !model)) {
    return models.map(({ model, name }) => ({ name, ...modelCheck(model, new Set()) }));
  }

  const result = runner(["codex", "debug", "models", "--bundled"]);

  if (result.exitCode !== 0) {
    const check: CodexModelCheck = {
      compatible: false,
      detail: result.stderr.trim() || "Codex could not inspect its bundled model catalog.",
    };

    return models.map(({ name }) => ({ name, ...check }));
  }

  try {
    const catalog = JSON.parse(result.stdout) as { models?: Array<{ slug?: unknown }> };
    const supportedModels = new Set(
      catalog.models
        ?.map(({ slug }) => slug)
        .filter((slug): slug is string => typeof slug === "string") ?? [],
    );

    return models.map(({ model, name }) => ({ name, ...modelCheck(model, supportedModels) }));
  } catch {
    const check: CodexModelCheck = {
      compatible: false,
      detail: "Codex returned an invalid bundled model catalog.",
    };

    return models.map(({ name }) => ({ name, ...check }));
  }
}

export function checkCodexModel(
  model = process.env.WEB_APP_DEV_TEAM_MODEL,
  runner: CodexCatalogRunner = runCatalogCommand,
): CodexModelCheck {
  const check = checkCodexModels([{ model, name: "Codex model" }], runner)[0];

  return check
    ? { compatible: check.compatible, detail: check.detail }
    : { compatible: false, detail: "Codex model validation did not return a result." };
}

export function checkConfiguredCodexModels(
  environment: NodeJS.ProcessEnv = process.env,
  runner: CodexCatalogRunner = runCatalogCommand,
): NamedCodexModelCheck[] {
  return checkCodexModels(configuredCodexModels(environment), runner);
}

export function assertCodexModelSupported(): void {
  const result = checkConfiguredCodexModels().find(({ compatible }) => !compatible);

  if (result) {
    throw new Error(result.detail);
  }
}

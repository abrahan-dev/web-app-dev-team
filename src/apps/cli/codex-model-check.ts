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

const runCatalogCommand: CodexCatalogRunner = (command) => {
  const result = Bun.spawnSync(command, { stderr: "pipe", stdout: "pipe" });

  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};

export function checkCodexModel(
  model = process.env.WEB_APP_DEV_TEAM_MODEL,
  runner: CodexCatalogRunner = runCatalogCommand,
): CodexModelCheck {
  if (!model) {
    return {
      compatible: true,
      detail: "Codex will select its recommended model.",
    };
  }

  const result = runner(["codex", "debug", "models", "--bundled"]);

  if (result.exitCode !== 0) {
    return {
      compatible: false,
      detail: result.stderr.trim() || "Codex could not inspect its bundled model catalog.",
    };
  }

  try {
    const catalog = JSON.parse(result.stdout) as { models?: Array<{ slug?: unknown }> };
    const supported = catalog.models?.some(({ slug }) => slug === model) ?? false;

    return supported
      ? { compatible: true, detail: `${model} is supported.` }
      : {
          compatible: false,
          detail: `${model} requires a newer Codex CLI. Run: npm install --global @openai/codex@latest`,
        };
  } catch {
    return {
      compatible: false,
      detail: "Codex returned an invalid bundled model catalog.",
    };
  }
}

export function assertCodexModelSupported(): void {
  const result = checkCodexModel();

  if (!result.compatible) {
    throw new Error(result.detail);
  }
}

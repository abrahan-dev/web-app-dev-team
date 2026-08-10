import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

function parseValue(raw: string): string {
  const value = raw.trim();

  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

export function parseEnvironmentFile(content: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim().replace(/^export\s+/u, "");

    if (!line || line.startsWith("#")) {
      continue;
    }

    const separator = line.indexOf("=");

    if (separator < 1) {
      continue;
    }

    const name = line.slice(0, separator).trim();

    if (/^[A-Z_][A-Z0-9_]*$/u.test(name)) {
      values[name] = parseValue(line.slice(separator + 1));
    }
  }

  return values;
}

async function readEnvironmentFile(path: string): Promise<Record<string, string>> {
  try {
    return parseEnvironmentFile(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

export async function loadConfiguration(options: {
  workspace: string;
  environment?: NodeJS.ProcessEnv;
  userHome?: string;
}): Promise<void> {
  const environment = options.environment ?? process.env;
  const protectedNames = new Set(Object.keys(environment));
  const userValues = await readEnvironmentFile(
    resolve(options.userHome ?? homedir(), ".config/web-app-dev-team/config.env"),
  );
  const workspaceValues = await readEnvironmentFile(
    resolve(options.workspace, ".web-app-dev-team/config.env"),
  );

  for (const [name, value] of Object.entries({ ...userValues, ...workspaceValues })) {
    if (!protectedNames.has(name)) {
      environment[name] = value;
    }
  }
}

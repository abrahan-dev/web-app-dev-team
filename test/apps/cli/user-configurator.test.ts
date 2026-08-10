import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { configureUser } from "../../../src/apps/cli/user-configurator.ts";
import { TemporaryWorkspaceManager } from "../../support/temporary-workspaces.ts";

const temporary = new TemporaryWorkspaceManager();

afterEach(async () => {
  await temporary.cleanup();
});

describe("user configurator", () => {
  test("creates secure configuration and installs the Linux binary", async () => {
    const home = await temporary.create("configure-linux-");
    const environment: NodeJS.ProcessEnv = {};
    const messages: string[] = [];
    let verifiedCommand = "";
    let secretQuestion = "";

    await configureUser({
      architecture: "x64",
      environment,
      home,
      installLinux: async () => join(home, ".local/bin/github-mcp-server"),
      log: (message) => messages.push(message),
      platform: "linux",
      prompt: async (question) => (question.startsWith("Install") ? "yes" : ""),
      promptSecret: async (question) => {
        secretQuestion = question;

        return "github_pat_test";
      },
      verify: async (command) => {
        verifiedCommand = command;
      },
      which: () => null,
    });

    const directory = join(home, ".config/web-app-dev-team");
    const path = join(directory, "config.env");
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).toContain("GITHUB_PERSONAL_ACCESS_TOKEN=github_pat_test");
    expect(await readFile(path, "utf8")).toContain("WEB_APP_DEV_TEAM_MODEL=gpt-5.6-luna");
    expect(await readFile(path, "utf8")).toContain("WEB_APP_DEV_TEAM_MODEL_REASONING_EFFORT=high");
    expect(await readFile(path, "utf8")).toContain("WEB_APP_DEV_TEAM_MAX_TURNS=12");
    expect(await readFile(path, "utf8")).toContain("WEB_APP_DEV_TEAM_MAX_COMPLEXITY=10");
    expect(await readFile(path, "utf8")).toContain("WEB_APP_DEV_TEAM_ARCHITECTURE_GUARD=on");
    expect(await readFile(path, "utf8")).toContain(
      `WEB_APP_DEV_TEAM_GITHUB_MCP_COMMAND=${verifiedCommand}`,
    );
    expect(environment.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("github_pat_test");
    expect(secretQuestion).toContain("fine-grained");
    expect(secretQuestion).toContain("Pull requests: Read and write");
    expect(secretQuestion).toContain("input is hidden");
    expect(messages.at(-1)).toBe("GitHub MCP server validation passed.");
  });

  test("keeps an existing token when replacement is declined", async () => {
    const home = await temporary.create("configure-existing-");
    const directory = join(home, ".config/web-app-dev-team");
    const path = join(directory, "config.env");
    await mkdir(directory, { recursive: true });
    await writeFile(path, "# Keep this line\nGITHUB_PERSONAL_ACCESS_TOKEN=github_pat_existing\n");
    await chmod(path, 0o644);

    await configureUser({
      environment: {},
      home,
      prompt: async (question) => (question.startsWith("A GitHub token") ? "no" : ""),
      promptSecret: async () => {
        throw new Error("The secret prompt must not run.");
      },
      verify: async () => {},
      which: () => "/usr/local/bin/github-mcp-server",
    });

    expect(await readFile(path, "utf8")).toContain("github_pat_existing");
    expect(await readFile(path, "utf8")).toContain("# Keep this line");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("uses Homebrew on macOS after confirmation", async () => {
    const home = await temporary.create("configure-macos-");
    const commands: string[][] = [];
    let installed = false;

    await configureUser({
      environment: {},
      home,
      platform: "darwin",
      prompt: async (question) => (question.startsWith("Install") ? "yes" : ""),
      promptSecret: async () => "github_pat_test",
      run: (command) => {
        commands.push(command);
        installed = true;

        return 0;
      },
      verify: async () => {},
      which: (command) => {
        if (command === "brew") {
          return "/opt/homebrew/bin/brew";
        }

        return installed ? "/opt/homebrew/bin/github-mcp-server" : null;
      },
    });

    expect(commands).toEqual([["brew", "install", "github-mcp-server"]]);
  });

  test("does not install the server without confirmation", async () => {
    const home = await temporary.create("configure-decline-");
    const messages: string[] = [];
    let verified = false;
    const installationAnswers = ["maybe", ""];

    await configureUser({
      environment: {},
      home,
      log: (message) => messages.push(message),
      platform: "linux",
      prompt: async (question) =>
        question.startsWith("Install") ? (installationAnswers.shift() ?? "") : "",
      promptSecret: async () => "github_pat_test",
      verify: async () => {
        verified = true;
      },
      which: () => null,
    });

    expect(verified).toBe(false);
    expect(installationAnswers).toHaveLength(0);
    expect(messages.join("\n")).toContain("Enter y or n. Try again.");
    expect(messages.join("\n")).toContain("Install it before you use the app");
  });

  test("saves custom runtime settings", async () => {
    const home = await temporary.create("configure-settings-");
    const answers: Record<string, string> = {
      "Architecture guard": "off",
      "Codex model": "gpt-custom",
      "Maximum cyclomatic complexity": "8",
      "Maximum turns": "20",
      "Model reasoning effort": "xhigh",
    };

    await configureUser({
      environment: {},
      home,
      log: () => {},
      prompt: async (question) => {
        const entry = Object.entries(answers).find(([label]) => question.startsWith(label));

        return entry?.[1] ?? "";
      },
      promptSecret: async () => "github_pat_test",
      verify: async () => {},
      which: () => "/usr/local/bin/github-mcp-server",
    });

    const content = await readFile(join(home, ".config/web-app-dev-team/config.env"), "utf8");
    expect(content).toContain("WEB_APP_DEV_TEAM_MODEL=gpt-custom");
    expect(content).toContain("WEB_APP_DEV_TEAM_MODEL_REASONING_EFFORT=xhigh");
    expect(content).toContain("WEB_APP_DEV_TEAM_MAX_TURNS=20");
    expect(content).toContain("WEB_APP_DEV_TEAM_MAX_COMPLEXITY=8");
    expect(content).toContain("WEB_APP_DEV_TEAM_ARCHITECTURE_GUARD=off");
  });

  test("requests the token again after invalid input", async () => {
    const home = await temporary.create("configure-token-retry-");
    const messages: string[] = [];
    const tokens = ["", "github_pat_valid"];

    await configureUser({
      environment: {},
      home,
      log: (message) => messages.push(message),
      prompt: async () => "",
      promptSecret: async () => tokens.shift() ?? "github_pat_valid",
      verify: async () => {},
      which: () => "/usr/local/bin/github-mcp-server",
    });

    const content = await readFile(join(home, ".config/web-app-dev-team/config.env"), "utf8");
    expect(content).toContain("GITHUB_PERSONAL_ACCESS_TOKEN=github_pat_valid");
    expect(messages.join("\n")).toContain("Try again");
    expect(tokens).toHaveLength(0);
  });

  test("requests runtime settings again after invalid input", async () => {
    const home = await temporary.create("configure-setting-retry-");
    const messages: string[] = [];
    const answers: Record<string, string[]> = {
      "Architecture guard": ["maybe", "off"],
      "Codex model": ["invalid model", "gpt-valid"],
      "Maximum cyclomatic complexity": ["0", "8"],
      "Maximum turns": ["none", "20"],
      "Model reasoning effort": ["extreme", "high"],
    };

    await configureUser({
      environment: {},
      home,
      log: (message) => messages.push(message),
      prompt: async (question) => {
        const entry = Object.entries(answers).find(([label]) => question.startsWith(label));

        return entry?.[1].shift() ?? "";
      },
      promptSecret: async () => "github_pat_test",
      verify: async () => {},
      which: () => "/usr/local/bin/github-mcp-server",
    });

    const content = await readFile(join(home, ".config/web-app-dev-team/config.env"), "utf8");
    expect(content).toContain("WEB_APP_DEV_TEAM_MODEL=gpt-valid");
    expect(content).toContain("WEB_APP_DEV_TEAM_MODEL_REASONING_EFFORT=high");
    expect(content).toContain("WEB_APP_DEV_TEAM_MAX_TURNS=20");
    expect(content).toContain("WEB_APP_DEV_TEAM_MAX_COMPLEXITY=8");
    expect(content).toContain("WEB_APP_DEV_TEAM_ARCHITECTURE_GUARD=off");
    expect(messages.filter((message) => message.endsWith("Try again.")).length).toBe(5);
  });
});

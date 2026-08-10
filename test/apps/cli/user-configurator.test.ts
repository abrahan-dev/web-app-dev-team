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

    await configureUser({
      architecture: "x64",
      environment,
      home,
      installLinux: async () => join(home, ".local/bin/github-mcp-server"),
      log: (message) => messages.push(message),
      platform: "linux",
      prompt: async () => "yes",
      promptSecret: async () => "github_pat_test",
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
    expect(await readFile(path, "utf8")).toContain(
      `WEB_APP_DEV_TEAM_GITHUB_MCP_COMMAND=${verifiedCommand}`,
    );
    expect(environment.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("github_pat_test");
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
      prompt: async () => "no",
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
      prompt: async () => "yes",
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

    expect(
      configureUser({
        environment: {},
        home,
        platform: "linux",
        prompt: async () => "no",
        promptSecret: async () => "github_pat_test",
        verify: async () => {},
        which: () => null,
      }),
    ).rejects.toThrow("GitHub MCP server is required");
  });
});

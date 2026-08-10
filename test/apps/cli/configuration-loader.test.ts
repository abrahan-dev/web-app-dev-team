import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  loadConfiguration,
  parseEnvironmentFile,
} from "../../../src/apps/cli/configuration-loader.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("configuration loader", () => {
  test("parses supported environment entries", () => {
    expect(
      parseEnvironmentFile(`
# Comment
WEB_APP_DEV_TEAM_MODEL=gpt-test
export WEB_APP_DEV_TEAM_GIT_WORKFLOW="off"
invalid-name=value
`),
    ).toEqual({
      WEB_APP_DEV_TEAM_GIT_WORKFLOW: "off",
      WEB_APP_DEV_TEAM_MODEL: "gpt-test",
    });
  });

  test("uses environment, workspace, and user precedence", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "web-app-dev-team-config-"));
    const home = resolve(root, "home");
    const workspace = resolve(root, "workspace");
    const userConfig = resolve(home, ".config/web-app-dev-team");
    const workspaceConfig = resolve(workspace, ".web-app-dev-team");
    temporaryDirectories.push(root);
    await mkdir(userConfig, { recursive: true });
    await mkdir(workspaceConfig, { recursive: true });
    await writeFile(
      resolve(userConfig, "config.env"),
      "WEB_APP_DEV_TEAM_MODEL=user\nWEB_APP_DEV_TEAM_GIT_WORKFLOW=on\n",
    );
    await writeFile(
      resolve(workspaceConfig, "config.env"),
      "WEB_APP_DEV_TEAM_MODEL=workspace\nWEB_APP_DEV_TEAM_MAX_TURNS=20\n",
    );
    const environment: NodeJS.ProcessEnv = { WEB_APP_DEV_TEAM_GIT_WORKFLOW: "off" };

    await loadConfiguration({ workspace, environment, userHome: home });

    expect(environment).toEqual({
      WEB_APP_DEV_TEAM_GIT_WORKFLOW: "off",
      WEB_APP_DEV_TEAM_MAX_TURNS: "20",
      WEB_APP_DEV_TEAM_MODEL: "workspace",
    });
  });
});

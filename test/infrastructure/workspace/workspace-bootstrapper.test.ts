import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { ChangePlan } from "../../../src/domain/schemas.ts";
import { DeterministicWorkspaceBootstrapper } from "../../../src/infrastructure/workspace/workspace-bootstrapper.ts";
import { TemporaryWorkspaceManager } from "../../support/temporary-workspaces.ts";

const temporary = new TemporaryWorkspaceManager();

afterEach(async () => {
  await temporary.cleanup();
});

async function workspace(): Promise<string> {
  return temporary.create("workspace-bootstrapper-");
}

const plan: ChangePlan = {
  applicationName: "purchase-orders",
  contexts: ["purchasing", "identity"],
  dataRequired: true,
  backendRequired: true,
  frontendRequired: true,
};

function bootstrapper(): DeterministicWorkspaceBootstrapper {
  return new DeterministicWorkspaceBootstrapper(async (command, root) => {
    if (command.join(" ") === "bun install") {
      await Bun.write(resolve(root, "bun.lock"), "lockfileVersion = 1\n");
    }

    return {
      command: command.join(" "),
      exitCode: 0,
      output: "passed",
    };
  });
}

describe("deterministic workspace bootstrapper", () => {
  test("creates the fixed full-stack topology in a metadata-only workspace", async () => {
    const root = await workspace();
    await mkdir(resolve(root, "specifications"), { recursive: true });
    await mkdir(resolve(root, ".web-app-dev-team"), { recursive: true });
    await Bun.write(resolve(root, "specifications", "manifest.json"), "{}\n");
    await Bun.write(resolve(root, ".web-app-dev-team", "marker"), "");

    const result = await bootstrapper().bootstrap(root, plan);

    expect(result).toMatchObject({
      status: "created",
      template: "web-app",
      templateVersion: 1,
      applicationName: "purchase-orders",
      contexts: ["purchasing", "identity"],
      surfaces: ["backend", "frontend"],
      persistence: true,
    });
    expect(result.commands.map(({ command }) => command)).toEqual([
      "bun install",
      "bunx playwright install chromium",
      "bun run format",
      "bun run format:check",
      "bun run lint",
      "bun run typecheck",
      "bun run test",
    ]);
    expect(result.createdFiles).toContain("src/contexts/purchasing/domain/.gitkeep");
    expect(result.createdFiles).toContain(".github/workflows/ci.yml");
    expect(result.createdFiles).toContain("bunfig.toml");
    expect(result.createdFiles).toContain("src/apps/purchase-orders/backend/server.ts");
    expect(result.createdFiles).toContain("src/apps/purchase-orders/frontend/main.tsx");
    expect(result.createdFiles).toContain("test/apps/purchase-orders/backend/server.test.ts");
    expect(result.createdFiles).toContain("bun.lock");
    expect(JSON.parse(await readFile(resolve(root, "package.json"), "utf8"))).toMatchObject({
      dependencies: {
        "@trpc/openapi": "11.18.0-alpha",
        "@trpc/server": "11.18.0",
        "drizzle-orm": "0.45.2",
        react: "19.2.8",
      },
      packageManager: "bun@1.3.10",
    });
    const workflow = await readFile(resolve(root, ".github", "workflows", "ci.yml"), "utf8");
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("bun install --frozen-lockfile");
    expect(workflow).toContain("bun run format:check");
    expect(workflow).toContain("bun run lint");
    expect(workflow).toContain("bun run typecheck");
    expect(workflow).toContain("bun run test");
    expect(workflow).toContain("bun run test:coverage");
    expect(workflow).toContain("bunx playwright install --with-deps chromium");
    expect(workflow).toContain("bun run test:e2e");
  });

  test("is idempotent and never overwrites its first result", async () => {
    const root = await workspace();
    const localBootstrapper = bootstrapper();
    await localBootstrapper.bootstrap(root, plan);
    const original = await readFile(resolve(root, "package.json"), "utf8");

    const repeated = await localBootstrapper.bootstrap(root, plan);

    expect(repeated.status).toBe("skipped");
    expect(repeated.createdFiles).toEqual([]);
    expect(repeated.commands).toEqual([]);
    expect(await readFile(resolve(root, "package.json"), "utf8")).toBe(original);
  });

  test("refuses to bootstrap a workspace with existing project content", async () => {
    const root = await workspace();
    await Bun.write(resolve(root, "README.md"), "# Existing project\n");

    const result = await bootstrapper().bootstrap(root, plan);

    expect(result.status).toBe("skipped");
    expect(result.reason).toContain("README.md");
    expect(await readdir(root)).toEqual(["README.md"]);
  });

  test("can resume validation after a local command interruption", async () => {
    const root = await workspace();
    let shouldFail = true;
    const interruptedBootstrapper = new DeterministicWorkspaceBootstrapper(
      async (command, workspace) => {
        if (command.join(" ") === "bun install") {
          await Bun.write(resolve(workspace, "bun.lock"), "lockfileVersion = 1\n");
        }

        return {
          command: command.join(" "),
          exitCode: shouldFail && command.join(" ") === "bun run typecheck" ? 1 : 0,
          output: "local validation",
        };
      },
    );

    expect(interruptedBootstrapper.bootstrap(root, plan)).rejects.toThrow("bun run typecheck");
    shouldFail = false;

    const resumed = await interruptedBootstrapper.bootstrap(root, plan);

    expect(resumed.status).toBe("created");
    expect(resumed.createdFiles).toEqual([]);
    expect(resumed.commands).toHaveLength(7);
  });

  test("omits frontend and persistence scaffolding for a backend-only plan", async () => {
    const root = await workspace();
    const result = await bootstrapper().bootstrap(root, {
      ...plan,
      dataRequired: false,
      frontendRequired: false,
    });

    expect(result.surfaces).toEqual(["backend"]);
    expect(result.createdFiles.some((path) => path.includes("/frontend/"))).toBe(false);
    expect(result.createdFiles).not.toContain("drizzle.config.ts");
    expect(
      result.commands
        .map(({ command }) => command)
        .some((command) => command.includes("playwright")),
    ).toBe(false);
    expect(await readFile(resolve(root, ".github", "workflows", "ci.yml"), "utf8")).not.toContain(
      "playwright",
    );
  });
});

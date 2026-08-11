import { describe, expect, test } from "bun:test";
import {
  checkConfiguredCodexModels,
  checkCodexModel,
  type CodexCatalogRunner,
} from "../../../src/apps/cli/codex-model-check.ts";

function catalogRunner(models: string[]): CodexCatalogRunner {
  return () => ({
    exitCode: 0,
    stdout: JSON.stringify({ models: models.map((slug) => ({ slug })) }),
    stderr: "",
  });
}

describe("Codex model compatibility", () => {
  test("accepts a model in the bundled CLI catalog", () => {
    expect(checkCodexModel("gpt-supported", catalogRunner(["gpt-supported"]))).toEqual({
      compatible: true,
      detail: "gpt-supported is supported.",
    });
  });

  test("requests a CLI upgrade for an unavailable model", () => {
    const result = checkCodexModel("gpt-new", catalogRunner(["gpt-old"]));

    expect(result.compatible).toBeFalse();
    expect(result.detail).toContain("npm install --global @openai/codex@latest");
  });

  test("rejects a failed or invalid catalog response", () => {
    expect(
      checkCodexModel("gpt-new", () => ({ exitCode: 1, stdout: "", stderr: "failed" })),
    ).toEqual({ compatible: false, detail: "failed" });
    expect(
      checkCodexModel("gpt-new", () => ({ exitCode: 0, stdout: "invalid", stderr: "" })),
    ).toEqual({ compatible: false, detail: "Codex returned an invalid bundled model catalog." });
  });

  test("checks execution and planner models with one catalog read", () => {
    let calls = 0;

    const runner: CodexCatalogRunner = (command) => {
      calls += 1;
      expect(command).toEqual(["codex", "debug", "models", "--bundled"]);

      return catalogRunner(["execution-model", "planner-model"])(command);
    };

    expect(
      checkConfiguredCodexModels(
        {
          WEB_APP_DEV_TEAM_MODEL: "execution-model",
          WEB_APP_DEV_TEAM_PLANNER_MODEL: "planner-model",
        },
        runner,
      ),
    ).toEqual([
      {
        compatible: true,
        detail: "execution-model is supported.",
        name: "Codex execution model",
      },
      {
        compatible: true,
        detail: "planner-model is supported.",
        name: "Codex planner model",
      },
    ]);
    expect(calls).toBe(1);
  });

  test("uses the execution model as the planner fallback", () => {
    expect(
      checkConfiguredCodexModels(
        { WEB_APP_DEV_TEAM_MODEL: "execution-model" },
        catalogRunner(["execution-model"]),
      ),
    ).toHaveLength(2);
  });
});
